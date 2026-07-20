import { createConnection, type Socket } from "node:net";

import type {
  AgentLifecycleStatus,
  AgentResource,
  DashboardChange,
  ProviderStatus,
  StatusEvent,
} from "@status-dashboard/model";
import { z } from "zod";

import type {
  ProviderConnection,
  ProviderListener,
  StatusProvider,
} from "./provider.js";
import type { Clock } from "./store.js";

const PROVIDER_ID = "herdr";
const EVENT_LIFETIME_MS = 10 * 60 * 1_000;

const HerdrAgentStatusSchema = z.enum([
  "idle",
  "working",
  "blocked",
  "done",
  "unknown",
]);

const HerdrAgentSchema = z
  .object({
    pane_id: z.string().trim().min(1),
    workspace_id: z.string().trim().min(1),
    name: z.string().trim().min(1).optional(),
    agent: z.string().trim().min(1).optional(),
    title: z.string().trim().min(1).optional(),
    display_agent: z.string().trim().min(1).optional(),
    agent_status: HerdrAgentStatusSchema,
    state_change_seq: z.number().int().nonnegative().default(0),
  })
  .passthrough();

const HerdrSnapshotSchema = z
  .object({
    version: z.string().trim().min(1),
    protocol: z.number().int().nonnegative(),
    agents: z.array(HerdrAgentSchema),
  })
  .passthrough();

const HerdrSnapshotResponseSchema = z.object({
  id: z.string(),
  result: z.object({
    type: z.literal("session_snapshot"),
    snapshot: HerdrSnapshotSchema,
  }),
});

const HerdrErrorResponseSchema = z.object({
  id: z.string(),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

const HerdrSubscriptionAckSchema = z.object({
  id: z.string(),
  result: z.object({
    type: z.literal("subscription_started"),
  }),
});

const HerdrEventSchema = z.object({
  event: z.string().trim().min(1),
  data: z.unknown(),
});

type HerdrAgent = z.infer<typeof HerdrAgentSchema>;
type HerdrSnapshot = z.infer<typeof HerdrSnapshotSchema>;

export interface HerdrStatusProviderOptions {
  socketPath: string;
  clock?: Clock;
  retryDelayMs?: number;
  requestTimeoutMs?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shifted(now: Date, milliseconds: number): string {
  return new Date(now.getTime() + milliseconds).toISOString();
}

function resourceId(paneId: string): string {
  return `${PROVIDER_ID}:${paneId}`;
}

function mapStatus(status: HerdrAgent["agent_status"]): AgentLifecycleStatus {
  switch (status) {
    case "blocked":
      return "waiting";
    case "done":
    case "idle":
      return "completed";
    case "working":
    case "unknown":
      return "running";
  }
}

function agentLabel(agent: HerdrAgent): string {
  return (
    agent.title ??
    agent.name ??
    agent.display_agent ??
    agent.agent ??
    agent.pane_id
  );
}

function mapAgent(
  agent: HerdrAgent,
  previous: AgentResource | undefined,
  now: Date,
): AgentResource {
  const timestamp = now.toISOString();
  const status = mapStatus(agent.agent_status);
  const label = agentLabel(agent);
  const attentionReason =
    status === "waiting"
      ? (agent.title ?? "Herdr agent is blocked")
      : undefined;
  const unchanged =
    previous !== undefined &&
    previous.status === status &&
    previous.label === label &&
    previous.workspaceId === agent.workspace_id &&
    previous.attentionReason === attentionReason;

  const common = {
    kind: "agent" as const,
    id: resourceId(agent.pane_id),
    providerId: PROVIDER_ID,
    workspaceId: agent.workspace_id,
    label,
    status,
    createdAt: previous?.createdAt ?? timestamp,
    updatedAt: unchanged ? previous.updatedAt : timestamp,
    startedAt:
      previous === undefined ||
      (status === "running" &&
        (previous.status === "completed" || previous.status === "failed"))
        ? timestamp
        : (previous.startedAt ?? timestamp),
  };

  if (status === "waiting") {
    return { ...common, attentionReason };
  }
  if (status === "completed") {
    return {
      ...common,
      completedAt:
        unchanged && previous?.completedAt !== undefined
          ? previous.completedAt
          : timestamp,
    };
  }
  return common;
}

function lifecycleEvent(
  agent: HerdrAgent,
  previous: AgentResource,
  resource: AgentResource,
  now: Date,
): StatusEvent | undefined {
  if (previous.status === resource.status) return undefined;

  const details = {
    occurredAt: now.toISOString(),
    expiresAt: shifted(now, EVENT_LIFETIME_MS),
    providerId: PROVIDER_ID,
    resourceId: resource.id,
  };
  const suffix = `${agent.pane_id}:${agent.state_change_seq}`;

  switch (resource.status) {
    case "waiting":
      return {
        id: `${PROVIDER_ID}-event-${suffix}`,
        type: "agent.waiting",
        severity: "warning",
        message: `${resource.label ?? agent.pane_id} is waiting for input`,
        ...details,
      };
    case "completed":
      return {
        id: `${PROVIDER_ID}-event-${suffix}`,
        type: "agent.completed",
        severity: "success",
        message: `${resource.label ?? agent.pane_id} completed`,
        ...details,
      };
    case "running":
      return {
        id: `${PROVIDER_ID}-event-${suffix}`,
        type: "agent.resumed",
        severity: "info",
        message: `${resource.label ?? agent.pane_id} is running`,
        ...details,
      };
    case "failed":
      return undefined;
  }
}

function providerStatus(
  now: Date,
  connectivity: ProviderStatus["connectivity"],
  message: string,
): ProviderStatus {
  return {
    id: PROVIDER_ID,
    connectivity,
    checkedAt: now.toISOString(),
    label: "Herdr",
    message,
  };
}

function parseProtocolLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`Herdr sent invalid JSON: ${errorMessage(error)}`);
  }
}

