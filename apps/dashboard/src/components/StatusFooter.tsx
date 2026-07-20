import type { ProviderStatus } from "@status-dashboard/model";

import type { StatusCounts } from "../lib/selectors";
import type { ViewMode } from "../lib/viewMode";
import type { FeedPhase } from "../useDashboardFeed";

const phaseLabels: Record<FeedPhase, string> = {
  live: "live",
  connecting: "connecting",
  reconnecting: "reconnecting",
  disconnected: "offline",
  error: "unavailable",
};

interface StatusFooterProps {
  counts: StatusCounts;
  troubled: ProviderStatus[];
  phase: FeedPhase;
  isRefreshing: boolean;
  view: ViewMode;
  onToggleView: () => void;
  onAdvance: () => void;
  onReset: () => void;
}

/** Slim footer: quiet tallies, exception-only provider health, and controls. */
export function StatusFooter({
  counts,
  troubled,
  phase,
  isRefreshing,
  view,
  onToggleView,
  onAdvance,
  onReset,
}: StatusFooterProps) {
  return (
    <footer className="status-footer" aria-label="Dashboard status">
      <span className="tally" aria-label={`${counts.running} running`}>
        <span className="dot" data-s="running" aria-hidden="true" />
        {counts.running}
      </span>
      <span
        className="tally"
        data-alert={counts.blocked > 0}
        aria-label={`${counts.blocked} blocked`}
      >
        <span className="dot" data-s="blocked" aria-hidden="true" />
        {counts.blocked}
      </span>
      <span className="tally" aria-label={`${counts.done} done`}>
        <span className="dot" data-s="done" aria-hidden="true" />
        {counts.done}
      </span>

      {troubled.length > 0 && (
        <span className="provider-alert">
          {troubled.length} provider{troubled.length > 1 ? "s" : ""}{" "}
          {troubled.length > 1 ? "have" : "has"} issues
        </span>
      )}

      <span className="spacer" />

      <button type="button" className="ghost" onClick={onAdvance}>
        demo
      </button>
      <button type="button" className="ghost" onClick={onReset}>
        reset
      </button>
      <button
        type="button"
        className="ghost view-toggle"
        onClick={onToggleView}
        aria-label={
          view === "rows" ? "Switch to dense tiles" : "Switch to rows"
        }
        title={view === "rows" ? "Switch to dense tiles" : "Switch to rows"}
      >
        <span aria-hidden="true">{view === "rows" ? "▦" : "☰"}</span>
      </button>

      <span className="conn" data-status={phase} role="status">
        <span className="dot" aria-hidden="true" />
        {isRefreshing ? "syncing" : phaseLabels[phase]}
      </span>
    </footer>
  );
}
