import type {
  AgentLifecycleStatus,
  AgentResource,
  DashboardChange,
  DashboardSnapshot,
  StatusEvent,
  StatusEventSeverity,
} from "@status-dashboard/model";

import type {
  DemoStatusProvider,
  ProviderAdvance,
  ProviderConnection,
  ProviderListener,
} from "./provider.js";
import type { Clock, DashboardState } from "./store.js";

const PROVIDER_ID = "demo";
const LIVE_AGENT_ID = "demo-agent-live";
const EVENT_LIFETIME_MS = 10 * 60 * 1_000;

interface DemoStep {
  status: AgentLifecycleStatus;
  description: string;
  severity: StatusEventSeverity;
  eventType: string;
  eventMessage: string;
  attentionReason?: string;
}

const steps: readonly DemoStep[] = [
  {
    status: "waiting",
    description: "Live agent is waiting for approval",
    severity: "warning",
    eventType: "agent.waiting",
    eventMessage: "Deploy agent needs approval to continue",
    attentionReason: "Waiting for deployment approval",
  },
  {
    status: "running",
    description: "Live agent resumed",
    severity: "info",
    eventType: "agent.resumed",
    eventMessage: "Approval received; deploy agent resumed",
  },
  {
    status: "completed",
    description: "Live agent completed",
    severity: "success",
    eventType: "agent.completed",
    eventMessage: "Deploy agent completed successfully",
  },
  {
    status: "failed",
    description: "Live agent reported a failed run",
    severity: "error",
    eventType: "agent.failed",
    eventMessage: "A new deploy run failed its smoke check",
    attentionReason: "Smoke check failed",
  },
  {
    status: "running",
    description: "Live agent started a retry",
    severity: "info",
    eventType: "agent.started",
    eventMessage: "Deploy agent started a clean retry",
  },
] as const;

function shifted(now: Date, milliseconds: number): string {
  return new Date(now.getTime() + milliseconds).toISOString();
}

export class SimulatedStatusProvider implements DemoStatusProvider {
  readonly id = PROVIDER_ID;
  readonly #clock: Clock;
  #step = 0;
  #eventSequence = 0;

  constructor(clock: Clock = () => new Date()) {
    this.#clock = clock;
  }

