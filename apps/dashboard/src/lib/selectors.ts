import type { DashboardSnapshot, ProviderStatus, StatefulResource } from "@status-dashboard/model";

/**
 * The compact dashboard reduces the wire model's four lifecycle states to the
 * three states that matter at a glance.
 */
export type DisplayStatus = "running" | "blocked" | "done";

export function displayStatus(agent: StatefulResource): DisplayStatus {
  switch (agent.status) {
    case "running":
      return "running";
    case "waiting":
    case "failed":
      return "blocked";
    case "completed":
      return "done";
  }
}

const displayRank: Record<DisplayStatus, number> = {
  blocked: 0,
  running: 1,
  done: 2,
};

/** Orders attention-needing agents first and the freshest agent first per group. */
export function orderedAgents(snapshot: DashboardSnapshot): StatefulResource[] {
  return [...snapshot.resources].sort((a, b) => {
    const rank = displayRank[displayStatus(a)] - displayRank[displayStatus(b)];
    if (rank !== 0) return rank;
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });
}

export type StatusCounts = Record<DisplayStatus, number>;

export function countByStatus(snapshot: DashboardSnapshot): StatusCounts {
  const counts: StatusCounts = { running: 0, blocked: 0, done: 0 };
  for (const resource of snapshot.resources) {
    counts[displayStatus(resource)] += 1;
  }
  return counts;
}

/** Providers that are not cleanly connected, for exception-only reporting. */
export function troubledProviders(snapshot: DashboardSnapshot): ProviderStatus[] {
  return snapshot.providers.filter((provider) => provider.connectivity !== "connected");
}
