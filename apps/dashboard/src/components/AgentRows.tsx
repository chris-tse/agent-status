import type { StatefulResource } from "@status-dashboard/model";

import { displayStatus } from "../lib/selectors";
import { formatDuration } from "../lib/time";
import type { AgentHoverHandlers } from "./HoverCard";

interface AgentRowsProps {
  agents: StatefulResource[];
  now: number;
  hover: AgentHoverHandlers;
}

function runtime(agent: StatefulResource, now: number): string {
  const startedAt = Date.parse(agent.startedAt ?? agent.createdAt);
  const finishedAt =
    agent.status === "completed" || agent.status === "failed"
      ? Date.parse(agent.completedAt ?? agent.updatedAt)
      : now;
  return formatDuration(finishedAt - startedAt);
}

/** Roomy view: one line per agent — status dot, name, runtime. */
export function AgentRows({ agents, now, hover }: AgentRowsProps) {
  return (
    <div className="agent-rows" data-testid="agent-rows">
      {agents.map((agent) => {
        const status = displayStatus(agent);
        const label = agent.label ?? agent.id;
        return (
          <article
            key={agent.id}
            className="agent-row"
            data-s={status}
            aria-label={`${label}: ${status}`}
            onMouseEnter={(event) => hover.onShow(agent, event)}
            onMouseMove={hover.onMove}
            onMouseLeave={hover.onHide}
          >
            <span className="dot" data-s={status} aria-hidden="true" />
            <span className="label">{label}</span>
            <span className="runtime">{runtime(agent, now)}</span>
          </article>
        );
      })}
    </div>
  );
}
