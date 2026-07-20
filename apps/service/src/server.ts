import {
  DashboardSnapshotMessageSchema,
  type DashboardWireMessage,
} from "@status-dashboard/model";
import type { Server, ServerWebSocket } from "bun";

import { SubscriptionBroadcaster } from "./broadcast.js";
import {
  isOriginAllowed,
  loadConfig,
  type ServiceConfig,
} from "./config.js";
import { DemoController } from "./demo-controller.js";
import type { StatusProvider } from "./provider.js";
import { SimulatedStatusProvider } from "./simulated-provider.js";
import { type Clock, DashboardStore } from "./store.js";

interface ConnectionData {
  connectedAt: string;
}

export interface StatusServerOptions {
  config?: ServiceConfig;
  clock?: Clock;
  provider?: StatusProvider;
}

export interface RunningStatusServer {
  readonly server: Server<ConnectionData>;
  readonly store: DashboardStore;
  readonly demo: DemoController;
  stop(): void;
}

function corsHeaders(origin: string | null): Headers {
  const headers = new Headers({
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  });
  if (origin !== null) {
    headers.set("Access-Control-Allow-Origin", origin);
  }
  return headers;
}

function json(
  body: unknown,
  status: number,
  origin: string | null,
): Response {
  const headers = corsHeaders(origin);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers });
}

function wireJson(message: DashboardWireMessage): string {
  return JSON.stringify(message);
}

export function createStatusServer(
  options: StatusServerOptions = {},
): RunningStatusServer {
  const config = options.config ?? loadConfig(Bun.env);
  const clock = options.clock ?? (() => new Date());
  const broadcaster = new SubscriptionBroadcaster();
  const store = new DashboardStore(broadcaster, clock);
  const provider = options.provider ?? new SimulatedStatusProvider();
  const demo = new DemoController(store, provider, clock);
  demo.reset();

  const connections = new Set<ServerWebSocket<ConnectionData>>();
  const unsubscribe = broadcaster.subscribe((message) => {
    const payload = wireJson(message);
    for (const connection of connections) {
      if (connection.readyState === WebSocket.OPEN) {
        connection.send(payload);
      }
    }
  });

  const server = Bun.serve<ConnectionData>({
    hostname: config.host,
    port: config.port,
    fetch(request, bunServer) {
      const url = new URL(request.url);
      const origin = request.headers.get("origin");

      if (!isOriginAllowed(origin, config.allowedOrigins)) {
        return json({ error: "Origin is not allowed" }, 403, null);
      }

      if (url.pathname === "/ws") {
        if (
          request.method !== "GET" ||
          request.headers.get("upgrade")?.toLowerCase() !== "websocket"
        ) {
          return json({ error: "WebSocket upgrade required" }, 426, origin);
        }

        const upgraded = bunServer.upgrade(request, {
          data: { connectedAt: clock().toISOString() },
        });
        return upgraded
          ? undefined
          : json({ error: "WebSocket upgrade failed" }, 400, origin);
      }

      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: corsHeaders(origin),
        });
      }

      try {
        if (request.method === "GET" && url.pathname === "/health") {
          return json(
            { status: "ok", version: store.version, provider: provider.id },
            200,
            origin,
          );
        }
        if (request.method === "GET" && url.pathname === "/api/snapshot") {
          return json(store.snapshot(), 200, origin);
        }
        if (
          request.method === "POST" &&
          url.pathname === "/api/demo/advance"
        ) {
          return json(demo.advance(), 200, origin);
        }
        if (
          request.method === "POST" &&
          url.pathname === "/api/demo/reset"
        ) {
          return json({ snapshot: demo.reset() }, 200, origin);
        }
      } catch (error) {
        console.error("Status service request failed", error);
        return json({ error: "Internal service error" }, 500, origin);
      }

      return json({ error: "Not found" }, 404, origin);
    },
    websocket: {
      open(socket) {
        const message = DashboardSnapshotMessageSchema.parse({
          type: "snapshot",
          snapshot: store.snapshot(),
        });
        socket.send(wireJson(message));
        connections.add(socket);
      },
      message() {
        // The dashboard stream is intentionally server-to-client only.
      },
      close(socket) {
        connections.delete(socket);
      },
    },
  });

  const pruneTimer = setInterval(() => {
    store.pruneExpired();
  }, 30_000);

  return {
    server,
    store,
    demo,
    stop() {
      clearInterval(pruneTimer);
      unsubscribe();
      for (const connection of connections) connection.close();
      connections.clear();
      server.stop(true);
    },
  };
}
