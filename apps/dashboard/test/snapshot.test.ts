import {
  DashboardSnapshotSchema,
  DashboardWireMessageSchema,
} from "@status-dashboard/model";
import { describe, expect, it } from "vitest";

import { reduceWireMessage } from "../src/snapshot";

const now = "2026-07-19T07:00:00.000Z";

const snapshot = DashboardSnapshotSchema.parse({
  version: 4,
  generatedAt: now,
  providers: [
    {
      id: "cursor",
      label: "Cursor",
      connectivity: "connected",
      checkedAt: now,
    },
  ],
  resources: [
    {
      kind: "agent",
      id: "agent-1",
      providerId: "cursor",
      label: "Dashboard worker",
      status: "running",
      createdAt: "2026-07-19T06:55:00.000Z",
      updatedAt: now,
    },
  ],
  events: [],
});

describe("reduceWireMessage", () => {
  it("applies a sequential update without changing stable item positions", () => {
    const message = DashboardWireMessageSchema.parse({
      type: "update",
      version: 5,
      generatedAt: "2026-07-19T07:01:00.000Z",
      changes: [
        {
          type: "resource.upsert",
          resource: {
            ...snapshot.resources[0],
            status: "waiting",
            attentionReason: "Approve the browser login",
            updatedAt: "2026-07-19T07:01:00.000Z",
          },
        },
        {
          type: "event.upsert",
          event: {
            id: "event-1",
            type: "agent.waiting",
            severity: "warning",
            message: "Dashboard worker needs input",
            occurredAt: "2026-07-19T07:01:00.000Z",
            resourceId: "agent-1",
          },
        },
      ],
    });

    const result = reduceWireMessage(snapshot, message);

    expect(result.shouldRefetch).toBe(false);
    expect(result.snapshot?.version).toBe(5);
    expect(result.snapshot?.resources[0]).toMatchObject({
      id: "agent-1",
      status: "waiting",
    });
    expect(result.snapshot?.events).toHaveLength(1);
  });

  it("requests a snapshot for version gaps and reset messages", () => {
    const gap = DashboardWireMessageSchema.parse({
      type: "update",
      version: 7,
      generatedAt: "2026-07-19T07:02:00.000Z",
      changes: [{ type: "resource.remove", resourceId: "agent-1" }],
    });
    const reset = DashboardWireMessageSchema.parse({
      type: "reset",
      generatedAt: "2026-07-19T07:02:00.000Z",
      reason: "Demo reset",
    });

    expect(reduceWireMessage(snapshot, gap)).toEqual({
      snapshot,
      shouldRefetch: true,
    });
    expect(reduceWireMessage(snapshot, reset)).toEqual({
      snapshot,
      shouldRefetch: true,
    });
  });

  it("ignores replayed updates and refetches when no snapshot exists", () => {
    const replay = DashboardWireMessageSchema.parse({
      type: "update",
      version: 4,
      generatedAt: now,
      changes: [{ type: "resource.remove", resourceId: "agent-1" }],
    });

    expect(reduceWireMessage(snapshot, replay)).toEqual({
      snapshot,
      shouldRefetch: false,
    });
    expect(reduceWireMessage(null, replay)).toEqual({
      snapshot: null,
      shouldRefetch: true,
    });
  });
});
