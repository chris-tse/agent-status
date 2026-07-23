import type { AgentLifecycleStatus, AgentResource } from "@status-dashboard/model";

const priority: Record<AgentLifecycleStatus, number> = {
  waiting: 0,
  failed: 0,
  running: 1,
  completed: 2,
};

function compareCandidates(left: AgentResource, right: AgentResource): number {
  const rank = priority[left.status] - priority[right.status];
  if (rank !== 0) {
    return rank;
  }

  const leftTime = Date.parse(left.completedAt ?? left.updatedAt);
  const rightTime = Date.parse(right.completedAt ?? right.updatedAt);
  return rightTime - leftTime || left.id.localeCompare(right.id);
}

export interface SlotPosition {
  readonly deviceId: string;
  readonly row: number;
  readonly column: number;
}

interface Slot {
  readonly position: SlotPosition | undefined;
  resourceId: string | undefined;
}

function compareSlots(
  [leftId, left]: readonly [string, Slot],
  [rightId, right]: readonly [string, Slot],
): number {
  if (left.position === undefined || right.position === undefined) {
    return left.position === undefined ? (right.position === undefined ? 0 : 1) : -1;
  }

  return (
    left.position.deviceId.localeCompare(right.position.deviceId) ||
    left.position.row - right.position.row ||
    left.position.column - right.position.column ||
    leftId.localeCompare(rightId)
  );
}

/**
 * Coordinates visible Agent Slot action instances. Assignments are spatially
 * ordered when slots appear, then remain sticky while the layout is stable.
 * Priority is consulted only when filling a vacancy.
 */
export class SlotPool {
  readonly #slots = new Map<string, Slot>();

  register(slotId: string, position?: SlotPosition): void {
    if (this.#slots.has(slotId)) {
      return;
    }

    const assignedResources = this.#orderedSlots()
      .map(([, slot]) => slot.resourceId)
      .filter((resourceId): resourceId is string => resourceId !== undefined);

    this.#slots.set(slotId, { position, resourceId: undefined });
    for (const [, slot] of this.#orderedSlots()) {
      slot.resourceId = assignedResources.shift();
    }
  }

  unregister(slotId: string): void {
    this.#slots.delete(slotId);
  }

  assignmentFor(slotId: string): string | undefined {
    return this.#slots.get(slotId)?.resourceId;
  }

  reconcile(resources: readonly AgentResource[]): ReadonlyMap<string, string | undefined> {
    const resourceIds = new Set(resources.map((resource) => resource.id));

    for (const slot of this.#slots.values()) {
      if (slot.resourceId !== undefined && !resourceIds.has(slot.resourceId)) {
        slot.resourceId = undefined;
      }
    }

    const assigned = new Set(
      [...this.#slots.values()]
        .map(({ resourceId }) => resourceId)
        .filter((resourceId): resourceId is string => resourceId !== undefined),
    );
    const candidates = resources
      .filter((resource) => !assigned.has(resource.id))
      .toSorted(compareCandidates);

    for (const [, slot] of this.#orderedSlots()) {
      if (slot.resourceId === undefined) {
        slot.resourceId = candidates.shift()?.id;
      }
    }

    return new Map([...this.#slots].map(([slotId, slot]) => [slotId, slot.resourceId]));
  }

  #orderedSlots(): [string, Slot][] {
    return [...this.#slots].toSorted(compareSlots);
  }
}
