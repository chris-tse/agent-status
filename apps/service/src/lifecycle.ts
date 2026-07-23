import {
  HealthResponseSchema,
  PROTOCOL_VERSION,
  SERVICE_NAME,
  type HealthResponse,
} from "@status-dashboard/model";
import { homedir } from "node:os";
import { createConnection } from "node:net";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createLaunchdSupervisor } from "./launchd.js";
import { loadConfig } from "./config.js";
export type ServiceLifecycleState = "stopped" | "starting" | "running" | "restarting" | "unhealthy";

export interface ServiceLifecycleStatus {
  state: ServiceLifecycleState;
  health?: HealthResponse;
  message?: string;
}

/**
 * Current-login-session process supervision boundary. The production
 * implementation uses launchd's `gui/<uid>` domain; tests can provide an
 * equivalent session supervisor without mutating the real login session.
 */
export interface ServiceSupervisor {
  isActive(): Promise<boolean>;
  activate(): Promise<void>;
  deactivate(): Promise<void>;
}

export interface ServiceLifecycle {
  status(): Promise<ServiceLifecycleStatus>;
  start(): Promise<ServiceLifecycleStatus>;
  stop(): Promise<ServiceLifecycleStatus>;
  restart(): Promise<ServiceLifecycleStatus>;
}

export interface ServiceLifecycleOptions {
  endpoint: string;
  supervisor: ServiceSupervisor;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  pollIntervalMs?: number;
  probeTimeoutMs?: number;
  startTimeoutMs?: number;
}

export interface DefaultServiceLifecycleOptions {
  environment?: Record<string, string | undefined>;
  uid?: number;
  supportDirectory?: string;
  executable?: string;
  serviceEntryPoint?: string;
}

type HealthProbe =
  | { kind: "compatible"; health: HealthResponse }
  | { kind: "unavailable" }
  | { kind: "occupied"; message: string };

function healthUrl(endpoint: string): URL {
  return new URL("health", endpoint.endsWith("/") ? endpoint : `${endpoint}/`);
}

function endpointConflictMessage(value: unknown): string {
  const parsed = HealthResponseSchema.safeParse(value);
  if (parsed.success && parsed.data.service === SERVICE_NAME) {
    return (
      `The status endpoint is owned by ${SERVICE_NAME}, but it speaks protocol ` +
      `${parsed.data.protocolVersion}; expected ${PROTOCOL_VERSION}.`
    );
  }
  return "The status endpoint is occupied by an unrelated process.";
}

