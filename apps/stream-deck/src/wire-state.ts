import type {
  AgentResource,
  DashboardChange,
  DashboardWireMessage,
  ProviderStatus,
  StatusEvent,
} from "@status-dashboard/model";

export class WireVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WireVersionError";
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported dashboard change: ${JSON.stringify(value)}`);
}

export class WireState {
  #version: number | undefined;
  #resources = new Map<string, AgentResource>();
  #providers = new Map<string, ProviderStatus>();
  #events = new Map<string, StatusEvent>();

  get version(): number | undefined {
    return this.#version;
  }

  get resources(): readonly AgentResource[] {
    return [...this.#resources.values()];
  }

  apply(message: DashboardWireMessage): boolean {
    switch (message.type) {
      case "snapshot":
        this.#version = message.snapshot.version;
        this.#resources = new Map(
          message.snapshot.resources.map((resource) => [resource.id, resource]),
        );
        this.#providers = new Map(
          message.snapshot.providers.map((provider) => [provider.id, provider]),
        );
        this.#events = new Map(
          message.snapshot.events.map((event) => [event.id, event]),
        );
        return true;

      case "reset":
        this.clear();
        return true;

      case "update":
        if (this.#version === undefined) {
          throw new WireVersionError("Received an update before a snapshot");
        }
        if (message.version <= this.#version) {
          return false;
        }
        if (message.version !== this.#version + 1) {
          throw new WireVersionError(
            `Dashboard version gap: expected ${this.#version + 1}, received ${message.version}`,
          );
        }

        this.applyChanges(message.changes);
        this.#version = message.version;
        return true;
    }
  }

  clear(): void {
    this.#version = undefined;
    this.#resources.clear();
    this.#providers.clear();
    this.#events.clear();
  }

  private applyChanges(changes: readonly DashboardChange[]): void {
    const resources = new Map(this.#resources);
    const providers = new Map(this.#providers);
    const events = new Map(this.#events);

    for (const change of changes) {
      switch (change.type) {
        case "resource.upsert":
          resources.set(change.resource.id, change.resource);
          break;
        case "resource.remove":
          resources.delete(change.resourceId);
          break;
        case "provider.upsert":
          providers.set(change.provider.id, change.provider);
          break;
        case "provider.remove":
          providers.delete(change.providerId);
          break;
        case "event.upsert":
          events.set(change.event.id, change.event);
          break;
        case "event.remove":
          events.delete(change.eventId);
          break;
        default:
          assertNever(change);
      }
    }

    this.#resources = resources;
    this.#providers = providers;
    this.#events = events;
  }
}
