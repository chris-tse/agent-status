import { createServer, type Server } from "node:http";
import { createConnection, createServer as createNetServer } from "node:net";

import { PROTOCOL_VERSION, SERVICE_NAME } from "@status-dashboard/model";
import { afterEach, describe, expect, it } from "vitest";

import { createServiceLifecycle, type ServiceSupervisor } from "../src/lifecycle.js";

const cleanup: Array<() => Promise<void>> = [];

function deferred(): { promise: Promise<void>; resolve(): void } {
  return Promise.withResolvers<void>();
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(async (dispose) => await dispose()));
});

async function availablePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test server did not bind a TCP port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
}

class LoginSessionSupervisor implements ServiceSupervisor {
  #active = false;
  #server: Server | undefined;
  #generation = 0;
  readonly #port: number;
  readonly #activationGate: Promise<void> | undefined;
  readonly #deactivationGate: Promise<void> | undefined;

  constructor(
    port: number,
    gates: { activation?: Promise<void>; deactivation?: Promise<void> } = {},
  ) {
    this.#port = port;
    this.#activationGate = gates.activation;
    this.#deactivationGate = gates.deactivation;
  }

  async isActive(): Promise<boolean> {
    return this.#active;
  }

  async activate(): Promise<void> {
    this.#active = true;
    await this.#activationGate;
    await this.#startProcess();
  }

  async deactivate(): Promise<void> {
    this.#active = false;
    await this.#deactivationGate;
    await this.#stopProcess();
  }

  async crash(): Promise<void> {
    await this.#stopProcess();
    if (this.#active) {
      await this.#startProcess();
    }
  }

  async dispose(): Promise<void> {
    this.#active = false;
    await this.#stopProcess();
  }

  async #startProcess(): Promise<void> {
    this.#generation += 1;
    const generation = this.#generation;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          status: "ok",
          service: SERVICE_NAME,
          protocolVersion: PROTOCOL_VERSION,
          version: generation,
          provider: "test",
        }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.#port, "127.0.0.1", resolve);
    });
    this.#server = server;
  }

  async #stopProcess(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server === undefined) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
}

