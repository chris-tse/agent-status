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

/**
 * Coordinates visible Agent Slot action instances. Existing assignments are
 * intentionally sticky; priority is consulted only when filling a vacancy.
 */
export class SlotPool {
  readonly #assignments = new Map<string, string | undefined>();

  register(slotId: string): void {
    if (!this.#assignments.has(slotId)) {
      this.#assignments.set(slotId, undefined);
    }
  }

  unregister(slotId: string): void {
    this.#assignments.delete(slotId);
  }

  assignmentFor(slotId: string): string | undefined {
    return this.#assignments.get(slotId);
  }

  reconcile(resources: readonly AgentResource[]): ReadonlyMap<string, string | undefined> {
    const resourceIds = new Set(resources.map((resource) => resource.id));

    for (const [slotId, resourceId] of this.#assignments) {
      if (resourceId !== undefined && !resourceIds.has(resourceId)) {
        this.#assignments.set(slotId, undefined);
      }
    }

    const assigned = new Set(
      [...this.#assignments.values()].filter(
        (resourceId): resourceId is string => resourceId !== undefined,
      ),
    );
    const candidates = resources
      .filter((resource) => !assigned.has(resource.id))
      .toSorted(compareCandidates);

    for (const [slotId, resourceId] of this.#assignments) {
      if (resourceId === undefined) {
        this.#assignments.set(slotId, candidates.shift()?.id);
      }
    }

    return new Map(this.#assignments);
  }
}
