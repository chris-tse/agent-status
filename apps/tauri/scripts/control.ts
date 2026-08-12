import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const applicationPath = resolve(
  repositoryRoot,
  "apps/tauri/src-tauri/target/release/bundle/macos/Ambient Status Dashboard.app",
);
const executablePath = resolve(applicationPath, "Contents/MacOS/ambient-status-dashboard-tauri");
const runtimePath = resolve(applicationPath, "Contents/MacOS/status-service-runtime");
const lifecyclePath = resolve(applicationPath, "Contents/Resources/service/lifecycle-cli.js");
const controlPort = Number(Bun.env.STATUS_DASHBOARD_CONTROL_PORT || "4318");
const controlUrl = `http://127.0.0.1:${controlPort}`;
const timeoutAt = Date.now() + Number(Bun.env.STATUS_DASHBOARD_CONTROL_TIMEOUT_MS || "15000");

async function retry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  while (Date.now() < timeoutAt) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      await Bun.sleep(100);
    }
  }
  throw lastError ?? new Error("Tauri control timed out");
}

async function desktopStatus() {
  const response = await fetch(`${controlUrl}/status`);
  if (!response.ok) throw new Error(`Desktop status failed (${response.status})`);
  return (await response.json()) as {
    serviceState: string;
    presentationOpen: boolean;
    pid: number;
  };
}

async function action(name: string) {
  const response = await fetch(`${controlUrl}/action/${name}`, { method: "POST" });
  if (!response.ok) throw new Error(await response.text());
}

async function runLifecycle(name: "status" | "start" | "stop" | "restart") {
  const process = Bun.spawn([runtimePath, lifecyclePath, "--json", name], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || `Lifecycle ${name} failed`);
  return JSON.parse(stdout) as { state: string; health?: { version: number } };
}

async function waitForDashboard() {
  await retry(async () => {
    const status = await desktopStatus();
    if (!status.presentationOpen || status.serviceState !== "running") {
      throw new Error("Dashboard or service is not ready");
    }
    const healthResponse = await fetch("http://127.0.0.1:4317/health");
    if (!healthResponse.ok) throw new Error(`Health failed (${healthResponse.status})`);
    const health = (await healthResponse.json()) as { provider?: string };
    if (health.provider !== "herdr") {
      throw new Error(`Packaged service did not use Herdr (received ${health.provider})`);
    }
    const snapshot = await fetch("http://127.0.0.1:4317/api/snapshot");
    if (!snapshot.ok) throw new Error(`Snapshot failed (${snapshot.status})`);
    await new Promise<void>((resolveConnection, reject) => {
      const socket = new WebSocket("ws://127.0.0.1:4317/ws");
      const timer = setTimeout(() => reject(new Error("WebSocket snapshot timed out")), 2_000);
      socket.addEventListener("message", (event) => {
        clearTimeout(timer);
        const value = JSON.parse(String(event.data)) as { type?: string };
        socket.close();
        if (value.type === "snapshot") {
          resolveConnection();
        } else {
          reject(new Error("WebSocket did not send an immediate snapshot"));
        }
      });
      socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")));
    });
  });
}

async function processIds() {
  const processes = new Set<number>();
  const desktop = await desktopStatus().catch(() => undefined);
  if (desktop !== undefined) processes.add(desktop.pid);
  const service = Bun.spawnSync(["/usr/bin/pgrep", "-f", `${runtimePath} .*service/index.js`]);
  if (service.exitCode === 0) {
    for (const value of service.stdout.toString().trim().split(/\s+/)) {
      const pid = Number(value);
      if (Number.isInteger(pid)) processes.add(pid);
    }
  }
  const baselinePath =
    Bun.env.STATUS_DASHBOARD_WEBKIT_BASELINE || "/tmp/status-dashboard-tauri-webkit-baseline";
  const baseline = new Set(
    (
      await Bun.file(baselinePath)
        .text()
        .catch(() => "")
    )
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter(Number.isInteger),
  );
  const webkit = Bun.spawnSync([
    "/usr/bin/pgrep",
    "-f",
    "/System/Library/Frameworks/WebKit.framework/.*/com.apple.WebKit.(GPU|Networking|WebContent)",
  ]);
  if (webkit.exitCode === 0) {
    for (const value of webkit.stdout.toString().trim().split(/\s+/)) {
      const pid = Number(value);
      if (Number.isInteger(pid) && !baseline.has(pid)) processes.add(pid);
    }
  }
  console.log([...processes].join(" "));
}

const command = process.argv[2];
if (command === "launch") {
  Bun.spawn([executablePath], {
    env: { ...Bun.env, STATUS_DASHBOARD_CONTROL_PORT: String(controlPort) },
    stdout: "ignore",
    stderr: "ignore",
  }).unref();
} else if (command === "wait-dashboard") {
  await waitForDashboard();
} else if (command === "status") {
  console.log(JSON.stringify(await retry(desktopStatus)));
} else if (command === "process-ids") {
  await processIds();
} else if (command === "lifecycle-status") {
  console.log(JSON.stringify(await runLifecycle("status")));
} else if (command === "start-service") {
  await runLifecycle("start");
} else if (command === "stop-service") {
  await runLifecycle("stop");
} else if (command === "restart-service") {
  await runLifecycle("restart");
} else if (command === "close-dashboard" || command === "show-dashboard" || command === "quit") {
  await retry(async () => await action(command));
} else if (command === "stop") {
  await runLifecycle("stop").catch(() => undefined);
  await action("quit").catch(() => undefined);
} else {
  throw new Error(
    "Usage: bun scripts/control.ts <launch|wait-dashboard|status|process-ids|lifecycle-status|start-service|stop-service|restart-service|close-dashboard|show-dashboard|quit|stop>",
  );
}