  open(listener: ProviderListener): ProviderConnection {
    listener({ type: "replace", state: this.reset(this.#clock()) });
    return { close() {} };
  }

  reset(now: Date): DashboardState {
    this.#step = 0;
    this.#eventSequence = 0;

    return {
      providers: [
        {
          id: this.id,
          connectivity: "connected",
          checkedAt: now.toISOString(),
          label: "Local simulator",
          message: "Ready to supply status updates",
        },
      ],
      resources: [
        {
          kind: "agent",
          id: LIVE_AGENT_ID,
          providerId: this.id,
          workspaceId: "status-dashboard",
          label: "Deploy dashboard",
          status: "running",
          createdAt: shifted(now, -15 * 60 * 1_000),
          startedAt: shifted(now, -14 * 60 * 1_000),
          updatedAt: shifted(now, -2 * 60 * 1_000),
        },
        {
          kind: "agent",
          id: "demo-agent-waiting",
          providerId: this.id,
          workspaceId: "plugin",
          label: "Review plugin permissions",
          status: "waiting",
          createdAt: shifted(now, -25 * 60 * 1_000),
          startedAt: shifted(now, -24 * 60 * 1_000),
          updatedAt: shifted(now, -3 * 60 * 1_000),
          attentionReason: "Permission confirmation required",
        },
        {
          kind: "agent",
          id: "demo-agent-completed",
          providerId: this.id,
          workspaceId: "model",
          label: "Build shared model",
          status: "completed",
          createdAt: shifted(now, -45 * 60 * 1_000),
          startedAt: shifted(now, -44 * 60 * 1_000),
          updatedAt: shifted(now, -6 * 60 * 1_000),
          completedAt: shifted(now, -6 * 60 * 1_000),
        },
        {
          kind: "agent",
          id: "demo-agent-failed",
          providerId: this.id,
          workspaceId: "service",
          label: "Run smoke checks",
          status: "failed",
          createdAt: shifted(now, -35 * 60 * 1_000),
          startedAt: shifted(now, -34 * 60 * 1_000),
          updatedAt: shifted(now, -4 * 60 * 1_000),
          completedAt: shifted(now, -4 * 60 * 1_000),
          attentionReason: "Port was already in use",
        },
      ],
      events: [
        {
          id: "demo-event-seed-waiting",
          type: "agent.waiting",
          severity: "warning",
          message: "Plugin review is waiting for permission confirmation",
          occurredAt: shifted(now, -3 * 60 * 1_000),
          expiresAt: shifted(now, EVENT_LIFETIME_MS),
          providerId: this.id,
          resourceId: "demo-agent-waiting",
        },
        {
          id: "demo-event-seed-failed",
          type: "agent.failed",
          severity: "error",
          message: "Service smoke check could not bind its port",
          occurredAt: shifted(now, -4 * 60 * 1_000),
          expiresAt: shifted(now, EVENT_LIFETIME_MS),
          providerId: this.id,
          resourceId: "demo-agent-failed",
        },
      ],
    };
  }

  advance(snapshot: DashboardSnapshot, now: Date): ProviderAdvance {
    const liveAgent = snapshot.resources.find(
      (resource) => resource.id === LIVE_AGENT_ID,
    );
    if (liveAgent === undefined) {
      throw new Error(`Demo resource ${LIVE_AGENT_ID} is missing`);
    }

    const step = steps[this.#step];
    if (step === undefined) {
      throw new Error("Demo progression is not configured");
    }

    this.#step = (this.#step + 1) % steps.length;
    this.#eventSequence += 1;

    const resource = this.#transitionAgent(liveAgent, step, now);
    const event: StatusEvent = {
      id: `demo-event-${this.#eventSequence}`,
      type: step.eventType,
      severity: step.severity,
      message: step.eventMessage,
      occurredAt: now.toISOString(),
      expiresAt: shifted(now, EVENT_LIFETIME_MS),
      providerId: this.id,
      resourceId: resource.id,
    };
    const changes: DashboardChange[] = [
      {
        type: "provider.upsert",
        provider: {
          id: this.id,
          connectivity: "connected",
          checkedAt: now.toISOString(),
          label: "Local simulator",
          message: step.description,
        },
      },
      { type: "resource.upsert", resource },
      { type: "event.upsert", event },
    ];

    return { description: step.description, changes };
  }

  #transitionAgent(
    current: AgentResource,
    step: DemoStep,
    now: Date,
  ): AgentResource {
    const common = {
      kind: "agent" as const,
      id: current.id,
      providerId: current.providerId,
      ...(current.workspaceId === undefined
        ? {}
        : { workspaceId: current.workspaceId }),
      ...(current.label === undefined ? {} : { label: current.label }),
      status: step.status,
      createdAt: current.createdAt,
      updatedAt: now.toISOString(),
      startedAt:
        step.status === "running" &&
        (current.status === "completed" || current.status === "failed")
          ? now.toISOString()
          : (current.startedAt ?? now.toISOString()),
    };

    if (step.status === "waiting") {
      return {
        ...common,
        ...(step.attentionReason === undefined
          ? {}
          : { attentionReason: step.attentionReason }),
      };
    }
    if (step.status === "completed") {
      return { ...common, completedAt: now.toISOString() };
    }
    if (step.status === "failed") {
      return {
        ...common,
        completedAt: now.toISOString(),
        attentionReason: step.attentionReason,
      };
    }
    return common;
  }
}

export const demoResourceIds = {
  live: LIVE_AGENT_ID,
  waiting: "demo-agent-waiting",
  completed: "demo-agent-completed",
  failed: "demo-agent-failed",
} as const;
