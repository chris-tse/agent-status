import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";

import type { DashboardChange } from "@status-dashboard/model";
import { afterEach, describe, expect, it } from "vitest";

import { HerdrStatusProvider } from "../src/herdr-provider.js";
import type { ProviderMessage } from "../src/provider.js";

interface FixtureAgent {
  agent_status: string;
  pane_id: string;
  state_change_seq: number;
}

interface FixtureResponse {
  result: {
    snapshot: {
      agents: FixtureAgent[];
    };
  };
}

const FIXTURE_URL = new URL("./fixtures/herdr-session-snapshot.json", import.meta.url);
const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dispose) => dispose()));
});

async function waitFor<T>(
  read: () => T | undefined,
  timeoutMs = 2_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for provider output");
}

async function startFakeHerdr(): Promise<{
  socketPath: string;
  setStatus(paneId: string, status: string): void;
  publish(event: unknown): void;
}> {
  const directory = await mkdtemp(join(tmpdir(), "status-dashboard-herdr-"));
  const socketPath = join(directory, "herdr.sock");
  const fixture = JSON.parse(
    await readFile(FIXTURE_URL, "utf8"),
  ) as FixtureResponse;
  const subscriptions = new Set<Socket>();
  let server: Server;

  server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;

      const request = JSON.parse(buffer.slice(0, newline)) as {
        id: string;
        method: string;
        params?: {
          subscriptions?: Array<{ type: string }>;
        };
      };
      if (request.method === "session.snapshot") {
        socket.end(`${JSON.stringify({ ...fixture, id: request.id })}\n`);
        return;
      }
      if (request.method === "events.subscribe") {
        if (
          request.params?.subscriptions?.some(
            ({ type }) => type === "pane.updated",
          )
        ) {
          socket.end(
            `${JSON.stringify({
              id: request.id,
              error: {
                code: "invalid_request",
                message: "pane.updated is unavailable in protocol 16",
              },
            })}\n`,
          );
          return;
        }
        subscriptions.add(socket);
        socket.write(
          `${JSON.stringify({
            id: request.id,
            result: { type: "subscription_started" },
          })}\n`,
        );
      }
    });
    socket.on("close", () => subscriptions.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  cleanup.push(async () => {
    for (const socket of subscriptions) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  return {
    socketPath,
    setStatus(paneId, status) {
      const agent = fixture.result.snapshot.agents.find(
        (candidate) => candidate.pane_id === paneId,
      );
      if (agent === undefined) throw new Error(`Missing fixture pane ${paneId}`);
      agent.agent_status = status;
      agent.state_change_seq += 1;
    },
    publish(event) {
      for (const socket of subscriptions) {
        socket.write(`${JSON.stringify(event)}\n`);
      }
    },
  };
}

describe("HerdrStatusProvider", () => {
  it("maps a validated session snapshot into provider-neutral agent resources", async () => {
    const herdr = await startFakeHerdr();
    const messages: ProviderMessage[] = [];
    const provider = new HerdrStatusProvider({
      socketPath: herdr.socketPath,
      clock: () => new Date("2026-07-20T05:00:00.000Z"),
    });
    const connection = provider.open((message) => messages.push(message));
    cleanup.push(() => connection.close());

    const replacement = await waitFor(() =>
      messages.find((message) => message.type === "replace"),
    );
    if (replacement.type !== "replace") throw new Error("Expected replacement");

    expect(replacement.state.providers).toEqual([
      expect.objectContaining({
        id: "herdr",
        connectivity: "connected",
        message: "Connected to Herdr 0.7.3 (protocol 16)",
      }),
    ]);
    expect(
      replacement.state.resources.map(({ id, label, status, workspaceId }) => ({
        id,
        label,
        status,
        workspaceId,
      })),
    ).toEqual([
      {
        id: "herdr:w1:p1",
        label: "Build provider",
        status: "running",
        workspaceId: "w1",
      },
      {
        id: "herdr:w1:p2",
        label: "Review contract",
        status: "waiting",
        workspaceId: "w1",
      },
      {
        id: "herdr:w1:p3",
        label: "Run tests",
        status: "completed",
        workspaceId: "w1",
      },
      {
        id: "herdr:w1:p4",
        label: "Plan follow-up",
        status: "completed",
        workspaceId: "w1",
      },
    ]);
  });

  it("refreshes from lifecycle events and emits a normalized attention event", async () => {
    const herdr = await startFakeHerdr();
    const messages: ProviderMessage[] = [];
    const provider = new HerdrStatusProvider({
      socketPath: herdr.socketPath,
      clock: () => new Date("2026-07-20T05:05:00.000Z"),
    });
    const connection = provider.open((message) => messages.push(message));
    cleanup.push(() => connection.close());

    await waitFor(() =>
      messages.find((message) => message.type === "replace"),
    );
    herdr.setStatus("w1:p1", "blocked");
    herdr.publish({
      event: "pane.agent_status_changed",
      data: {
        pane_id: "w1:p1",
        workspace_id: "w1",
        agent_status: "blocked",
      },
    });

    const changes = await waitFor(() =>
      messages
        .filter((message) => message.type === "changes")
        .flatMap((message) => message.changes)
        .find(
          (change): change is DashboardChange =>
            change.type === "event.upsert" &&
            change.event.type === "agent.waiting",
        ),
    );

    expect(changes).toMatchObject({
      type: "event.upsert",
      event: {
        severity: "warning",
        providerId: "herdr",
        resourceId: "herdr:w1:p1",
      },
    });
    expect(
      messages
        .filter((message) => message.type === "changes")
        .flatMap((message) => message.changes),
    ).toContainEqual(
      expect.objectContaining({
        type: "resource.upsert",
        resource: expect.objectContaining({
          id: "herdr:w1:p1",
          status: "waiting",
        }),
      }),
    );
  });

  it("rejects unsupported source statuses and reports the provider disconnected", async () => {
    const herdr = await startFakeHerdr();
    const messages: ProviderMessage[] = [];
    const provider = new HerdrStatusProvider({
      socketPath: herdr.socketPath,
      clock: () => new Date("2026-07-20T05:10:00.000Z"),
      retryDelayMs: 10_000,
    });
    const connection = provider.open((message) => messages.push(message));
    cleanup.push(() => connection.close());

    await waitFor(() =>
      messages.find((message) => message.type === "replace"),
    );
    herdr.setStatus("w1:p1", "future_status");
    herdr.publish({
      event: "pane.agent_status_changed",
      data: {
        pane_id: "w1:p1",
        workspace_id: "w1",
        agent_status: "future_status",
      },
    });

    const disconnected = await waitFor(() =>
      messages
        .filter((message) => message.type === "changes")
        .flatMap((message) => message.changes)
        .find(
          (change) =>
            change.type === "provider.upsert" &&
            change.provider.connectivity === "disconnected",
        ),
    );

    expect(disconnected).toMatchObject({
      type: "provider.upsert",
      provider: {
        id: "herdr",
        connectivity: "disconnected",
      },
    });
  });
});