function protocolError(value: unknown): Error | undefined {
  const parsed = HerdrErrorResponseSchema.safeParse(value);
  return parsed.success
    ? new Error(`${parsed.data.error.code}: ${parsed.data.error.message}`)
    : undefined;
}

async function requestSnapshot(
  socketPath: string,
  timeoutMs: number,
): Promise<HerdrSnapshot> {
  return await new Promise<HerdrSnapshot>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;

    const finish = (
      result:
        | { type: "resolve"; snapshot: HerdrSnapshot }
        | { type: "reject"; error: unknown },
    ) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (result.type === "resolve") resolve(result.snapshot);
      else reject(result.error);
    };

    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () => {
      finish({
        type: "reject",
        error: new Error(`Herdr snapshot timed out after ${timeoutMs}ms`),
      });
    });
    socket.once("connect", () => {
      socket.write(
        `${JSON.stringify({
          id: "status-dashboard:snapshot",
          method: "session.snapshot",
          params: {},
        })}\n`,
      );
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;

      try {
        const value = parseProtocolLine(buffer.slice(0, newline));
        const remoteError = protocolError(value);
        if (remoteError !== undefined) {
          finish({ type: "reject", error: remoteError });
          return;
        }
        const response = HerdrSnapshotResponseSchema.parse(value);
        finish({ type: "resolve", snapshot: response.result.snapshot });
      } catch (error) {
        finish({ type: "reject", error });
      }
    });
    socket.once("error", (error) => {
      finish({ type: "reject", error });
    });
    socket.once("close", () => {
      if (!settled) {
        finish({
          type: "reject",
          error: new Error("Herdr closed the snapshot connection"),
        });
      }
    });
  });
}

function subscriptionRequest(paneIds: readonly string[]): unknown {
  return {
    id: "status-dashboard:events",
    method: "events.subscribe",
    params: {
      subscriptions: [
        { type: "workspace.created" },
        { type: "workspace.updated" },
        { type: "workspace.renamed" },
        { type: "workspace.closed" },
        { type: "pane.created" },
        { type: "pane.closed" },
        { type: "pane.moved" },
        { type: "pane.agent_detected" },
        ...paneIds.map((paneId) => ({
          type: "pane.agent_status_changed",
          pane_id: paneId,
        })),
      ],
    },
  };
}

