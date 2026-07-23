import type {
  AgentResource,
  DashboardChange,
  DashboardUpdateMessage,
} from "@status-dashboard/model";
import { describe, expect, it } from "vitest";

import { SubscriptionBroadcaster } from "../src/broadcast.js";
import { DashboardStore } from "../src/store.js";

const INITIAL_TIME = new Date("2026-07-19T07:00:00.000Z");

const baseResource: AgentResource = {
  kind: "agent",
  id: "agent-stable",
  providerId: "provider-1",
  label: "Stable agent",
  status: "running",
  createdAt: "2026-07-19T06:55:00.000Z",
  startedAt: "2026-07-19T06:56:00.000Z",
  updatedAt: INITIAL_TIME.toISOString(),
};

function baseChanges(): DashboardChange[] {
  return [
    {
      type: "provider.upsert",
      provider: {
        id: "provider-1",
        connectivity: "connected",
        checkedAt: INITIAL_TIME.toISOString(),
      },
    },
    {
      type: "resource.upsert",
      resource: baseResource,
    },
  ];
}

describe("DashboardStore", () => {
  it("validates writes and emits monotonically versioned updates", () => {
    const broadcaster = new SubscriptionBroadcaster();
    const messages: DashboardUpdateMessage[] = [];
    broadcaster.subscribe((message) => {
      if (message.type === "update") messages.push(message);
    });
    const store = new DashboardStore(broadcaster, () => INITIAL_TIME);

    store.apply(baseChanges());
    expect(store.version).toBe(1);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.version).toBe(1);

    store.apply(baseChanges());
    expect(store.version).toBe(1);
    expect(messages).toHaveLength(1);

    store.apply([
      {
        type: "resource.upsert",
        resource: {
          ...baseResource,
          status: "waiting",
          attentionReason: "Needs input",
        },
      },
    ]);

    const snapshot = store.snapshot();
    expect(store.version).toBe(2);
    expect(messages[1]?.version).toBe(2);
    expect(snapshot.resources[0]?.id).toBe("agent-stable");
    expect(snapshot.resources[0]?.status).toBe("waiting");
  });

  it("rejects invalid model writes without changing state", () => {
    const store = new DashboardStore(new SubscriptionBroadcaster(), () => INITIAL_TIME);
    store.apply(baseChanges());

    expect(() =>
      store.apply([
        {
          type: "resource.upsert",
          resource: {
            kind: "agent",
            id: "invalid",
            providerId: "provider-1",
            status: "running",
            createdAt: INITIAL_TIME.toISOString(),
            updatedAt: "2026-07-19T06:00:00.000Z",
          },
        },
      ]),
    ).toThrow();
    expect(store.version).toBe(1);
    expect(store.snapshot().resources.map(({ id }) => id)).toEqual(["agent-stable"]);
  });

  it("prunes expired events and broadcasts their removal", () => {
    const broadcaster = new SubscriptionBroadcaster();
    const messages: DashboardUpdateMessage[] = [];
    broadcaster.subscribe((message) => {
      if (message.type === "update") messages.push(message);
    });
    const store = new DashboardStore(broadcaster, () => INITIAL_TIME);
    store.apply([
      ...baseChanges(),
      {
        type: "event.upsert",
        event: {
          id: "event-expiring",
          type: "agent.notice",
          severity: "info",
          message: "Short-lived event",
          occurredAt: INITIAL_TIME.toISOString(),
          expiresAt: "2026-07-19T07:01:00.000Z",
          providerId: "provider-1",
          resourceId: "agent-stable",
        },
      },
    ]);

    const beforeExpiry = store.snapshot(new Date("2026-07-19T07:00:59.999Z"));
    expect(beforeExpiry.events).toHaveLength(1);

    const afterExpiry = store.snapshot(new Date("2026-07-19T07:01:00.000Z"));
    expect(afterExpiry.events).toHaveLength(0);
    expect(afterExpiry.version).toBe(2);
    expect(messages[1]?.changes).toEqual([{ type: "event.remove", eventId: "event-expiring" }]);
  });
});
