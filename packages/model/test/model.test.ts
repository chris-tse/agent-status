import { describe, expect, it } from "vitest";

import {
  AgentResourceSchema,
  DashboardSnapshotSchema,
  DashboardWireMessageSchema,
  StatusEventSchema,
  classifyAgentStatus,
} from "../src/index.js";

const now = "2026-07-19T07:00:00.000Z";

describe("dashboard model validation", () => {
  it("accepts a JSON-safe dashboard snapshot", () => {
    const result = DashboardSnapshotSchema.safeParse({
      version: 3,
      generatedAt: now,
      providers: [
        {
          id: "cursor",
          connectivity: "connected",
          checkedAt: now,
          label: "Cursor",
        },
      ],
      resources: [
        {
          kind: "agent",
          id: "agent-42",
          providerId: "cursor",
          workspaceId: "status-dashboard",
          label: "Foundation worker",
          status: "running",
          createdAt: "2026-07-19T06:55:00.000Z",
          updatedAt: now,
        },
      ],
      events: [],
    });

    expect(result.success).toBe(true);
  });

  it("rejects inconsistent resource timestamps", () => {
    const result = AgentResourceSchema.safeParse({
      kind: "agent",
      id: "agent-42",
      providerId: "cursor",
      status: "completed",
      createdAt: now,
      updatedAt: "2026-07-19T06:59:00.000Z",
      completedAt: "2026-07-19T06:58:00.000Z",
    });

    expect(result.success).toBe(false);
  });

  it("rejects an event that expires before it occurs", () => {
    const result = StatusEventSchema.safeParse({
      id: "event-7",
      type: "attention-required",
      severity: "warning",
      message: "Agent is waiting for input",
      occurredAt: now,
      expiresAt: "2026-07-19T06:59:00.000Z",
      resourceId: "agent-42",
    });

    expect(result.success).toBe(false);
  });

  it("validates incremental WebSocket messages", () => {
    const result = DashboardWireMessageSchema.safeParse({
      type: "update",
      version: 4,
      generatedAt: now,
      changes: [
        {
          type: "resource.remove",
          resourceId: "agent-42",
        },
      ],
    });

    expect(result.success).toBe(true);
  });
});

describe("agent status classification", () => {
  it.each([
    ["running", "active"],
    ["waiting", "attention"],
    ["completed", "success"],
    ["failed", "error"],
  ] as const)("classifies %s as %s", (status, classification) => {
    expect(classifyAgentStatus(status)).toBe(classification);
  });
});
