import { DashboardWireMessageSchema, type AgentLifecycleStatus } from "@status-dashboard/model";
import { describe, expect, it } from "vitest";

import { WireState, WireVersionError } from "../src/wire-state.js";

const timestamp = "2026-07-19T00:00:00.000Z";

function resource(id: string, status: AgentLifecycleStatus) {
  return {
    kind: "agent" as const,
    id,
    providerId: "cursor",
    label: id,
    status,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function snapshot(version: number, ids: readonly string[]) {
  return DashboardWireMessageSchema.parse({
    type: "snapshot",
    snapshot: {
      version,
      generatedAt: timestamp,
      providers: [],
      resources: ids.map((id) => resource(id, "running")),
      events: [],
    },
  });
}

describe("WireState", () => {
  it("replaces state with an authoritative snapshot", () => {
    const state = new WireState();
    state.apply(snapshot(4, ["one", "two"]));
    state.apply(snapshot(9, ["three"]));

    expect(state.version).toBe(9);
    expect(state.resources.map(({ id }) => id)).toEqual(["three"]);
  });

  it("applies sequential updates and removals", () => {
    const state = new WireState();
    state.apply(snapshot(1, ["one"]));

    state.apply(
      DashboardWireMessageSchema.parse({
        type: "update",
        version: 2,
        generatedAt: timestamp,
        changes: [
          { type: "resource.remove", resourceId: "one" },
          {
            type: "resource.upsert",
            resource: resource("two", "waiting"),
          },
        ],
      }),
    );

    expect(state.version).toBe(2);
    expect(state.resources).toEqual([resource("two", "waiting")]);
  });

  it("ignores stale updates", () => {
    const state = new WireState();
    state.apply(snapshot(3, ["one"]));

    const changed = state.apply(
      DashboardWireMessageSchema.parse({
        type: "update",
        version: 3,
        generatedAt: timestamp,
        changes: [{ type: "resource.remove", resourceId: "one" }],
      }),
    );

    expect(changed).toBe(false);
    expect(state.resources).toHaveLength(1);
  });

  it("rejects a version gap without mutating state", () => {
    const state = new WireState();
    state.apply(snapshot(2, ["one"]));

    expect(() =>
      state.apply(
        DashboardWireMessageSchema.parse({
          type: "update",
          version: 4,
          generatedAt: timestamp,
          changes: [{ type: "resource.remove", resourceId: "one" }],
        }),
      ),
    ).toThrow(WireVersionError);
    expect(state.version).toBe(2);
    expect(state.resources.map(({ id }) => id)).toEqual(["one"]);
  });

  it("clears resources and version on reset", () => {
    const state = new WireState();
    state.apply(snapshot(1, ["one"]));
    state.apply(
      DashboardWireMessageSchema.parse({
        type: "reset",
        generatedAt: timestamp,
        reason: "service restarted",
      }),
    );

    expect(state.version).toBeUndefined();
    expect(state.resources).toEqual([]);
  });
});
