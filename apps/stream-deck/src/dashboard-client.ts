import { DashboardWireMessageSchema, type AgentResource } from "@status-dashboard/model";
import WebSocket from "ws";

import { WireState, WireVersionError } from "./wire-state.js";

export const DEFAULT_ENDPOINT = "ws://127.0.0.1:4317/ws";

export type ConnectionState = "connecting" | "connected" | "disconnected";

export interface DashboardClientSnapshot {
  readonly connection: ConnectionState;
  readonly resources: readonly AgentResource[];
}

export interface ClientLogger {
  debug(message: string): void;
  error(message: string): void;
  warn(message: string): void;
}

export function normalizeLocalEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    return DEFAULT_ENDPOINT;
  }

  try {
    const endpoint = new URL(value);
    const isLocal =
      endpoint.hostname === "127.0.0.1" ||
      endpoint.hostname === "localhost" ||
      endpoint.hostname === "[::1]";
    if (!isLocal || (endpoint.protocol !== "ws:" && endpoint.protocol !== "wss:")) {
      return DEFAULT_ENDPOINT;
    }
    if (endpoint.pathname === "/") {
      endpoint.pathname = "/ws";
    }
    endpoint.hash = "";
    return endpoint.toString();
  } catch {
    return DEFAULT_ENDPOINT;
  }
}

export class DashboardClient {
  readonly #state = new WireState();
  readonly #listeners = new Set<(snapshot: DashboardClientSnapshot) => void>();
  readonly #logger: ClientLogger;

  #connection: ConnectionState = "disconnected";
  #endpoint: string;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #shouldRun = false;
  #socket: WebSocket | undefined;

  constructor(logger: ClientLogger, endpoint = DEFAULT_ENDPOINT) {
    this.#logger = logger;
    this.#endpoint = normalizeLocalEndpoint(endpoint);
  }

  get snapshot(): DashboardClientSnapshot {
    return {
      connection: this.#connection,
      resources: this.#state.resources,
    };
  }

  subscribe(listener: (snapshot: DashboardClientSnapshot) => void): () => void {
    this.#listeners.add(listener);
    listener(this.snapshot);
    return () => this.#listeners.delete(listener);
  }

  start(): void {
    this.#shouldRun = true;
    this.connect();
  }

  stop(): void {
    this.#shouldRun = false;
    if (this.#reconnectTimer !== undefined) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.close();
    this.setConnection("disconnected");
  }

  setEndpoint(endpoint: unknown): void {
    const normalized = normalizeLocalEndpoint(endpoint);
    if (normalized === this.#endpoint) {
      return;
    }
    this.#endpoint = normalized;
    this.#state.clear();
    if (this.#shouldRun) {
      const socket = this.#socket;
      this.#socket = undefined;
      socket?.close();
      this.connect();
    }
    this.emit();
  }

  async advanceDemo(): Promise<void> {
    const url = new URL(this.#endpoint);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = "/api/demo/advance";
    url.search = "";

    const response = await fetch(url, { method: "POST" });
    if (!response.ok) {
      throw new Error(`Demo advance failed with HTTP ${response.status}`);
    }
  }

  private connect(): void {
    if (!this.#shouldRun || this.#socket !== undefined) {
      return;
    }

    this.setConnection("connecting");
    const socket = new WebSocket(this.#endpoint);
    this.#socket = socket;

    socket.on("open", () => {
      if (this.#socket === socket) {
        this.#logger.debug(`Connected to ${this.#endpoint}`);
        this.setConnection("connected");
      }
    });

    socket.on("message", (data) => {
      if (this.#socket !== socket) {
        return;
      }
      this.handleMessage(data.toString(), socket);
    });

    socket.on("error", (error) => {
      this.#logger.warn(`Dashboard socket error: ${error.message}`);
    });

    socket.on("close", () => {
      if (this.#socket !== socket) {
        return;
      }
      this.#socket = undefined;
      this.setConnection("disconnected");
      this.scheduleReconnect();
    });
  }

  private handleMessage(raw: string, socket: WebSocket): void {
    try {
      const json: unknown = JSON.parse(raw);
      const parsed = DashboardWireMessageSchema.safeParse(json);
      if (!parsed.success) {
        this.#logger.warn(`Ignored invalid dashboard message: ${parsed.error.message}`);
        return;
      }

      if (this.#state.apply(parsed.data)) {
        this.emit();
      }
    } catch (error) {
      if (error instanceof WireVersionError) {
        this.#logger.warn(`${error.message}; reconnecting for a fresh snapshot`);
        this.#state.clear();
        this.emit();
        socket.close(1012, "Snapshot required");
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.#logger.error(`Failed to process dashboard message: ${message}`);
    }
  }

  private scheduleReconnect(): void {
    if (!this.#shouldRun || this.#reconnectTimer !== undefined) {
      return;
    }
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.connect();
    }, 2_000);
  }

  private setConnection(connection: ConnectionState): void {
    if (this.#connection !== connection) {
      this.#connection = connection;
      this.emit();
    }
  }

  private emit(): void {
    const snapshot = this.snapshot;
    for (const listener of this.#listeners) {
      listener(snapshot);
    }
  }
}
