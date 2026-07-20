import type {
  DashboardChange,
  DashboardSnapshot,
  ProviderId,
} from "@status-dashboard/model";

import type { DashboardState } from "./store.js";

export interface ProviderAdvance {
  description: string;
  changes: readonly DashboardChange[];
}

/**
 * Boundary implemented by a status source. A Herdr adapter can replace the
 * simulator by producing the same model state and changes.
 */
export interface StatusProvider {
  readonly id: ProviderId;
  reset(now: Date): DashboardState;
  advance(snapshot: DashboardSnapshot, now: Date): ProviderAdvance;
}
