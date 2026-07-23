import {
  createStatusServer,
  loadConfig,
  type RunningStatusServer,
} from "@status-dashboard/service";
import * as ApplicationMenu from "../node_modules/electrobun/dist/api/bun/core/ApplicationMenu";
import { BrowserWindow } from "../node_modules/electrobun/dist/api/bun/core/BrowserWindow";
import { Tray } from "../node_modules/electrobun/dist/api/bun/core/Tray";
import * as Utils from "../node_modules/electrobun/dist/api/bun/core/Utils";
import electrobunEvents from "../node_modules/electrobun/dist/api/bun/events/eventEmitter";

import {
  createDesktopRuntime,
  type DesktopPresentation,
  type EmbeddedStatusService,
} from "./desktop-runtime";

const DASHBOARD_URL = "views://dashboard/index.html";
const SERVICE_URL = "http://127.0.0.1:4317";

let runningService: RunningStatusServer | null = null;
const service: EmbeddedStatusService = {
  isRunning: () => runningService !== null,
  async start() {
    if (runningService !== null) return;
    const environment = {
      ...Bun.env,
      HOST: "127.0.0.1",
      PORT: "4317",
      STATUS_PROVIDER: Bun.env.STATUS_PROVIDER?.trim() || "herdr",
      CORS_ORIGINS: ["views://dashboard", "http://127.0.0.1:4173", "http://localhost:4173"].join(
        ",",
      ),
    };
    runningService = createStatusServer({ config: loadConfig(environment) });
    console.info(`Embedded status service listening at ${runningService.server.url}`);
  },
  async stop() {
    runningService?.stop();
    runningService = null;
  },
};

let dashboardWindow: BrowserWindow | null = null;
const presentation: DesktopPresentation = {
  isOpen: () => dashboardWindow !== null,
  async open() {
    if (dashboardWindow !== null) {
      dashboardWindow.show();
      dashboardWindow.activate();
      return;
    }
    const window = new BrowserWindow({
      title: "Ambient Status Dashboard",
      url: DASHBOARD_URL,
      frame: {
        width: 980,
        height: 720,
        x: 160,
        y: 120,
      },
    });
    dashboardWindow = window;
    window.on("close", () => {
      if (dashboardWindow?.id === window.id) dashboardWindow = null;
    });
  },
  async close() {
    const window = dashboardWindow;
    dashboardWindow = null;
    window?.close();
  },
};

const runtime = createDesktopRuntime({
  service,
  presentation,
  host: {
    quit() {
      Utils.quit();
    },
  },
});

type MenuAction =
  | "show-dashboard"
  | "close-dashboard"
  | "start-service"
  | "stop-service"
  | "restart-service"
  | "stop-and-quit";

async function performAction(action: MenuAction): Promise<void> {
  switch (action) {
    case "show-dashboard":
      await runtime.showPresentation();
      return;
    case "close-dashboard":
      await runtime.closePresentation();
      return;
    case "start-service":
      await runtime.startService();
      return;
    case "stop-service":
      await runtime.stopService();
      return;
    case "restart-service":
      await runtime.restartService();
      return;
    case "stop-and-quit":
      await runtime.stopServiceAndQuit();
  }
}

function menuAction(event: unknown): MenuAction | undefined {
  if (typeof event !== "object" || event === null || !("data" in event)) return undefined;
  const data = event.data;
  if (typeof data !== "object" || data === null || !("action" in data)) return undefined;
  const action = data.action;
  return typeof action === "string" ? (action as MenuAction) : undefined;
}

const dashboardMenu = [
  { type: "normal" as const, label: "Show Dashboard", action: "show-dashboard" },
  { type: "normal" as const, label: "Close Dashboard", action: "close-dashboard" },
  { type: "divider" as const },
  { type: "normal" as const, label: "Start Service", action: "start-service" },
  { type: "normal" as const, label: "Stop Service", action: "stop-service" },
  { type: "normal" as const, label: "Restart Service", action: "restart-service" },
  { type: "divider" as const },
  {
    type: "normal" as const,
    label: "Stop Service and Quit",
    action: "stop-and-quit",
  },
];

const tray = new Tray({ title: "Status" });
tray.setMenu(dashboardMenu);
tray.on("tray-clicked", (event) => {
  const action = menuAction(event);
  if (action !== undefined) void performAction(action);
});

ApplicationMenu.setApplicationMenu([
  {
    label: "Ambient Status Dashboard",
    submenu: [
      { label: "Show Dashboard", action: "show-dashboard" },
      { label: "Close Dashboard", action: "close-dashboard", accelerator: "CmdOrCtrl+W" },
      { type: "divider" },
      { label: "Start Service", action: "start-service" },
      { label: "Stop Service", action: "stop-service" },
      { label: "Restart Service", action: "restart-service" },
      { type: "divider" },
      {
        label: "Stop Service and Quit",
        action: "stop-and-quit",
        accelerator: "CmdOrCtrl+Q",
      },
    ],
  },
  {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "divider" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  },
]);
ApplicationMenu.on("application-menu-clicked", (event) => {
  const action = menuAction(event);
  if (action !== undefined) void performAction(action);
});

electrobunEvents.on("reopen", () => {
  void runtime.showPresentation();
});

const controlPort = Number(Bun.env.STATUS_DASHBOARD_CONTROL_PORT || "4318");
if (Number.isInteger(controlPort) && controlPort > 0 && controlPort <= 65_535) {
  Bun.serve({
    hostname: "127.0.0.1",
    port: controlPort,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/status") {
        return Response.json({ ...runtime.status(), pid: process.pid, serviceUrl: SERVICE_URL });
      }
      if (request.method === "POST" && url.pathname.startsWith("/action/")) {
        const action = url.pathname.slice("/action/".length) as MenuAction;
        if (!dashboardMenu.some((item) => "action" in item && item.action === action)) {
          return Response.json({ error: "Unknown action" }, { status: 404 });
        }
        await performAction(action);
        return Response.json(runtime.status());
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    },
  });
  console.info(`Measurement control listening at http://127.0.0.1:${controlPort}`);
}

await runtime.openApplication();
