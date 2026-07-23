const controlPort = Number(Bun.env.STATUS_DASHBOARD_CONTROL_PORT || "4318");
const baseUrl = `http://127.0.0.1:${controlPort}`;
const command = process.argv[2];
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
  throw lastError ?? new Error("Desktop control timed out");
}

async function status() {
  const response = await fetch(`${baseUrl}/status`);
  if (!response.ok) throw new Error(`Desktop status failed (${response.status})`);
  return (await response.json()) as {
    serviceRunning: boolean;
    presentationOpen: boolean;
    pid: number;
  };
}

if (command === "status") {
  console.log(JSON.stringify(await retry(status)));
} else if (command === "wait-dashboard") {
  await retry(async () => {
    const current = await status();
    if (!current.presentationOpen || !current.serviceRunning) {
      throw new Error("Dashboard or service is not ready");
    }
    const snapshot = await fetch("http://127.0.0.1:4317/api/snapshot");
    if (!snapshot.ok) throw new Error(`Snapshot failed (${snapshot.status})`);
  });
} else if (command === "process-ids") {
  const root = (await retry(status)).pid;
  const pending = [root];
  const processes = new Set<number>();
  while (pending.length > 0) {
    const parent = pending.shift();
    if (parent === undefined || processes.has(parent)) continue;
    processes.add(parent);
    const child = Bun.spawnSync(["/usr/bin/pgrep", "-P", String(parent)]);
    if (child.exitCode === 0) {
      for (const value of child.stdout.toString().trim().split(/\s+/)) {
        const pid = Number(value);
        if (Number.isInteger(pid)) pending.push(pid);
      }
    }
  }
  const baselinePath =
    Bun.env.STATUS_DASHBOARD_WEBKIT_BASELINE || "/tmp/status-dashboard-electrobun-webkit-baseline";
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
} else if (command === "stop-and-quit") {
  await fetch(`${baseUrl}/action/stop-and-quit`, { method: "POST" }).catch(() => undefined);
  await retry(async () => {
    try {
      await status();
    } catch {
      return;
    }
    throw new Error("Desktop process is still running");
  });
} else {
  const actions = new Set([
    "show-dashboard",
    "close-dashboard",
    "start-service",
    "stop-service",
    "restart-service",
  ]);
  if (command === undefined || !actions.has(command)) {
    throw new Error(
      "Usage: bun scripts/control.ts <status|wait-dashboard|process-ids|show-dashboard|close-dashboard|start-service|stop-service|restart-service|stop-and-quit>",
    );
  }
  const response = await retry(async () => {
    const result = await fetch(`${baseUrl}/action/${command}`, { method: "POST" });
    if (!result.ok) throw new Error(`Desktop action failed (${result.status})`);
    return result;
  });
  console.log(await response.text());
}
