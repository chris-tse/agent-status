import type {
  DashboardChange,
  DashboardSnapshot,
  DashboardWireMessage,
} from "@status-dashboard/model";

export type SnapshotReduction = {
  snapshot: DashboardSnapshot | null;
  shouldRefetch: boolean;
};

function upsertById<T extends { id: string }>(items: T[], value: T): T[] {
  const index = items.findIndex((item) => item.id === value.id);

  if (index === -1) {
    return [...items, value];
  }

  const next = [...items];
  next[index] = value;
  return next;
}

function removeById<T extends { id: string }>(items: T[], id: string): T[] {
  return items.filter((item) => item.id !== id);
}

function applyChange(
  snapshot: DashboardSnapshot,
  change: DashboardChange,
): DashboardSnapshot {
  switch (change.type) {
    case "provider.upsert":
      return {
        ...snapshot,
        providers: upsertById(snapshot.providers, change.provider),
      };
    case "provider.remove":
      return {
        ...snapshot,
        providers: removeById(snapshot.providers, change.providerId),
      };
    case "resource.upsert":
      return {
        ...snapshot,
        resources: upsertById(snapshot.resources, change.resource),
      };
    case "resource.remove":
      return {
        ...snapshot,
        resources: removeById(snapshot.resources, change.resourceId),
      };
    case "event.upsert":
      return {
        ...snapshot,
        events: upsertById(snapshot.events, change.event),
      };
    case "event.remove":
      return {
        ...snapshot,
        events: removeById(snapshot.events, change.eventId),
      };
  }
}

export function reduceWireMessage(
  current: DashboardSnapshot | null,
  message: DashboardWireMessage,
): SnapshotReduction {
  if (message.type === "snapshot") {
    return { snapshot: message.snapshot, shouldRefetch: false };
  }

  if (message.type === "reset") {
    return { snapshot: current, shouldRefetch: true };
  }

  if (current === null) {
    return { snapshot: null, shouldRefetch: true };
  }

  // Replayed updates can arrive after a reconnect snapshot and are safe to ignore.
  if (message.version <= current.version) {
    return { snapshot: current, shouldRefetch: false };
  }

  if (message.version !== current.version + 1) {
    return { snapshot: current, shouldRefetch: true };
  }

  const updated = message.changes.reduce(applyChange, {
    ...current,
    version: message.version,
    generatedAt: message.generatedAt,
  });

  return { snapshot: updated, shouldRefetch: false };
}
