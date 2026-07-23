import { HealthResponseSchema, PROTOCOL_VERSION, SERVICE_NAME } from "@status-dashboard/model";
import { describe, expect, it } from "vitest";

import { SubscriptionBroadcaster } from "../src/broadcast.js";
import { loadConfig } from "../src/config.js";
import type { StatusProvider } from "../src/provider.js";
import { handleStatusRequest, type RequestContext } from "../src/server.js";
import { DashboardStore } from "../src/store.js";

function createContext(overrides: { providerId?: string } = {}): RequestContext {
  const clock = () => new Date("2026-07-22T00:00:00.000Z");
  const provider: StatusProvider = {
    id: overrides.providerId ?? "demo",
    open: () => ({ close() {} }),
  };
  return {
    config: loadConfig({}),
    store: new DashboardStore(new SubscriptionBroadcaster(), clock),
    provider,
    demo: undefined,
    clock,
  };
}

async function getHealth(context: RequestContext): Promise<{
  status: number;
  body: unknown;
}> {
  const response = handleStatusRequest(new Request("http://127.0.0.1/health"), context);
  if (response === undefined) {
    throw new Error("Expected /health to return a response");
  }
  return { status: response.status, body: await response.json() };
}

/**
 * A probe classifies an endpoint the way a lifecycle control or consumer would:
 * from the health payload alone, without reaching into service internals.
 */
function classifyEndpoint(payload: unknown): string {
  const parsed = HealthResponseSchema.safeParse(payload);
  if (!parsed.success || parsed.data.service !== SERVICE_NAME) {
    return "unrelated";
  }
  if (parsed.data.protocolVersion !== PROTOCOL_VERSION) {
    return "incompatible";
  }
  return "compatible";
}

describe("GET /health", () => {
  it("identifies the application and protocol version", async () => {
    const { status, body } = await getHealth(createContext());

    expect(status).toBe(200);
    expect(body).toMatchObject({
      service: SERVICE_NAME,
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(typeof (body as { protocolVersion: unknown }).protocolVersion).toBe("number");
  });

  it("keeps the existing fields so current consumers are unaffected", async () => {
    const { body } = await getHealth(createContext({ providerId: "herdr" }));

    expect(body).toMatchObject({
      status: "ok",
      version: 0,
      provider: "herdr",
    });
  });

  it("lets a probe distinguish compatible, incompatible, and unrelated endpoints", async () => {
    const { body } = await getHealth(createContext());

    expect(classifyEndpoint(body)).toBe("compatible");

    expect(
      classifyEndpoint({
        ...(body as Record<string, unknown>),
        protocolVersion: PROTOCOL_VERSION + 1,
      }),
    ).toBe("incompatible");

    expect(classifyEndpoint({ status: "ok", message: "some other server" })).toBe("unrelated");
  });
});