async function openSubscription(
  socketPath: string,
  paneIds: readonly string[],
  timeoutMs: number,
  onEvent: () => void,
  onFailure: (error: Error) => void,
): Promise<ProviderConnection> {
  return await new Promise<ProviderConnection>((resolve, reject) => {
    const socket: Socket = createConnection(socketPath);
    let buffer = "";
    let acknowledged = false;
    let intentionallyClosed = false;
    let failureReported = false;

    const reportFailure = (error: Error) => {
      if (failureReported || intentionallyClosed) return;
      failureReported = true;
      if (acknowledged) onFailure(error);
      else reject(error);
    };

    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () => {
      reportFailure(
        new Error(`Herdr subscription timed out after ${timeoutMs}ms`),
      );
      socket.destroy();
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(subscriptionRequest(paneIds))}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);

        try {
          const value = parseProtocolLine(line);
          const remoteError = protocolError(value);
          if (remoteError !== undefined) throw remoteError;

          if (!acknowledged) {
            HerdrSubscriptionAckSchema.parse(value);
            acknowledged = true;
            socket.setTimeout(0);
            resolve({
              close() {
                intentionallyClosed = true;
                socket.destroy();
              },
            });
          } else {
            HerdrEventSchema.parse(value);
            onEvent();
          }
        } catch (error) {
          reportFailure(
            error instanceof Error ? error : new Error(errorMessage(error)),
          );
          socket.destroy();
          return;
        }
      }
    });
    socket.once("error", (error) => reportFailure(error));
    socket.once("close", () => {
      reportFailure(new Error("Herdr event subscription closed"));
    });
  });
}

class HerdrConnection implements ProviderConnection {
  readonly #socketPath: string;
  readonly #clock: Clock;
  readonly #retryDelayMs: number;
  readonly #requestTimeoutMs: number;
  readonly #listener: ProviderListener;
  readonly #resources = new Map<string, AgentResource>();
  #subscription: ProviderConnection | undefined;
  #subscriptionKey = "";
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;
  #hasSnapshot = false;
  #busy = false;
  #refreshQueued = false;

  constructor(options: Required<HerdrStatusProviderOptions>, listener: ProviderListener) {
    this.#socketPath = options.socketPath;
    this.#clock = options.clock;
    this.#retryDelayMs = options.retryDelayMs;
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#listener = listener;

    this.#emitConnectivity("connecting", "Connecting to Herdr");
    void this.#bootstrap();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#subscription?.close();
    this.#subscription = undefined;
  }

  async #bootstrap(): Promise<void> {
    if (this.#closed || this.#busy) return;
    this.#busy = true;
    try {
      let snapshot = await requestSnapshot(
        this.#socketPath,
        this.#requestTimeoutMs,
      );
      await this.#replaceSubscription(snapshot);
      snapshot = await requestSnapshot(
        this.#socketPath,
        this.#requestTimeoutMs,
      );
      if (this.#paneKey(snapshot) !== this.#subscriptionKey) {
        await this.#replaceSubscription(snapshot);
        snapshot = await requestSnapshot(
          this.#socketPath,
          this.#requestTimeoutMs,
        );
      }
      if (!this.#closed) this.#applySnapshot(snapshot);
    } catch (error) {
      this.#disconnect(error);
    } finally {
      this.#busy = false;
      if (this.#refreshQueued && !this.#closed) {
        this.#refreshQueued = false;
        void this.#refresh();
      }
    }
  }

  async #refresh(): Promise<void> {
    if (this.#closed) return;
    if (this.#busy) {
      this.#refreshQueued = true;
      return;
    }
    this.#busy = true;
    try {
      let snapshot = await requestSnapshot(
        this.#socketPath,
        this.#requestTimeoutMs,
      );
      if (this.#paneKey(snapshot) !== this.#subscriptionKey) {
        await this.#replaceSubscription(snapshot);
        snapshot = await requestSnapshot(
          this.#socketPath,
          this.#requestTimeoutMs,
        );
      }
      if (!this.#closed) this.#applySnapshot(snapshot);
    } catch (error) {
      this.#disconnect(error);
    } finally {
      this.#busy = false;
      if (this.#refreshQueued && !this.#closed) {
        this.#refreshQueued = false;
        void this.#refresh();
      }
    }
  }

  async #replaceSubscription(snapshot: HerdrSnapshot): Promise<void> {
    const paneIds = snapshot.agents.map(({ pane_id: paneId }) => paneId).sort();
    const next = await openSubscription(
      this.#socketPath,
      paneIds,
      this.#requestTimeoutMs,
      () => {
        void this.#refresh();
      },
      (error) => this.#disconnect(error),
    );
    if (this.#closed) {
      next.close();
      return;
    }
    this.#subscription?.close();
    this.#subscription = next;
    this.#subscriptionKey = paneIds.join("\0");
  }

  #paneKey(snapshot: HerdrSnapshot): string {
    return snapshot.agents
      .map(({ pane_id: paneId }) => paneId)
      .sort()
      .join("\0");
  }

