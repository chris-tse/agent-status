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
 * Messages emitted by a provider. A replacement establishes provider-owned
 * state after startup; incremental changes preserve unrelated store state.
 */
export type ProviderMessage =
  | { type: "replace"; state: DashboardState }
  | { type: "changes"; changes: readonly DashboardChange[] };

export type ProviderListener = (message: ProviderMessage) => void;

export interface ProviderConnection {
  close(): void;
}

/**
 * Seam implemented by each live status source. Transport, reconnection, source
 * validation, and normalization stay behind this small interface.
 */
export interface StatusProvider {
  readonly id: ProviderId;
  open(listener: ProviderListener): ProviderConnection;
}

/** Extra controls exposed only by the deterministic development provider. */
export interface DemoStatusProvider extends StatusProvider {
  reset(now: Date): DashboardState;
  advance(snapshot: DashboardSnapshot, now: Date): ProviderAdvance;
}

export function isDemoStatusProvider(
  provider: StatusProvider,
): provider is DemoStatusProvider {
  return "reset" in provider && "advance" in provider;
}