async function endpointHasListener(url: URL): Promise<boolean> {
  const port = url.port.length > 0 ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  return await new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (occupied: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(occupied);
    };
    socket.setTimeout(250, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export function createServiceLifecycle(options: ServiceLifecycleOptions): ServiceLifecycle {
  const fetchHealth = options.fetch ?? globalThis.fetch;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const probeTimeoutMs = options.probeTimeoutMs ?? 1_000;
  const startTimeoutMs = options.startTimeoutMs ?? 5_000;
  let transition: "starting" | "restarting" | undefined;
  let mutation: Promise<void> = Promise.resolve();

  function mutate(
    operation: () => Promise<ServiceLifecycleStatus>,
  ): Promise<ServiceLifecycleStatus> {
    const result = mutation.then(operation, operation);
    mutation = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  async function probe(): Promise<HealthProbe> {
    const url = healthUrl(options.endpoint);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), probeTimeoutMs);
    let response: Response;
    try {
      response = await fetchHealth(url, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
    } catch {
      return (await endpointHasListener(url))
        ? {
            kind: "occupied",
            message: "The status endpoint is occupied by an unrelated process.",
          }
        : { kind: "unavailable" };
    } finally {
      clearTimeout(timeout);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return {
        kind: "occupied",
        message: "The status endpoint is occupied by a process with an invalid health response.",
      };
    }

    const parsed = HealthResponseSchema.safeParse(body);
    if (
      response.ok &&
      parsed.success &&
      parsed.data.service === SERVICE_NAME &&
      parsed.data.protocolVersion === PROTOCOL_VERSION
    ) {
      return { kind: "compatible", health: parsed.data };
    }
    return { kind: "occupied", message: endpointConflictMessage(body) };
  }

  async function inspect(): Promise<ServiceLifecycleStatus> {
    if (transition !== undefined) return { state: transition };

    const health = await probe();
    if (health.kind === "compatible") {
      return { state: "running", health: health.health };
    }
    if (health.kind === "occupied") {
      return { state: "unhealthy", message: health.message };
    }
    if (await options.supervisor.isActive()) {
      return {
        state: "unhealthy",
        message: "The supervised status service is active but its health endpoint is unavailable.",
      };
    }
    return { state: "stopped" };
  }

  async function waitUntilRunning(): Promise<ServiceLifecycleStatus> {
    const deadline = Date.now() + startTimeoutMs;
    while (true) {
      const health = await probe();
      if (health.kind === "compatible") {
        return { state: "running", health: health.health };
      }
      if (health.kind === "occupied") {
        throw new Error(health.message);
      }
      if (Date.now() >= deadline) {
        return {
          state: "unhealthy",
          message: "The supervised status service did not become healthy before startup timed out.",
        };
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  async function start(): Promise<ServiceLifecycleStatus> {
    const existing = await probe();
    if (existing.kind === "compatible") {
      return { state: "running", health: existing.health };
    }
    if (existing.kind === "occupied") {
      throw new Error(existing.message);
    }

    transition = transition === "restarting" ? "restarting" : "starting";
    try {
      if (!(await options.supervisor.isActive())) {
        await options.supervisor.activate();
      }
      try {
        return await waitUntilRunning();
      } catch (error) {
        if (await options.supervisor.isActive()) {
          await options.supervisor.deactivate();
        }
        throw error;
      }
    } finally {
      transition = undefined;
    }
  }

  async function stop(): Promise<ServiceLifecycleStatus> {
    if (await options.supervisor.isActive()) {
      await options.supervisor.deactivate();
    }
    return await inspect();
  }

  async function restart(): Promise<ServiceLifecycleStatus> {
    transition = "restarting";
    try {
      if (await options.supervisor.isActive()) {
        await options.supervisor.deactivate();
      }
      return await start();
    } finally {
      transition = undefined;
    }
  }

  return {
    status: inspect,
    start: async () => await mutate(start),
    stop: async () => await mutate(stop),
    restart: async () => await mutate(restart),
  };
}

function launchdEnvironment(
  source: Record<string, string | undefined>,
  port: number,
): Record<string, string> {
  const environment: Record<string, string> = {
    HOST: "127.0.0.1",
    PORT: String(port),
  };
  for (const key of [
    "HOME",
    "STATUS_PROVIDER",
    "HERDR_SOCKET_PATH",
    "HERDR_SESSION",
    "XDG_CONFIG_HOME",
    "CORS_ORIGINS",
  ] as const) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

/**
 * Creates the production macOS lifecycle controller. Its plist lives in
 * Application Support and is bootstrapped into the current `gui/<uid>` domain,
 * so launchd forgets it at logout and cannot discover it as a login agent.
 */
export function createDefaultServiceLifecycle(
  options: DefaultServiceLifecycleOptions = {},
): ServiceLifecycle {
  const environment = options.environment ?? process.env;
  const config = loadConfig(environment);
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) {
    throw new Error("The status service lifecycle requires a macOS user session");
  }
  const thisModule = fileURLToPath(import.meta.url);
  const sourceExtension = extname(thisModule) === ".ts" ? ".ts" : ".js";
  const serviceEntryPoint =
    options.serviceEntryPoint ?? join(dirname(thisModule), `index${sourceExtension}`);
  const applicationDirectory = dirname(dirname(serviceEntryPoint));
  const supportDirectory =
    options.supportDirectory ??
    join(homedir(), "Library", "Application Support", "Ambient Status Dashboard");
  const supervisor = createLaunchdSupervisor({
    uid,
    supportDirectory,
    executable: options.executable ?? process.execPath,
    serviceArguments: [serviceEntryPoint],
    workingDirectory: applicationDirectory,
    environment: launchdEnvironment(environment, config.port),
  });
  return createServiceLifecycle({
    endpoint: `http://127.0.0.1:${config.port}`,
    supervisor,
  });
}
