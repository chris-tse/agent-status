import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(packageRoot, "src", "cli.ts");
const temporaryDirectories: string[] = [];

interface CliResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "release-measurement-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function runCli(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<CliResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn("bun", [cliPath, ...arguments_], {
      cwd: packageRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });
  });
}

async function writeFakeTop(directory: string): Promise<void> {
  const executable = path.join(directory, "top");
  await writeFile(
    executable,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$TOP_ARGUMENT_LOG"
resident_101=100K
resident_202=200K
if [ "$2" = d ]; then
  resident_101=-16K
  resident_202=-32K
fi
printf '%s\\n' \
  'PID %CPU MEM IDLEW' \
  "101 0.0 $resident_101 0" \
  "202 0.0 $resident_202 0" \
  'PID %CPU MEM IDLEW' \
  "101 1.5 $resident_101 2" \
  "202 2.5 $resident_202 3" \
  'PID %CPU MEM IDLEW' \
  '101 3.5 120K 4' \
  '202 4.5 220K 5'
`,
  );
  await chmod(executable, 0o755);
}

async function createConfig(
  directory: string,
  runtime: string,
  commandLog: string,
): Promise<string> {
  const distributionPath = path.join(directory, `${runtime}.dmg`);
  const installedPath = path.join(directory, `${runtime}.app`);
  await writeFile(distributionPath, "x".repeat(1_000));
  await mkdir(installedPath);
  await writeFile(path.join(installedPath, "executable"), "installed");

  const append = (name: string): string => `printf '${name}\\n' >> '${commandLog}'`;
  const configPath = path.join(directory, `${runtime}.json`);
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      runtime,
      buildId: "release-42",
      release: {
        distributionPath,
        installedPath,
      },
      commands: {
        developerBuild: append("developer-build"),
        developerReload: append("developer-reload"),
        launch: append("launch"),
        waitForDashboard: append("dashboard-ready"),
        processIds: "printf '101 202\\n'",
        closeDashboard: append("close-dashboard"),
        openDashboard: append("open-dashboard"),
        triggerReconnect: append("trigger-reconnect"),
        waitForReconnect: append("reconnected"),
        stop: append("stop"),
      },
      sampling: {
        settleSeconds: 0,
        intervalSeconds: 1,
        sampleCount: 2,
      },
    }),
  );
  return configPath;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("release measurement CLI", () => {
  it("measures every required release metric and records a comparable result", async () => {
    const directory = await temporaryDirectory();
    const binDirectory = path.join(directory, "bin");
    await mkdir(binDirectory);
    await writeFakeTop(binDirectory);
    // Login-profile startup must not contaminate each timed protocol command.
    await writeFile(path.join(directory, ".zprofile"), "sleep 0.5\n");
    const commandLog = path.join(directory, "commands.log");
    const topArgumentLog = path.join(directory, "top-arguments.log");
    const configPath = await createConfig(directory, "electrobun", commandLog);
    const outputPath = path.join(directory, "results", "electrobun.json");
    const comparisonPath = path.join(directory, "comparison.md");

    const result = await runCli(
      ["--config", configPath, "--output", outputPath, "--comparison", comparisonPath],
      {
        ...process.env,
        PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
        TOP_ARGUMENT_LOG: topArgumentLog,
        ZDOTDIR: directory,
      },
    );

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain(outputPath);

    const record = JSON.parse(await readFile(outputPath, "utf8")) as Record<string, unknown>;
    expect(record).toMatchObject({
      schemaVersion: 1,
      runtime: "electrobun",
      buildId: "release-42",
      sizes: {
        compressedDistributionBytes: 1_000,
      },
      idle: {
        dashboardOpen: {
          residentMemoryBytes: 327_680,
          cpuPercent: 6,
          wakeupsPerSecond: 7,
          sampleCount: 2,
          sampleIntervalSeconds: 1,
        },
        dashboardClosed: {
          residentMemoryBytes: 327_680,
          cpuPercent: 6,
          wakeupsPerSecond: 7,
          sampleCount: 2,
          sampleIntervalSeconds: 1,
        },
      },
    });
    expect(record).toHaveProperty("sizes.installedBytes");
    expect(record).toHaveProperty("timings.startupMilliseconds");
    expect(record).toHaveProperty("timings.reconnectMilliseconds");
    expect(record).toHaveProperty("timings.developerBuildMilliseconds");
    expect(record).toHaveProperty("timings.developerReloadMilliseconds");

    expect(await readFile(commandLog, "utf8")).toBe(
      [
        "developer-build",
        "developer-reload",
        "launch",
        "dashboard-ready",
        "close-dashboard",
        "open-dashboard",
        "trigger-reconnect",
        "reconnected",
        "stop",
        "",
      ].join("\n"),
    );
    const topArguments = await readFile(topArgumentLog, "utf8");
    expect(topArguments.match(/-c d/g)).toHaveLength(2);
    expect(topArguments.match(/-c n/g)).toHaveLength(2);

    const comparison = await readFile(comparisonPath, "utf8");
    expect(comparison).toContain("electrobun");
    expect(comparison).toContain("Open RSS");
    expect(comparison).toContain("Closed RSS");
    expect(comparison).toContain("Wakeups/s");
  });

  it("rejects a protocol that omits a required measurement instead of substituting it", async () => {
    const directory = await temporaryDirectory();
    const configPath = path.join(directory, "incomplete.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        runtime: "incomplete",
        buildId: "release-1",
        release: {
          distributionPath: "missing.dmg",
          installedPath: "missing.app",
        },
        commands: {},
      }),
    );

    const result = await runCli(["--config", configPath], process.env);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("commands.developerBuild");
    expect(result.stderr).toContain("is required");
  });
});
