import { describe, expect, it } from "vitest";

import { SubscriptionBroadcaster } from "../src/broadcast.js";
import { DemoController } from "../src/demo-controller.js";
import {
  demoResourceIds,
  SimulatedStatusProvider,
} from "../src/simulated-provider.js";
import { DashboardStore } from "../src/store.js";

describe("simulated provider progression", () => {
  it("seeds every useful state and advances a stable resource deterministically", () => {
    let now = new Date("2026-07-19T07:00:00.000Z");
    const clock = () => now;
    const store = new DashboardStore(new SubscriptionBroadcaster(), clock);
    const demo = new DemoController(
      store,
      new SimulatedStatusProvider(),
      clock,
    );

    const seeded = demo.reset();
    expect(seeded.version).toBe(1);
    expect(seeded.providers).toMatchObject([
      { id: "demo", connectivity: "connected" },
    ]);
    expect(seeded.resources.map(({ status }) => status).sort()).toEqual([
      "completed",
      "failed",
      "running",
      "waiting",
    ]);
    const stableIds = seeded.resources.map(({ id }) => id).sort();

    const expectedStatuses = [
      "waiting",
      "running",
      "completed",
      "failed",
      "running",
    ] as const;

    for (const [index, status] of expectedStatuses.entries()) {
      now = new Date(now.getTime() + 1_000);
      const result = demo.advance();
      const live = result.snapshot.resources.find(
        ({ id }) => id === demoResourceIds.live,
      );

      expect(live?.status).toBe(status);
      expect(result.snapshot.resources.map(({ id }) => id).sort()).toEqual(
        stableIds,
      );
      expect(result.snapshot.version).toBe(index + 2);
      expect(
        result.snapshot.events.some(
          ({ resourceId }) => resourceId === demoResourceIds.live,
        ),
      ).toBe(true);
    }
  });

  it("resets progression while preserving resource identifiers", () => {
    let now = new Date("2026-07-19T07:00:00.000Z");
    const clock = () => now;
    const store = new DashboardStore(new SubscriptionBroadcaster(), clock);
    const demo = new DemoController(
      store,
      new SimulatedStatusProvider(),
      clock,
    );

    const initialIds = demo
      .reset()
      .resources.map(({ id }) => id)
      .sort();
    now = new Date("2026-07-19T07:01:00.000Z");
    demo.advance();
    now = new Date("2026-07-19T07:02:00.000Z");
    const reset = demo.reset();

    expect(reset.resources.map(({ id }) => id).sort()).toEqual(initialIds);
    expect(
      reset.resources.find(({ id }) => id === demoResourceIds.live)?.status,
    ).toBe("running");
    expect(reset.events.map(({ id }) => id).sort()).toEqual([
      "demo-event-seed-failed",
      "demo-event-seed-waiting",
    ]);
    expect(reset.version).toBe(3);
  });
});
