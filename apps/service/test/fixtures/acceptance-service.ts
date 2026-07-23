import type {
  AgentResource,
  DashboardChange,
  ProviderStatus,
} from "@status-dashboard/model";

import type { ServiceConfig } from "../../src/config.js";
import type {
  ProviderConnection,
  ProviderListener,
  StatusProvider,
} from "../../src/provider.js";
import { createStatusServer } from "../../src/server.js";
import type { DashboardState } from "../../src/store.js";

const INITIAL_TIME = new Date("2026-07-22T12:00:00.000Z");

class ControlledProvider implements StatusProvider {
  readonly id = "controlled";
  readonly #clock: () => Date;
  #listener: ProviderListener | undefined;

  constructor(clock: () => Date) {
    this.#clock = clock;
  }

  open(listener: ProviderListener): ProviderConnection {
    this.#listener = listener;
    const checkedAt = this.#clock().toISOString();
    const provider: ProviderStatus = {
      id: this.id,
      connectivity: "connected",
      checkedAt,
      label: "Controlled provider",
    };
    const resource: AgentResource = {
      kind: "agent",
      id: "controlled-agent",
      providerId: this.id,
      label: "Controlled agent",
      status: "running",
      createdAt: checkedAt,
      startedAt: checkedAt,
      updatedAt: checkedAt,
    };
    const state: DashboardState = {
      providers: [provider],
      resources: [resource],
      events: [],
    };
    listener({ type: "replace", state });
    return {
      close: () => {
        this.#listener = undefined;
      },
    };
  }

  pushChanges(changes: readonly DashboardChange[]): void {
    this.#listener?.({ type: "changes", changes });
  }

  fail(message: string): never {
    throw new Error(message);
  }
}

const config: ServiceConfig = {
  host: "127.0.0.1",
  port: 0,
  allowedOrigins: "local",
  provider: "demo",
  herdrSocketPath: "/unused",
};
let now = INITIAL_TIME;
const provider = new ControlledProvider(() => now);
const service = createStatusServer({
  config,
  clock: () => now,
  provider,
});
let stopped = false;

function stop(): void {
  if (stopped) return;
  stopped = true;
  service.stop();
  process.exit(0);
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

process.stdin.setEncoding("utf8");
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk;
  while (true) {
    const newline = input.indexOf("\n");
    if (newline < 0) break;
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    const command = JSON.parse(line) as
      | { type: "stop" }
      | { type: "setTime"; id: number; timestamp: string }
      | { type: "changes"; id: number; changes: DashboardChange[] }
      | { type: "fail"; message: string };
    if (command.type === "stop") {
      stop();
    } else if (command.type === "setTime") {
      now = new Date(command.timestamp);
      process.stdout.write(
        `${JSON.stringify({ type: "ack", id: command.id })}\n`,
      );
    } else if (command.type === "changes") {
      provider.pushChanges(command.changes);
      process.stdout.write(
        `${JSON.stringify({ type: "ack", id: command.id })}\n`,
      );
    } else {
      provider.fail(command.message);
    }
  }
});

process.stdout.write(
  `${JSON.stringify({
    type: "ready",
    baseUrl: service.server.url.toString(),
  })}\n`,
);
