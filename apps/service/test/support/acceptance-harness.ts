import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { DashboardChange } from "@status-dashboard/model";

const START_TIMEOUT_MS = 5_000;
const MESSAGE_TIMEOUT_MS = 2_000;
const FIXTURE_PATH = fileURLToPath(new URL("../fixtures/acceptance-service.ts", import.meta.url));

interface PendingMessage {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface SocketCloseResult {
  code: number;
  reason: string;
  wasClean: boolean;
}

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface AcceptanceSocket {
  nextMessage(timeoutMs?: number): Promise<unknown>;
  closed(): Promise<SocketCloseResult>;
  close(): Promise<void>;
}

export interface AcceptanceService {
  readonly baseUrl: string;
  connect(): Promise<AcceptanceSocket>;
  setTime(timestamp: string): Promise<void>;
  pushChanges(changes: readonly DashboardChange[]): Promise<void>;
  failProvider(message: string): Promise<ProcessExit>;
  stop(): Promise<void>;
}

class ConnectedSocket implements AcceptanceSocket {
  readonly #socket: WebSocket;
  readonly #messages: unknown[] = [];
  readonly #pending: PendingMessage[] = [];
  readonly #closed: Promise<SocketCloseResult>;

  constructor(socket: WebSocket) {
    this.#socket = socket;
    this.#closed = new Promise((resolve) => {
      socket.addEventListener(
        "close",
        (event) => {
          resolve({
            code: event.code,
            reason: event.reason,
            wasClean: event.wasClean,
          });
        },
        { once: true },
      );
    });
    socket.addEventListener("message", (event) => {
      const value = JSON.parse(String(event.data)) as unknown;
      const pending = this.#pending.shift();
      if (pending === undefined) {
        this.#messages.push(value);
        return;
      }
      clearTimeout(pending.timer);
      pending.resolve(value);
    });
  }

  async closed(): Promise<SocketCloseResult> {
    return await this.#closed;
  }

  async nextMessage(timeoutMs = MESSAGE_TIMEOUT_MS): Promise<unknown> {
    const queued = this.#messages.shift();
    if (queued !== undefined) return queued;

    return await new Promise<unknown>((resolve, reject) => {
      const pending: PendingMessage = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.#pending.indexOf(pending);
          if (index >= 0) this.#pending.splice(index, 1);
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for a WebSocket message`));
        }, timeoutMs),
      };
      this.#pending.push(pending);
    });
  }

  async close(): Promise<void> {
    if (this.#socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.#socket.addEventListener("close", () => resolve(), { once: true });
      this.#socket.close();
    });
  }
}

function waitForLine(child: ChildProcessWithoutNullStreams): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let output = "";
    let errors = "";

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out starting acceptance service: ${errors}`));
    }, START_TIMEOUT_MS);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      try {
        resolve(JSON.parse(output.slice(0, newline)) as Record<string, unknown>);
      } catch (error) {
        reject(
          new Error(`Acceptance service sent invalid startup output: ${output}`, {
            cause: error,
          }),
        );
      }
    };
    const onErrorData = (chunk: Buffer) => {
      errors += chunk.toString();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `Acceptance service exited before startup (code ${String(code)}, signal ${String(signal)}): ${errors}`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onErrorData);
      child.off("exit", onExit);
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onErrorData);
    child.once("exit", onExit);
  });
}

export async function startAcceptanceService(): Promise<AcceptanceService> {
  const child = spawn("bun", ["run", FIXTURE_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const startup = await waitForLine(child);
  if (startup.type !== "ready" || typeof startup.baseUrl !== "string") {
    child.kill();
    throw new Error(
      `Acceptance service did not report a usable endpoint: ${JSON.stringify(startup)}`,
    );
  }
  const baseUrl = startup.baseUrl;

  let stopped = false;
  let controlSequence = 0;
  let controlOutput = "";
  const pendingControls = new Map<number, { resolve(): void; reject(error: Error): void }>();
  const exit = new Promise<ProcessExit>((resolve) => {
    child.once("exit", (code, signal) => {
      for (const pending of pendingControls.values()) {
        pending.reject(
          new Error(`Acceptance service exited before acknowledging a control command`),
        );
      }
      pendingControls.clear();
      resolve({ code, signal });
    });
  });
  child.stderr.resume();
  child.stdout.on("data", (chunk: Buffer) => {
    controlOutput += chunk.toString();
    while (true) {
      const newline = controlOutput.indexOf("\n");
      if (newline < 0) break;
      const line = controlOutput.slice(0, newline);
      controlOutput = controlOutput.slice(newline + 1);
      const response = JSON.parse(line) as { type?: string; id?: number };
      if (response.type !== "ack" || response.id === undefined) continue;
      pendingControls.get(response.id)?.resolve();
      pendingControls.delete(response.id);
    }
  });
  const write = (command: unknown) => {
    child.stdin.write(`${JSON.stringify(command)}\n`);
  };
  const sendControl = async (command: Record<string, unknown>) => {
    const id = ++controlSequence;
    const acknowledged = new Promise<void>((resolve, reject) => {
      pendingControls.set(id, { resolve, reject });
    });
    write({ ...command, id });
    await acknowledged;
  };

  return {
    baseUrl,
    async connect() {
      const socket = new WebSocket(baseUrl.replace(/^http/, "ws") + "ws");
      const connected = new ConnectedSocket(socket);
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), {
          once: true,
        });
      });
      return connected;
    },
    async setTime(timestamp) {
      await sendControl({ type: "setTime", timestamp });
    },
    async pushChanges(changes) {
      await sendControl({ type: "changes", changes });
    },
    async failProvider(message) {
      write({ type: "fail", message });
      const result = await exit;
      stopped = true;
      return result;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      child.stdin.end(`${JSON.stringify({ type: "stop" })}\n`);
      const result = await exit;
      if (result.code !== 0) {
        throw new Error(
          `Acceptance service stopped abnormally (code ${String(result.code)}, signal ${String(result.signal)})`,
        );
      }
    },
  };
}
