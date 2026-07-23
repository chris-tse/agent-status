import {
  DashboardChangeSchema,
  DashboardSnapshotSchema,
  DashboardUpdateMessageSchema,
  type DashboardChange,
  type DashboardSnapshot,
  type DashboardUpdateMessage,
  type ProviderStatus,
  type StatefulResource,
  type StatusEvent,
} from "@status-dashboard/model";

import type { DashboardBroadcaster } from "./broadcast.js";

export type Clock = () => Date;

export interface DashboardState {
  providers: readonly ProviderStatus[];
  resources: readonly StatefulResource[];
  events: readonly StatusEvent[];
}

const systemClock: Clock = () => new Date();

function isEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class DashboardStore {
  readonly #providers = new Map<string, ProviderStatus>();
  readonly #resources = new Map<string, StatefulResource>();
  readonly #events = new Map<string, StatusEvent>();
  readonly #broadcaster: DashboardBroadcaster;
  readonly #clock: Clock;
  #version = 0;

  constructor(broadcaster: DashboardBroadcaster, clock: Clock = systemClock) {
    this.#broadcaster = broadcaster;
    this.#clock = clock;
  }

  get version(): number {
    return this.#version;
  }

  apply(changes: readonly DashboardChange[]): DashboardUpdateMessage | undefined {
    const validated = changes.map((change) => DashboardChangeSchema.parse(change));
    const providers = new Map(this.#providers);
    const resources = new Map(this.#resources);
    const events = new Map(this.#events);
    const effective: DashboardChange[] = [];

    for (const change of validated) {
      switch (change.type) {
        case "provider.upsert": {
          if (!isEqual(providers.get(change.provider.id), change.provider)) {
            providers.set(change.provider.id, change.provider);
            effective.push(change);
          }
          break;
        }
        case "provider.remove": {
          if (providers.delete(change.providerId)) {
            effective.push(change);
          }
          break;
        }
        case "resource.upsert": {
          if (!isEqual(resources.get(change.resource.id), change.resource)) {
            resources.set(change.resource.id, change.resource);
            effective.push(change);
          }
          break;
        }
        case "resource.remove": {
          if (resources.delete(change.resourceId)) {
            effective.push(change);
          }
          break;
        }
        case "event.upsert": {
          if (!isEqual(events.get(change.event.id), change.event)) {
            events.set(change.event.id, change.event);
            effective.push(change);
          }
          break;
        }
        case "event.remove": {
          if (events.delete(change.eventId)) {
            effective.push(change);
          }
          break;
        }
      }
    }

    this.#validateReferences(providers, resources, events);

    if (effective.length === 0) {
      return undefined;
    }

    this.#providers.clear();
    this.#resources.clear();
    this.#events.clear();
    for (const [id, provider] of providers) this.#providers.set(id, provider);
    for (const [id, resource] of resources) this.#resources.set(id, resource);
    for (const [id, event] of events) this.#events.set(id, event);

    this.#version += 1;
    const message = DashboardUpdateMessageSchema.parse({
      type: "update",
      version: this.#version,
      generatedAt: this.#clock().toISOString(),
      changes: effective,
    });
    this.#broadcaster.publish(message);
    return message;
  }

  replace(state: DashboardState): DashboardUpdateMessage | undefined {
    const desired = DashboardSnapshotSchema.parse({
      version: this.#version,
      generatedAt: this.#clock().toISOString(),
      providers: state.providers,
      resources: state.resources,
      events: state.events,
    });
    const providerIds = new Set(desired.providers.map(({ id }) => id));
    const resourceIds = new Set(desired.resources.map(({ id }) => id));
    const eventIds = new Set(desired.events.map(({ id }) => id));
    const changes: DashboardChange[] = [];

    for (const id of this.#events.keys()) {
      if (!eventIds.has(id)) changes.push({ type: "event.remove", eventId: id });
    }
    for (const id of this.#resources.keys()) {
      if (!resourceIds.has(id)) {
        changes.push({ type: "resource.remove", resourceId: id });
      }
    }
    for (const id of this.#providers.keys()) {
      if (!providerIds.has(id)) {
        changes.push({ type: "provider.remove", providerId: id });
      }
    }
    for (const provider of desired.providers) {
      changes.push({ type: "provider.upsert", provider });
    }
    for (const resource of desired.resources) {
      changes.push({ type: "resource.upsert", resource });
    }
    for (const event of desired.events) {
      changes.push({ type: "event.upsert", event });
    }

    return this.apply(changes);
  }

  pruneExpired(at: Date = this.#clock()): DashboardUpdateMessage | undefined {
    const timestamp = at.getTime();
    const changes: DashboardChange[] = [];

    for (const event of this.#events.values()) {
      if (event.expiresAt !== undefined && Date.parse(event.expiresAt) <= timestamp) {
        changes.push({ type: "event.remove", eventId: event.id });
      }
    }

    return this.apply(changes);
  }

  snapshot(at: Date = this.#clock()): DashboardSnapshot {
    this.pruneExpired(at);
    return DashboardSnapshotSchema.parse({
      version: this.#version,
      generatedAt: at.toISOString(),
      providers: [...this.#providers.values()],
      resources: [...this.#resources.values()],
      events: [...this.#events.values()],
    });
  }

  #validateReferences(
    providers: ReadonlyMap<string, ProviderStatus>,
    resources: ReadonlyMap<string, StatefulResource>,
    events: ReadonlyMap<string, StatusEvent>,
  ): void {
    for (const resource of resources.values()) {
      if (!providers.has(resource.providerId)) {
        throw new Error(
          `Resource ${resource.id} references unknown provider ${resource.providerId}`,
        );
      }
    }

    for (const event of events.values()) {
      if (event.providerId !== undefined && !providers.has(event.providerId)) {
        throw new Error(`Event ${event.id} references unknown provider ${event.providerId}`);
      }
      if (event.resourceId !== undefined && !resources.has(event.resourceId)) {
        throw new Error(`Event ${event.id} references unknown resource ${event.resourceId}`);
      }
    }
  }
}
