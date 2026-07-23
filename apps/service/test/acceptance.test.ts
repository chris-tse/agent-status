import {
  DashboardSnapshotMessageSchema,
  DashboardUpdateMessageSchema,
  HealthResponseSchema,
  PROTOCOL_VERSION,
  SERVICE_NAME,
} from "@status-dashboard/model";
import { afterEach, describe, expect, it } from "vitest";

import {
  startAcceptanceService,
  type AcceptanceService,
} from "./support/acceptance-harness.js";

const services: AcceptanceService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
});

describe("assembled status service", () => {
  it("delivers the current snapshot when a consumer connects", async () => {
    const service = await startAcceptanceService();
    services.push(service);

    const socket = await service.connect();
    const message = DashboardSnapshotMessageSchema.parse(
      await socket.nextMessage(),
    );

    expect(message.snapshot).toMatchObject({
      version: 1,
      generatedAt: "2026-07-22T12:00:00.000Z",
      providers: [
        {
          id: "controlled",
          connectivity: "connected",
          checkedAt: "2026-07-22T12:00:00.000Z",
        },
      ],
    });
    expect(message.snapshot.resources).toHaveLength(1);
    expect(message.snapshot.resources[0]).toMatchObject({
      id: "controlled-agent",
      providerId: "controlled",
      status: "running",
    });
  });

  it("pushes provider updates sequentially with controlled timestamps", async () => {
    const service = await startAcceptanceService();
    services.push(service);
    const socket = await service.connect();
    await socket.nextMessage();

    await service.setTime("2026-07-22T12:01:00.000Z");
    await service.pushChanges([
      {
        type: "resource.upsert",
        resource: {
          kind: "agent",
          id: "controlled-agent",
          providerId: "controlled",
          label: "Controlled agent",
          status: "waiting",
          createdAt: "2026-07-22T12:00:00.000Z",
          startedAt: "2026-07-22T12:00:00.000Z",
          updatedAt: "2026-07-22T12:01:00.000Z",
          attentionReason: "Needs approval",
        },
      },
    ]);
    const waiting = DashboardUpdateMessageSchema.parse(
      await socket.nextMessage(),
    );

    await service.setTime("2026-07-22T12:02:00.000Z");
    await service.pushChanges([
      {
        type: "resource.upsert",
        resource: {
          kind: "agent",
          id: "controlled-agent",
          providerId: "controlled",
          label: "Controlled agent",
          status: "completed",
          createdAt: "2026-07-22T12:00:00.000Z",
          startedAt: "2026-07-22T12:00:00.000Z",
          updatedAt: "2026-07-22T12:02:00.000Z",
          completedAt: "2026-07-22T12:02:00.000Z",
        },
      },
    ]);
    const completed = DashboardUpdateMessageSchema.parse(
      await socket.nextMessage(),
    );

    expect(waiting).toMatchObject({
      version: 2,
      generatedAt: "2026-07-22T12:01:00.000Z",
      changes: [
        {
          type: "resource.upsert",
          resource: { id: "controlled-agent", status: "waiting" },
        },
      ],
    });
    expect(completed).toMatchObject({
      version: 3,
      generatedAt: "2026-07-22T12:02:00.000Z",
      changes: [
        {
          type: "resource.upsert",
          resource: { id: "controlled-agent", status: "completed" },
        },
      ],
    });
  });

  it("does not advance the stream for a stale provider update", async () => {
    const service = await startAcceptanceService();
    services.push(service);
    const socket = await service.connect();
    await socket.nextMessage();

    await service.setTime("2026-07-22T12:01:00.000Z");
    await service.pushChanges([
      {
        type: "resource.upsert",
        resource: {
          kind: "agent",
          id: "controlled-agent",
          providerId: "controlled",
          label: "Controlled agent",
          status: "running",
          createdAt: "2026-07-22T12:00:00.000Z",
          startedAt: "2026-07-22T12:00:00.000Z",
          updatedAt: "2026-07-22T12:00:00.000Z",
        },
      },
    ]);
    await service.setTime("2026-07-22T12:02:00.000Z");
    await service.pushChanges([
      {
        type: "resource.upsert",
        resource: {
          kind: "agent",
          id: "controlled-agent",
          providerId: "controlled",
          label: "Controlled agent",
          status: "waiting",
          createdAt: "2026-07-22T12:00:00.000Z",
          startedAt: "2026-07-22T12:00:00.000Z",
          updatedAt: "2026-07-22T12:02:00.000Z",
          attentionReason: "Needs approval",
        },
      },
    ]);

    const message = DashboardUpdateMessageSchema.parse(
      await socket.nextMessage(),
    );
    expect(message).toMatchObject({
      version: 2,
      generatedAt: "2026-07-22T12:02:00.000Z",
      changes: [
        {
          type: "resource.upsert",
          resource: { status: "waiting" },
        },
      ],
    });
  });

  it("recovers current state in a fresh snapshot after reconnect", async () => {
    const service = await startAcceptanceService();
    services.push(service);
    const firstSocket = await service.connect();
    await firstSocket.nextMessage();
    await firstSocket.close();

    await service.setTime("2026-07-22T12:03:00.000Z");
    await service.pushChanges([
      {
        type: "resource.upsert",
        resource: {
          kind: "agent",
          id: "controlled-agent",
          providerId: "controlled",
          label: "Controlled agent",
          status: "waiting",
          createdAt: "2026-07-22T12:00:00.000Z",
          startedAt: "2026-07-22T12:00:00.000Z",
          updatedAt: "2026-07-22T12:03:00.000Z",
          attentionReason: "Needs approval",
        },
      },
    ]);

    const reconnected = await service.connect();
    const message = DashboardSnapshotMessageSchema.parse(
      await reconnected.nextMessage(),
    );
    expect(message.snapshot).toMatchObject({
      version: 2,
      generatedAt: "2026-07-22T12:03:00.000Z",
      resources: [
        {
          id: "controlled-agent",
          status: "waiting",
          attentionReason: "Needs approval",
        },
      ],
    });
  });

  it("publishes provider connectivity transitions", async () => {
    const service = await startAcceptanceService();
    services.push(service);
    const socket = await service.connect();
    await socket.nextMessage();

    const transitions = [
      ["connecting", "Reconnecting"],
      ["degraded", "Updates are delayed"],
      ["disconnected", "Provider unavailable"],
      ["connected", "Provider recovered"],
    ] as const;

    for (const [index, [connectivity, message]] of transitions.entries()) {
      const checkedAt = `2026-07-22T12:0${index + 1}:00.000Z`;
      await service.setTime(checkedAt);
      await service.pushChanges([
        {
          type: "provider.upsert",
          provider: {
            id: "controlled",
            connectivity,
            checkedAt,
            label: "Controlled provider",
            message,
          },
        },
      ]);

      const update = DashboardUpdateMessageSchema.parse(
        await socket.nextMessage(),
      );
      expect(update).toMatchObject({
        version: index + 2,
        generatedAt: checkedAt,
        changes: [
          {
            type: "provider.upsert",
            provider: { id: "controlled", connectivity, message },
          },
        ],
      });
    }
  });

  it("identifies the service and protocol at its real health endpoint", async () => {
    const service = await startAcceptanceService();
    services.push(service);

    const response = await fetch(`${service.baseUrl}health`);
    const health = HealthResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(health).toMatchObject({
      status: "ok",
      service: SERVICE_NAME,
      protocolVersion: PROTOCOL_VERSION,
      provider: "controlled",
      version: 1,
    });
  });

  it("closes consumer connections during graceful shutdown", async () => {
    const service = await startAcceptanceService();
    services.push(service);
    const socket = await service.connect();
    await socket.nextMessage();
    const closed = socket.closed();

    await service.stop();

    expect(await closed).toMatchObject({ code: 1000, wasClean: true });
    await expect(fetch(`${service.baseUrl}health`)).rejects.toThrow();
  });

  it("surfaces an abnormal provider failure as an abnormal process exit", async () => {
    const service = await startAcceptanceService();
    services.push(service);
    const socket = await service.connect();
    await socket.nextMessage();
    const closed = socket.closed();

    const exit = await service.failProvider("Controlled provider crashed");

    expect(exit).toEqual({ code: 1, signal: null });
    expect(await closed).toMatchObject({ code: 1006, wasClean: false });
    await expect(fetch(`${service.baseUrl}health`)).rejects.toThrow();
  });
});
