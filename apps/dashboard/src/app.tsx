import { useCallback } from "react";
import type { ProviderStatus } from "@status-dashboard/model";

import { AgentRows } from "./components/agent-rows";
import { AgentTiles } from "./components/agent-tiles";
import { HoverCard, useAgentHover } from "./components/hover-card";
import { StatusFooter } from "./components/status-footer";
import {
  useDesktopLifecycle,
  type DesktopLifecycleControls,
  type DesktopLifecycleState,
} from "./desktop-lifecycle";
import { countByStatus, orderedAgents, troubledProviders } from "./lib/selectors";
import { useNow } from "./lib/time";
import { useViewMode } from "./lib/view-mode";
import { useDashboardFeed, type DashboardFeed } from "./use-dashboard-feed";

type DashboardViewProps = DashboardFeed & {
  now?: number;
  desktopLifecycle?: DesktopLifecycleControls | null;
};

const lifecycleLabels: Record<DesktopLifecycleState, string> = {
  stopped: "stopped",
  starting: "starting",
  running: "running",
  restarting: "restarting",
  unhealthy: "unhealthy",
};

function DesktopLifecycleBar({
  lifecycle,
  providers,
}: {
  lifecycle: DesktopLifecycleControls;
  providers: ProviderStatus[];
}) {
  return (
    <div className="desktop-diagnostics">
      <section
        className="service-lifecycle"
        data-state={lifecycle.state}
        role="status"
        aria-label="Service lifecycle"
      >
        <span className="service-lifecycle-label">Service</span>
        <span className="service-lifecycle-state">{lifecycleLabels[lifecycle.state]}</span>
        {lifecycle.message && (
          <span className="service-lifecycle-message" role="alert">
            {lifecycle.message}
          </span>
        )}
        {lifecycle.diagnosticError && (
          <span className="service-lifecycle-message" role="alert">
            {lifecycle.diagnosticError}
          </span>
        )}
        <span className="service-lifecycle-spacer" />
        <button
          type="button"
          disabled={lifecycle.pendingAction !== null}
          onClick={() => void lifecycle.start()}
        >
          Start Service
        </button>
        <button
          type="button"
          disabled={lifecycle.pendingAction !== null}
          onClick={() => void lifecycle.stop()}
        >
          Stop Service
        </button>
        <button
          type="button"
          disabled={lifecycle.pendingAction !== null}
          onClick={() => void lifecycle.restart()}
        >
          Restart Service
        </button>
        <button
          type="button"
          disabled={lifecycle.isOpeningLogs}
          onClick={() => void lifecycle.openLogs()}
        >
          Open Diagnostic Logs
        </button>
      </section>
      <section className="provider-connectivity" role="status" aria-label="Provider connectivity">
        <span className="service-lifecycle-label">Provider</span>
        {providers.length === 0 ? (
          <span className="provider-connectivity-state">unavailable</span>
        ) : (
          providers.map((provider) => (
            <span className="provider-connectivity-item" key={provider.id}>
              <span className="provider-connectivity-name">{provider.label ?? provider.id}</span>
              <span className="provider-connectivity-state">{provider.connectivity}</span>
              {provider.message && (
                <span className="provider-connectivity-message">{provider.message}</span>
              )}
            </span>
          ))
        )}
      </section>
    </div>
  );
}

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
  desktopLifecycle = null,
}: DashboardViewProps) {
  const clockNow = useNow();
  const now = fixedNow ?? clockNow;
  const [view, toggleView] = useViewMode();
  const { hover, handlers } = useAgentHover();

  const advance = useCallback(() => void runDemoAction("advance"), [runDemoAction]);
  const reset = useCallback(() => void runDemoAction("reset"), [runDemoAction]);

  if (snapshot === null) {
    return (
      <div className="shell">
        {desktopLifecycle && <DesktopLifecycleBar lifecycle={desktopLifecycle} providers={[]} />}
        <LoadingState error={error} onRefresh={refresh} />
      </div>
    );
  }

  const agents = orderedAgents(snapshot);
  const isShowingStaleSnapshot =
    phase === "reconnecting" || phase === "disconnected" || error !== null;

  return (
    <div className="shell">
      {desktopLifecycle && (
        <DesktopLifecycleBar lifecycle={desktopLifecycle} providers={snapshot.providers} />
      )}
      {isShowingStaleSnapshot && (
        <div className="connection-banner" role={error !== null ? "alert" : "status"}>
          <span>{error ?? "Live connection is unavailable"}. Showing the last valid snapshot.</span>
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
  const desktopLifecycle = useDesktopLifecycle();
  return <DashboardView {...feed} desktopLifecycle={desktopLifecycle} />;
}