  #applySnapshot(snapshot: HerdrSnapshot): void {
    const now = this.#clock();
    const nextResources = new Map<string, AgentResource>();
    const changes: DashboardChange[] = [
      {
        type: "provider.upsert",
        provider: providerStatus(
          now,
          "connected",
          `Connected to Herdr ${snapshot.version} (protocol ${snapshot.protocol})`,
        ),
      },
    ];

    for (const agent of snapshot.agents) {
      const id = resourceId(agent.pane_id);
      const previous = this.#resources.get(id);
      const resource = mapAgent(agent, previous, now);
      nextResources.set(id, resource);
      if (previous === undefined || JSON.stringify(previous) !== JSON.stringify(resource)) {
        changes.push({ type: "resource.upsert", resource });
      }
      if (previous !== undefined) {
        const event = lifecycleEvent(agent, previous, resource, now);
        if (event !== undefined) changes.push({ type: "event.upsert", event });
      }
    }

    for (const id of this.#resources.keys()) {
      if (!nextResources.has(id)) {
        changes.push({ type: "resource.remove", resourceId: id });
      }
    }

    this.#resources.clear();
    for (const [id, resource] of nextResources) {
      this.#resources.set(id, resource);
    }

    if (!this.#hasSnapshot) {
      this.#hasSnapshot = true;
      this.#listener({
        type: "replace",
        state: {
          providers: [
            providerStatus(
              now,
              "connected",
              `Connected to Herdr ${snapshot.version} (protocol ${snapshot.protocol})`,
            ),
          ],
          resources: [...nextResources.values()],
          events: [],
        },
      });
      return;
    }

    this.#listener({ type: "changes", changes });
  }

  #disconnect(error: unknown): void {
    if (this.#closed) return;
    this.#subscription?.close();
    this.#subscription = undefined;
    this.#subscriptionKey = "";
    this.#emitConnectivity(
      "disconnected",
      `Herdr unavailable: ${errorMessage(error)}`,
    );
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      if (this.#closed) return;
      this.#emitConnectivity("connecting", "Reconnecting to Herdr");
      void this.#bootstrap();
    }, this.#retryDelayMs);
  }

  #emitConnectivity(
    connectivity: ProviderStatus["connectivity"],
    message: string,
  ): void {
    this.#listener({
      type: "changes",
      changes: [
        {
          type: "provider.upsert",
          provider: providerStatus(this.#clock(), connectivity, message),
        },
      ],
    });
  }
}

export class HerdrStatusProvider implements StatusProvider {
  readonly id = PROVIDER_ID;
  readonly #options: Required<HerdrStatusProviderOptions>;

  constructor(options: HerdrStatusProviderOptions) {
    this.#options = {
      socketPath: options.socketPath,
      clock: options.clock ?? (() => new Date()),
      retryDelayMs: options.retryDelayMs ?? 1_000,
      requestTimeoutMs: options.requestTimeoutMs ?? 3_000,
    };
  }

  open(listener: ProviderListener): ProviderConnection {
    return new HerdrConnection(this.#options, listener);
  }
}