async function endpointAcceptsConnections(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function startEndpoint(port: number, body: unknown): Promise<{ close(): Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

describe("service lifecycle", () => {
  it("starts the service under login-session supervision", async () => {
    const port = await availablePort();
    const supervisor = new LoginSessionSupervisor(port);
    cleanup.push(async () => await supervisor.dispose());
    const lifecycle = createServiceLifecycle({
      endpoint: `http://127.0.0.1:${port}`,
      supervisor,
    });

    expect(await endpointAcceptsConnections(port)).toBe(false);

    await expect(lifecycle.start()).resolves.toMatchObject({ state: "running" });

    expect(await endpointAcceptsConnections(port)).toBe(true);
    await expect(lifecycle.status()).resolves.toMatchObject({ state: "running" });
  });

  it("reuses a compatible service that already owns the endpoint", async () => {
    const port = await availablePort();
    const external = await startEndpoint(port, {
      status: "ok",
      service: SERVICE_NAME,
      protocolVersion: PROTOCOL_VERSION,
      version: 41,
      provider: "external",
    });
    cleanup.push(async () => await external.close());
    const supervisor = new LoginSessionSupervisor(port);
    cleanup.push(async () => await supervisor.dispose());
    const lifecycle = createServiceLifecycle({
      endpoint: `http://127.0.0.1:${port}`,
      supervisor,
    });

    await expect(lifecycle.start()).resolves.toMatchObject({
      state: "running",
      health: { version: 41, provider: "external" },
    });

    expect(await supervisor.isActive()).toBe(false);
  });

  it("rejects an unrelated endpoint owner without terminating it", async () => {
    const port = await availablePort();
    const unrelated = await startEndpoint(port, { application: "something-else" });
    cleanup.push(async () => await unrelated.close());
    const supervisor = new LoginSessionSupervisor(port);
    cleanup.push(async () => await supervisor.dispose());
    const lifecycle = createServiceLifecycle({
      endpoint: `http://127.0.0.1:${port}`,
      supervisor,
    });

    await expect(lifecycle.start()).rejects.toThrow(
      "status endpoint is occupied by an unrelated process",
    );

    expect(await supervisor.isActive()).toBe(false);
    expect(await endpointAcceptsConnections(port)).toBe(true);
  });

  it("rejects a non-HTTP endpoint owner without terminating it", async () => {
    const port = await availablePort();
    const unrelated = createNetServer((socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      unrelated.once("error", reject);
      unrelated.listen(port, "127.0.0.1", resolve);
    });
    cleanup.push(
      async () =>
        await new Promise<void>((resolve, reject) => {
          unrelated.close((error) => (error === undefined ? resolve() : reject(error)));
        }),
    );
    const supervisor = new LoginSessionSupervisor(port);
    cleanup.push(async () => await supervisor.dispose());
    const lifecycle = createServiceLifecycle({
      endpoint: `http://127.0.0.1:${port}`,
      supervisor,
    });

    await expect(lifecycle.start()).rejects.toThrow(
      "status endpoint is occupied by an unrelated process",
    );

    expect(await supervisor.isActive()).toBe(false);
    expect(await endpointAcceptsConnections(port)).toBe(true);
  });

  it("stops the service and leaves it deactivated", async () => {
    const port = await availablePort();
    const supervisor = new LoginSessionSupervisor(port);
    cleanup.push(async () => await supervisor.dispose());
    const lifecycle = createServiceLifecycle({
      endpoint: `http://127.0.0.1:${port}`,
      supervisor,
    });
    await lifecycle.start();

    await expect(lifecycle.stop()).resolves.toMatchObject({ state: "stopped" });

    expect(await supervisor.isActive()).toBe(false);
    expect(await endpointAcceptsConnections(port)).toBe(false);
    await expect(lifecycle.status()).resolves.toMatchObject({ state: "stopped" });
  });

  it("recovers from an abnormal exit while active", async () => {
    const port = await availablePort();
    const supervisor = new LoginSessionSupervisor(port);
    cleanup.push(async () => await supervisor.dispose());
    const lifecycle = createServiceLifecycle({
      endpoint: `http://127.0.0.1:${port}`,
      supervisor,
    });
    const initial = await lifecycle.start();

    await supervisor.crash();

    const recovered = await lifecycle.status();
    expect(initial).toMatchObject({ state: "running", health: { version: 1 } });
    expect(recovered).toMatchObject({ state: "running", health: { version: 2 } });
  });

  it("restarts with a controlled stop followed by start", async () => {
    const port = await availablePort();
    const supervisor = new LoginSessionSupervisor(port);
    cleanup.push(async () => await supervisor.dispose());
    const lifecycle = createServiceLifecycle({
      endpoint: `http://127.0.0.1:${port}`,
      supervisor,
    });
    const initial = await lifecycle.start();

    const restarted = await lifecycle.restart();

    expect(initial).toMatchObject({ state: "running", health: { version: 1 } });
    expect(restarted).toMatchObject({ state: "running", health: { version: 2 } });
  });

  it("reports starting and restarting while lifecycle transitions are in progress", async () => {
    const port = await availablePort();
    const activation = deferred();
    const supervisor = new LoginSessionSupervisor(port, {
      activation: activation.promise,
    });
    cleanup.push(async () => await supervisor.dispose());
    const lifecycle = createServiceLifecycle({
      endpoint: `http://127.0.0.1:${port}`,
      supervisor,
    });

    const starting = lifecycle.start();
    await expect.poll(async () => await supervisor.isActive()).toBe(true);
    await expect(lifecycle.status()).resolves.toMatchObject({ state: "starting" });
    activation.resolve();
    await expect(starting).resolves.toMatchObject({ state: "running" });

    const deactivation = deferred();
    const restartPort = await availablePort();
    const restartSupervisor = new LoginSessionSupervisor(restartPort, {
      deactivation: deactivation.promise,
    });
    cleanup.push(async () => await restartSupervisor.dispose());
    const restartLifecycle = createServiceLifecycle({
      endpoint: `http://127.0.0.1:${restartPort}`,
      supervisor: restartSupervisor,
    });
    await restartLifecycle.start();

    const restarting = restartLifecycle.restart();
    await expect.poll(async () => await restartSupervisor.isActive()).toBe(false);
    await expect(restartLifecycle.status()).resolves.toMatchObject({ state: "restarting" });
    deactivation.resolve();
    await expect(restarting).resolves.toMatchObject({ state: "running" });
  });

  it("serializes an explicit stop requested during startup", async () => {
    const port = await availablePort();
    const activation = deferred();
    const supervisor = new LoginSessionSupervisor(port, {
      activation: activation.promise,
    });
    cleanup.push(async () => await supervisor.dispose());
    const lifecycle = createServiceLifecycle({
      endpoint: `http://127.0.0.1:${port}`,
      supervisor,
    });

    const starting = lifecycle.start();
    await expect.poll(async () => await supervisor.isActive()).toBe(true);
    const stopping = lifecycle.stop();
    activation.resolve();

    await expect(starting).resolves.toMatchObject({ state: "running" });
    await expect(stopping).resolves.toMatchObject({ state: "stopped" });
    expect(await endpointAcceptsConnections(port)).toBe(false);
  });

  it("reports unhealthy when supervision is active without a healthy process", async () => {
    const port = await availablePort();
    const lifecycle = createServiceLifecycle({
      endpoint: `http://127.0.0.1:${port}`,
      supervisor: {
        async isActive() {
          return true;
        },
        async activate() {},
        async deactivate() {},
      },
    });

    await expect(lifecycle.status()).resolves.toMatchObject({
      state: "unhealthy",
      message: expect.stringContaining("health endpoint is unavailable"),
    });
  });

  it("rejects the expected service when its protocol is incompatible", async () => {
    const port = await availablePort();
    const incompatible = await startEndpoint(port, {
      status: "ok",
      service: SERVICE_NAME,
      protocolVersion: PROTOCOL_VERSION + 1,
      version: 1,
      provider: "old-service",
    });
    cleanup.push(async () => await incompatible.close());
    const supervisor = new LoginSessionSupervisor(port);
    cleanup.push(async () => await supervisor.dispose());
    const lifecycle = createServiceLifecycle({
      endpoint: `http://127.0.0.1:${port}`,
      supervisor,
    });

    await expect(lifecycle.start()).rejects.toThrow(
      `speaks protocol ${PROTOCOL_VERSION + 1}; expected ${PROTOCOL_VERSION}`,
    );

    expect(await supervisor.isActive()).toBe(false);
    expect(await endpointAcceptsConnections(port)).toBe(true);
  });

  it("deactivates supervision when a conflicting process wins the startup race", async () => {
    let active = false;
    const lifecycle = createServiceLifecycle({
      endpoint: "http://127.0.0.1:4317",
      supervisor: {
        async isActive() {
          return active;
        },
        async activate() {
          active = true;
        },
        async deactivate() {
          active = false;
        },
      },
      fetch: async () => {
        if (!active) throw new TypeError("connection refused");
        return Response.json({ application: "port-squatter" });
      },
    });

    await expect(lifecycle.start()).rejects.toThrow("unrelated process");
    expect(active).toBe(false);
  });
});
