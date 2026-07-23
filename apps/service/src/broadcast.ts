import { DashboardWireMessageSchema, type DashboardWireMessage } from "@status-dashboard/model";

export type BroadcastListener = (message: DashboardWireMessage) => void;

export interface DashboardBroadcaster {
  publish(message: DashboardWireMessage): void;
}

export class SubscriptionBroadcaster implements DashboardBroadcaster {
  readonly #listeners = new Set<BroadcastListener>();

  publish(message: DashboardWireMessage): void {
    const validated = DashboardWireMessageSchema.parse(message);

    for (const listener of this.#listeners) {
      listener(validated);
    }
  }

  subscribe(listener: BroadcastListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}
