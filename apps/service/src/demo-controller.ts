import type { DashboardSnapshot } from "@status-dashboard/model";

import type { StatusProvider } from "./provider.js";
import { type Clock, DashboardStore } from "./store.js";

export interface DemoAdvanceResult {
  transition: string;
  snapshot: DashboardSnapshot;
}

export class DemoController {
  readonly #store: DashboardStore;
  readonly #provider: StatusProvider;
  readonly #clock: Clock;

  constructor(
    store: DashboardStore,
    provider: StatusProvider,
    clock: Clock = () => new Date(),
  ) {
    this.#store = store;
    this.#provider = provider;
    this.#clock = clock;
  }

  reset(): DashboardSnapshot {
    const now = this.#clock();
    this.#store.replace(this.#provider.reset(now));
    return this.#store.snapshot(now);
  }

  advance(): DemoAdvanceResult {
    const now = this.#clock();
    const current = this.#store.snapshot(now);
    const progression = this.#provider.advance(current, now);
    this.#store.apply(progression.changes);

    return {
      transition: progression.description,
      snapshot: this.#store.snapshot(now),
    };
  }
}
