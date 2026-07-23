import type { StatefulResource } from "@status-dashboard/model";
import { useCallback, useState, type MouseEvent } from "react";

import { displayStatus } from "../lib/selectors";
import { formatDuration, formatRelative } from "../lib/time";

const statusLabels = {
  running: "Running",
  blocked: "Blocked",
  done: "Done",
} as const;

interface HoverState {
  agent: StatefulResource;
  x: number;
  y: number;
}

export interface AgentHoverHandlers {
  onShow: (agent: StatefulResource, event: MouseEvent) => void;
  onMove: (event: MouseEvent) => void;
  onHide: () => void;
}

/** Shared cursor-following detail card; metadata stays out of the compact grid. */
export function useAgentHover(): {
  hover: HoverState | undefined;
  handlers: AgentHoverHandlers;
} {
  const [hover, setHover] = useState<HoverState>();

  const onShow = useCallback((agent: StatefulResource, event: MouseEvent) => {
    setHover({ agent, x: event.clientX, y: event.clientY });
  }, []);

  const onMove = useCallback((event: MouseEvent) => {
    setHover((current) =>
      current === undefined ? current : { ...current, x: event.clientX, y: event.clientY },
    );
  }, []);

  const onHide = useCallback(() => setHover(undefined), []);

  return { hover, handlers: { onShow, onMove, onHide } };
}

function runtime(agent: StatefulResource, now: number): string {
  const startedAt = Date.parse(agent.startedAt ?? agent.createdAt);
  const finishedAt =
    agent.status === "completed" || agent.status === "failed"
      ? Date.parse(agent.completedAt ?? agent.updatedAt)
      : now;
  return formatDuration(finishedAt - startedAt);
}

const PAD = 14;
const CARD_WIDTH = 280;
const CARD_HEIGHT = 110;

export function HoverCard({ hover, now }: { hover: HoverState | undefined; now: number }) {
  if (hover === undefined) return null;

  const { agent, x, y } = hover;
  const status = displayStatus(agent);
  const elapsed = runtime(agent, now);
  const left = x + PAD + CARD_WIDTH > window.innerWidth ? x - CARD_WIDTH - PAD : x + PAD;
  const top = y + PAD + CARD_HEIGHT > window.innerHeight ? y - CARD_HEIGHT - PAD : y + PAD;

  return (
    <div className="hover-card" role="tooltip" style={{ left, top }}>
      <div className="tip-title">{agent.label ?? agent.id}</div>
      <div>
        {statusLabels[status]} · {agent.providerId}
        {agent.workspaceId !== undefined && `/${agent.workspaceId}`}
      </div>
      <div>
        {status === "done" ? "ran for" : "running for"} {elapsed} · updated{" "}
        {formatRelative(agent.updatedAt, now)}
      </div>
      {agent.attentionReason !== undefined && (
        <div className="tip-reason">{agent.attentionReason}</div>
      )}
    </div>
  );
}
