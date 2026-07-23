import { DashboardSnapshotSchema } from "@status-dashboard/model";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DashboardView } from "../src/app";
import { VIEW_MODE_STORAGE_KEY } from "../src/lib/view-mode";

const fixedNow = Date.parse("2026-07-19T07:05:00.000Z");

const snapshot = DashboardSnapshotSchema.parse({
  version: 8,
  generatedAt: "2026-07-19T07:05:00.000Z",
  providers: [
    {
      id: "cursor",
      label: "Cursor",
      connectivity: "connected",
      checkedAt: "2026-07-19T07:05:00.000Z",
    },
    {
      id: "other",
      label: "Other",
      connectivity: "degraded",
      checkedAt: "2026-07-19T07:05:00.000Z",
    },
  ],
  resources: [
    {
      kind: "agent",
      id: "done",
      providerId: "cursor",
      label: "Done agent",
      status: "completed",
      createdAt: "2026-07-19T06:30:00.000Z",
      startedAt: "2026-07-19T06:30:00.000Z",
      completedAt: "2026-07-19T06:50:00.000Z",
      updatedAt: "2026-07-19T06:50:00.000Z",
    },
    {
      kind: "agent",
      id: "running",
      providerId: "cursor",
      label: "Running agent",
      status: "running",
      createdAt: "2026-07-19T07:00:00.000Z",
      startedAt: "2026-07-19T07:00:00.000Z",
      updatedAt: "2026-07-19T07:02:00.000Z",
    },
    {
      kind: "agent",
      id: "failed",
      providerId: "other",
      label: "Failed agent",
      status: "failed",
      createdAt: "2026-07-19T06:55:00.000Z",
      startedAt: "2026-07-19T06:56:00.000Z",
      updatedAt: "2026-07-19T07:03:00.000Z",
      attentionReason: "Worker exited",
    },
    {
      kind: "agent",
      id: "waiting",
      providerId: "cursor",
      workspaceId: "status-dashboard",
      label: "Waiting agent",
      status: "waiting",
      createdAt: "2026-07-19T06:58:00.000Z",
      startedAt: "2026-07-19T07:00:00.000Z",
      updatedAt: "2026-07-19T07:04:00.000Z",
      attentionReason: "Choose a visual direction",
    },
  ],
  events: [],
});

const noOp = async () => {};

function renderDashboard(overrides: Partial<React.ComponentProps<typeof DashboardView>> = {}) {
  return render(
    <DashboardView
      snapshot={snapshot}
      phase="live"
      isRefreshing={false}
      error={null}
      lastMessageAt={fixedNow}
      refresh={noOp}
      runDemoAction={noOp}
      now={fixedNow}
      {...overrides}
    />,
  );
}

describe("DashboardView", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(cleanup);

  it("orders blocked agents first and collapses lifecycle statuses", () => {
    const { container } = renderDashboard();

    const labels = [...container.querySelectorAll(".agent-row .label")].map(
      (element) => element.textContent,
    );
    expect(labels).toEqual(["Waiting agent", "Failed agent", "Running agent", "Done agent"]);
    expect(screen.getByLabelText("2 blocked")).toBeInTheDocument();
    expect(screen.getByLabelText("1 running")).toBeInTheDocument();
    expect(screen.getByLabelText("1 done")).toBeInTheDocument();
    expect(screen.getByText("1 provider has issues")).toBeInTheDocument();
  });

  it("shows agent details on hover", () => {
    renderDashboard();

    fireEvent.mouseEnter(screen.getByText("Waiting agent"), {
      clientX: 50,
      clientY: 60,
    });

    expect(screen.getByRole("tooltip")).toHaveTextContent("Blocked · cursor/status-dashboard");
    expect(screen.getByRole("tooltip")).toHaveTextContent("Choose a visual direction");
  });

  it("toggles rows and tiles and restores the persisted view", () => {
    const first = renderDashboard();

    fireEvent.click(screen.getByRole("button", { name: "Switch to dense tiles" }));
    expect(screen.getByTestId("agent-tiles")).toBeInTheDocument();
    expect(window.localStorage.getItem(VIEW_MODE_STORAGE_KEY)).toBe("tiles");

    first.unmount();
    renderDashboard();

    expect(screen.getByTestId("agent-tiles")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Switch to rows" }));
    expect(screen.getByTestId("agent-rows")).toBeInTheDocument();
    expect(window.localStorage.getItem(VIEW_MODE_STORAGE_KEY)).toBe("rows");
  });

  it("shows a clear initial error state and retries", () => {
    const refresh = vi.fn(async () => {});

    renderDashboard({
      snapshot: null,
      phase: "error",
      error: "Snapshot request failed (503)",
      lastMessageAt: null,
      refresh,
    });

    expect(screen.getByRole("heading", { name: "Dashboard is offline" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("keeps the last valid snapshot visible while reconnecting", () => {
    renderDashboard({
      phase: "reconnecting",
      error: "Live connection was interrupted",
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Showing the last valid snapshot");
    expect(screen.getByText("reconnecting")).toBeInTheDocument();
    expect(screen.getByText("Waiting agent")).toBeInTheDocument();
  });
});
