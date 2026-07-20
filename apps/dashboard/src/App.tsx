import { useCallback } from "react";

import { AgentRows } from "./components/AgentRows";
import { AgentTiles } from "./components/AgentTiles";
import { HoverCard, useAgentHover } from "./components/HoverCard";
import { StatusFooter } from "./components/StatusFooter";
import {
  countByStatus,
  orderedAgents,
  troubledProviders,
} from "./lib/selectors";
import { useNow } from "./lib/time";
import { useViewMode } from "./lib/viewMode";
import {
  useDashboardFeed,
  type DashboardFeed,
} from "./useDashboardFeed";

type DashboardViewProps = DashboardFeed & {
  now?: number;
};

function LoadingState({
  error,
  onRefresh,
}: {
  error: string | null;
  onRefresh: () => Promise<void>;
}) {
  return (
    <main className="center-state">
      <div className={`loading-orbit ${error ? "has-error" : ""}`} aria-hidden="true">
        <span />
      </div>
      <p className="eyebrow">{error ? "Service unavailable" : "Establishing link"}</p>
      <h1>{error ? "Dashboard is offline" : "Loading agent status"}</h1>
      <p>{error ?? "Fetching the latest snapshot from the status service."}</p>
      {error && (
        <button className="primary-button" type="button" onClick={() => void onRefresh()}>
          Try again
        </button>
      )}
    </main>
  );
}

export function DashboardView({
  snapshot,
  phase,
  isRefreshing,
  error,
  refresh,
  runDemoAction,
  now: fixedNow,
}: DashboardViewProps) {
  const clockNow = useNow();
  const now = fixedNow ?? clockNow;
  const [view, toggleView] = useViewMode();
  const { hover, handlers } = useAgentHover();

  const advance = useCallback(
    () => void runDemoAction("advance"),
    [runDemoAction],
  );
  const reset = useCallback(
    () => void runDemoAction("reset"),
    [runDemoAction],
  );

  if (snapshot === null) {
    return <LoadingState error={error} onRefresh={refresh} />;
  }

  const agents = orderedAgents(snapshot);
  const isShowingStaleSnapshot =
    phase === "reconnecting" || phase === "disconnected" || error !== null;

  return (
    <div className="shell">
      {isShowingStaleSnapshot && (
        <div
          className="connection-banner"
          role={error !== null ? "alert" : "status"}
        >
          <span>
            {error ?? "Live connection is unavailable"}. Showing the last valid
            snapshot.
          </span>
          <button type="button" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      )}

      <main className="agent-area" aria-label="Agents">
        {agents.length === 0 ? (
          <div className="empty">No active agents.</div>
        ) : view === "rows" ? (
          <AgentRows agents={agents} now={now} hover={handlers} />
        ) : (
          <AgentTiles agents={agents} hover={handlers} />
        )}
      </main>

      <StatusFooter
        counts={countByStatus(snapshot)}
        troubled={troubledProviders(snapshot)}
        phase={phase}
        isRefreshing={isRefreshing}
        view={view}
        onToggleView={toggleView}
        onAdvance={advance}
        onReset={reset}
      />

      <HoverCard hover={hover} now={now} />
    </div>
  );
}

export default function App() {
  const feed = useDashboardFeed();
  return <DashboardView {...feed} />;
}
