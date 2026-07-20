import type { AgentLifecycleStatus, AgentResource } from "@status-dashboard/model";
import { describe, expect, it } from "vitest";

import { SlotPool } from "../src/slot-pool.js";

const baseTime = "2026-07-19T00:00:00.000Z";

function agent(
  id: string,
  status: AgentLifecycleStatus,
  updatedAt = baseTime,
): AgentResource {
  return {
    kind: "agent",
    id,
    providerId: "cursor",
    label: id,
    status,
    createdAt: baseTime,
    updatedAt,
    ...(status === "completed" ? { completedAt: updatedAt } : {}),
  };
}

describe("SlotPool", () => {
  it("fills vacant slots by attention, running, then completed priority", () => {
    const pool = new SlotPool();
    pool.register("slot-1");
    pool.register("slot-2");
    pool.register("slot-3");

    pool.reconcile([
      agent("finished", "completed"),
      agent("active", "running"),
      agent("blocked", "waiting"),
    ]);

    expect(pool.assignmentFor("slot-1")).toBe("blocked");
    expect(pool.assignmentFor("slot-2")).toBe("active");
    expect(pool.assignmentFor("slot-3")).toBe("finished");
  });

  it("does not reorder existing resources when priorities change", () => {
    const pool = new SlotPool();
    pool.register("slot-1");
    pool.register("slot-2");
    pool.reconcile([agent("one", "running"), agent("two", "completed")]);

    pool.reconcile([
      agent("one", "completed"),
      agent("two", "failed"),
      agent("three", "waiting"),
    ]);

    expect(pool.assignmentFor("slot-1")).toBe("one");
    expect(pool.assignmentFor("slot-2")).toBe("two");
  });

  it("releases removed resources and fills the vacancy with the best candidate", () => {
    const pool = new SlotPool();
    pool.register("slot-1");
    pool.register("slot-2");
    pool.reconcile([agent("one", "running"), agent("two", "completed")]);

    pool.reconcile([agent("two", "completed"), agent("three", "failed")]);

    expect(pool.assignmentFor("slot-1")).toBe("three");
    expect(pool.assignmentFor("slot-2")).toBe("two");
  });

  it("selects the most recently completed resource first", () => {
    const pool = new SlotPool();
    pool.register("slot-1");
    pool.reconcile([
      agent("older", "completed", "2026-07-19T00:01:00.000Z"),
      agent("newer", "completed", "2026-07-19T00:02:00.000Z"),
    ]);

    expect(pool.assignmentFor("slot-1")).toBe("newer");
  });
});
