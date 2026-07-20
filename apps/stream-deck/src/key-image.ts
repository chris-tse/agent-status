import type { AgentLifecycleStatus, AgentResource } from "@status-dashboard/model";

import type { ConnectionState } from "./dashboard-client.js";

const statusStyle: Record<
  AgentLifecycleStatus,
  { readonly background: string; readonly caption: string }
> = {
  running: { background: "#1565D8", caption: "RUN" },
  waiting: { background: "#C47B00", caption: "WAIT" },
  completed: { background: "#15803D", caption: "DONE" },
  failed: { background: "#B42318", caption: "FAIL" },
};

function escapeXml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[character] ?? character,
  );
}

function shortLabel(value: string, maximum = 10): string {
  const trimmed = value.trim();
  if (trimmed.length <= maximum) {
    return trimmed;
  }
  return `${trimmed.slice(0, maximum - 1)}…`;
}

function providerLabel(providerId: string): string {
  const pieces = providerId.split(/[/:]/).filter(Boolean);
  return shortLabel(pieces.at(-1) ?? providerId, 11).toUpperCase();
}

export function renderKeyImage(
  connection: ConnectionState,
  resource?: AgentResource,
): string {
  let background = "#172033";
  let top = "STATUS";
  let center = "EMPTY";
  let bottom = "READY";

  if (resource !== undefined) {
    const style = statusStyle[resource.status];
    background = style.background;
    top = providerLabel(resource.providerId);
    center = shortLabel(resource.label ?? resource.id);
    bottom = style.caption;
  } else if (connection === "connecting") {
    background = "#3B465B";
    center = "LINK";
    bottom = "CONNECTING";
  } else if (connection === "disconnected") {
    background = "#5E2630";
    center = "OFFLINE";
    bottom = "RETRYING";
  }

  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">',
    `<rect width="144" height="144" rx="16" fill="${background}"/>`,
    '<rect x="12" y="12" width="120" height="120" rx="12" fill="none" stroke="#FFFFFF" stroke-opacity=".18" stroke-width="2"/>',
    `<text x="72" y="34" text-anchor="middle" fill="#FFFFFF" fill-opacity=".78" font-family="Arial, sans-serif" font-size="14" font-weight="700">${escapeXml(top)}</text>`,
    `<text x="72" y="82" text-anchor="middle" fill="#FFFFFF" font-family="Arial, sans-serif" font-size="22" font-weight="700">${escapeXml(center)}</text>`,
    `<text x="72" y="116" text-anchor="middle" fill="#FFFFFF" fill-opacity=".86" font-family="Arial, sans-serif" font-size="13" font-weight="700">${escapeXml(bottom)}</text>`,
    "</svg>",
  ].join("");

  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
