import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const control = resolve(import.meta.dir, "control.ts");
const applicationPath = resolve(
  repositoryRoot,
  "apps/tauri/src-tauri/target/release/bundle/macos/Ambient Status Dashboard.app",
);

function command(...arguments_: string[]) {
  const result = Bun.spawnSync([process.execPath, control, ...arguments_], {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim());
  return result.stdout.toString().trim();
}

async function waitFor(predicate: () => boolean | Promise<boolean>, message: string) {
  const timeoutAt = Date.now() + 15_000;
  while (Date.now() < timeoutAt) {
    if (await predicate()) return;
    await Bun.sleep(100);
  }
  throw new Error(message);
}

function servicePid(): number | undefined {
  const output = Bun.spawnSync(["/usr/sbin/lsof", "-nP", "-t", "-iTCP:4317", "-sTCP:LISTEN"]);
  if (output.exitCode !== 0) return undefined;
  const pid = Number(output.stdout.toString().trim());
  return Number.isInteger(pid) ? pid : undefined;
}

command("stop");
try {
  command("launch");
  command("wait-dashboard");
  const initialService = servicePid();
  if (initialService === undefined) throw new Error("Service did not start on open");

  command("close-dashboard");
  const closed = JSON.parse(command("status")) as { presentationOpen: boolean };
  if (closed.presentationOpen) throw new Error("Close did not destroy the dashboard window");
  if (servicePid() !== initialService) throw new Error("Service did not survive dashboard close");

  command("show-dashboard");
  command("wait-dashboard");
  command("quit");
  await waitFor(
    () => Bun.spawnSync(["/usr/bin/pgrep", "-x", "ambient-status-dashboard-tauri"]).exitCode !== 0,
    "Presentation did not quit",
  );
  if (servicePid() !== initialService) throw new Error("Service did not survive presentation quit");

  command("launch");
  command("wait-dashboard");
  if (servicePid() !== initialService) {
    throw new Error("Opening the presentation did not reuse the compatible service");
  }

  command("stop-service");
  await waitFor(() => servicePid() === undefined, "Explicit stop did not stop the service");
  await Bun.sleep(1_200);
  if (servicePid() !== undefined) throw new Error("Explicit stop did not hold");

  const unrelated = Bun.serve({
    hostname: "127.0.0.1",
    port: 4317,
    fetch: () => Response.json({ application: "unrelated-smoke-listener" }),
  });
  try {
    await waitFor(() => {
      const status = JSON.parse(command("status")) as {
        serviceState: string;
        serviceMessage?: string;
      };
      return (
        status.serviceState === "unhealthy" &&
        status.serviceMessage?.includes("unrelated process") === true
      );
    }, "Unrelated listener was not surfaced as an unhealthy service");
    try {
      command("start-service");
      throw new Error("Start unexpectedly accepted an unrelated listener");
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("unrelated process")) throw error;
    }
  } finally {
    unrelated.stop(true);
  }

  command("start-service");
  await waitFor(() => servicePid() !== undefined, "Explicit start did not restore the service");
  const beforeRestart = servicePid();
  command("restart-service");
  await waitFor(
    () => servicePid() !== undefined && servicePid() !== beforeRestart,
    "Restart did not replace the service process",
  );

  const beforeCrash = servicePid();
  if (beforeCrash === undefined) throw new Error("Service unavailable before crash recovery test");
  process.kill(beforeCrash, "SIGKILL");
  await waitFor(
    () => servicePid() !== undefined && servicePid() !== beforeCrash,
    "launchd did not recover the abnormally exited service",
  );

  command("stop-and-quit");
  await waitFor(
    () => Bun.spawnSync(["/usr/bin/pgrep", "-x", "ambient-status-dashboard-tauri"]).exitCode !== 0,
    "Stop Service and Quit did not quit the presentation",
  );
  await waitFor(() => servicePid() === undefined, "Stop Service and Quit did not stop the service");
  await Bun.sleep(1_200);
  if (servicePid() !== undefined) throw new Error("Stop Service and Quit did not hold the stop");

  const signature = Bun.spawnSync([
    "/usr/bin/codesign",
    "--verify",
    "--deep",
    "--strict",
    applicationPath,
  ]);
  if (signature.exitCode !== 0) throw new Error(signature.stderr.toString().trim());
  console.log("packaged Tauri lifecycle smoke passed");
} finally {
  command("stop");
}
