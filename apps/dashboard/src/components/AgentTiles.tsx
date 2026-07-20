import type { StatefulResource } from "@status-dashboard/model";

import { displayStatus } from "../lib/selectors";
import type { AgentHoverHandlers } from "./HoverCard";

interface AgentTilesProps {
  agents: StatefulResource[];
  hover: AgentHoverHandlers;
}

/** Dense view: a colored tile per agent — the tile itself is the status. */
export function AgentTiles({ agents, hover }: AgentTilesProps) {
  return (
    <div className="agent-tiles" data-testid="agent-tiles">
      {agents.map((agent) => {
        const status = displayStatus(agent);
        const label = agent.label ?? agent.id;
        return (
          <article
            key={agent.id}
            className="agent-tile"
            data-s={status}
            aria-label={`${label}: ${status}`}
            onMouseEnter={(event) => hover.onShow(agent, event)}
            onMouseMove={hover.onMove}
            onMouseLeave={hover.onHide}
          >
            <span className="name">{label}</span>
          </article>
        );
      })}
    </div>
  );
}
