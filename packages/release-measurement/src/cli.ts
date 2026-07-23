import { createHash } from "node:crypto";
import { readdir, readFile, rename, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const requiredCommands = [
  "developerBuild",
  "developerReload",
  "launch",
  "waitForDashboard",
  "processIds",
  "closeDashboard",
  "openDashboard",
  "triggerReconnect",
  "waitForReconnect",
  "stop",
] as const;

type CommandName = (typeof requiredCommands)[number];

interface MeasurementConfig {
  readonly schemaVersion: 1;
  readonly runtime: string;
  readonly buildId: string;
  readonly workingDirectory: string;
  readonly release: {
    readonly distributionPath: string;
    readonly installedPath: string;
  };
  readonly commands: Record<CommandName, string>;
  readonly sampling: {
    readonly settleSeconds: number;
    readonly intervalSeconds: number;
    readonly sampleCount: number;
  };
}

interface IdleMeasurement {
  readonly residentMemoryBytes: number;
  readonly cpuPercent: number;
  readonly wakeupsPerSecond: number;
  readonly sampleCount: number;
  readonly sampleIntervalSeconds: number;
  readonly processIds: readonly number[];
}

interface MeasurementRecord {
  readonly schemaVersion: 1;
  readonly runtime: string;
  readonly buildId: string;
  readonly measuredAt: string;
  readonly source: {
    readonly configurationPath: string;
    readonly configurationSha256: string;
    readonly repositoryCommit: string;
    readonly repositoryDirty: boolean;
  };
  readonly host: {
    readonly macOSVersion: string;
    readonly hardwareModel: string;
    readonly processor: string;
    readonly memoryBytes: number | null;
  };
  readonly sizes: {
    readonly compressedDistributionBytes: number;
    readonly installedBytes: number;
  };
  readonly idle: {
    readonly dashboardOpen: IdleMeasurement;
    readonly dashboardClosed: IdleMeasurement;
  };
  readonly timings: {
    readonly startupMilliseconds: number;
    readonly reconnectMilliseconds: number;
    readonly developerBuildMilliseconds: number;
    readonly developerReloadMilliseconds: number;
  };
}

interface CliArguments {
  readonly configPath: string;
  readonly outputPath?: string;
  readonly comparisonPath?: string;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

function usage(): string {
  return [
    "Usage: bun run measure:release --config <path> [--output <path>] [--comparison <path>]",
    "",
    "Measures one production release and records a versioned JSON result plus a",
    "side-by-side Markdown comparison.",
  ].join("\n");
}

function parseArguments(arguments_: readonly string[]): CliArguments {
  let configPath: string | undefined;
  let outputPath: string | undefined;
  let comparisonPath: string | undefined;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (argument === "--help" || argument === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (argument === "--config" || argument === "--output" || argument === "--comparison") {
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${argument} requires a path`);
      }
      if (argument === "--config") configPath = value;
      if (argument === "--output") outputPath = value;
      if (argument === "--comparison") comparisonPath = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${String(argument)}\n\n${usage()}`);
  }

  if (configPath === undefined) {
    throw new Error(`--config is required\n\n${usage()}`);
  }
  return {
    configPath,
    ...(outputPath === undefined ? {} : { outputPath }),
    ...(comparisonPath === undefined ? {} : { comparisonPath }),
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required and must be a non-empty string`);
  }
  return value;
}

function finiteNumber(value: unknown, field: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new Error(`${field} must be a finite number greater than or equal to ${minimum}`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = finiteNumber(value, field, 1);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${field} must be an integer`);
  }
  return parsed;
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} is required and must be an object`);
  }
  return value as Record<string, unknown>;
}

function resolveFrom(baseDirectory: string, target: string): string {
  return path.isAbsolute(target) ? target : path.resolve(baseDirectory, target);
}

function parseConfig(value: unknown, configPath: string): MeasurementConfig {
  const input = objectValue(value, "configuration");
  if (input.schemaVersion !== 1) {
    throw new Error("schemaVersion must be 1");
  }
  const release = objectValue(input.release, "release");
  const commandsInput = objectValue(input.commands, "commands");
  const samplingInput = input.sampling === undefined ? {} : objectValue(input.sampling, "sampling");
  const configDirectory = path.dirname(configPath);
  const commands = Object.fromEntries(
    requiredCommands.map((name) => [name, requiredString(commandsInput[name], `commands.${name}`)]),
  ) as unknown as Record<CommandName, string>;

  return {
    schemaVersion: 1,
    runtime: requiredString(input.runtime, "runtime"),
    buildId: requiredString(input.buildId, "buildId"),
    workingDirectory: resolveFrom(
      configDirectory,
      input.workingDirectory === undefined
        ? "."
        : requiredString(input.workingDirectory, "workingDirectory"),
    ),
    release: {
      distributionPath: resolveFrom(
        configDirectory,
        requiredString(release.distributionPath, "release.distributionPath"),
      ),
      installedPath: resolveFrom(
        configDirectory,
        requiredString(release.installedPath, "release.installedPath"),
      ),
    },
    commands,
    sampling: {
      settleSeconds: finiteNumber(samplingInput.settleSeconds ?? 15, "sampling.settleSeconds", 0),
      intervalSeconds: finiteNumber(
        samplingInput.intervalSeconds ?? 1,
        "sampling.intervalSeconds",
        0.1,
      ),
      sampleCount: positiveInteger(samplingInput.sampleCount ?? 10, "sampling.sampleCount"),
    },
  };
}

async function run(
  executable: string,
  arguments_: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, [...arguments_], {
      cwd,
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
    child.once("exit", (exitCode, signal) => {
      if (exitCode === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `${executable} ${arguments_.join(" ")} failed (${signal ?? `exit ${String(exitCode)}`}): ${stderr.trim() || stdout.trim()}`,
        ),
      );
    });
  });
}

async function runProtocolCommand(
  config: MeasurementConfig,
  name: CommandName,
): Promise<CommandResult> {
  return await run("/bin/zsh", ["-c", config.commands[name]], config.workingDirectory);
}

async function measureCommand(config: MeasurementConfig, name: CommandName): Promise<number> {
  const startedAt = performance.now();
  await runProtocolCommand(config, name);
  return round(performance.now() - startedAt);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

async function settle(seconds: number): Promise<void> {
  if (seconds === 0) return;
  await new Promise((resolve) => setTimeout(resolve, seconds * 1_000));
}

async function processIds(config: MeasurementConfig): Promise<number[]> {
  const result = await runProtocolCommand(config, "processIds");
  const tokens = result.stdout.trim().split(/\s+/).filter(Boolean);
  const ids = tokens.map((token) => Number(token));
  if (ids.length === 0 || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error(
      `commands.processIds must print one or more process IDs separated by whitespace; received ${JSON.stringify(result.stdout.trim())}`,
    );
  }
  return [...new Set(ids)];
}

function parseBytes(value: string): number {
  const match = /^([0-9]+(?:\.[0-9]+)?)([KMGTP]?)B?[+-]?$/i.exec(value);
  if (match === null) {
    throw new Error(`Unable to parse resident memory value from top: ${value}`);
  }
  const amount = Number(match[1]);
  const units: Record<string, number> = {
    "": 1,
    K: 1_024,
    M: 1_024 ** 2,
    G: 1_024 ** 3,
    T: 1_024 ** 4,
    P: 1_024 ** 5,
  };
  return amount * (units[(match[2] ?? "").toUpperCase()] ?? 1);
}

function parseCounter(value: string, field: string): number {
  const parsed = Number(value.replace(/[+%-]/g, ""));
  if (!Number.isFinite(parsed)) {
    throw new Error(`Unable to parse ${field} value from top: ${value}`);
  }
  return parsed;
}

type TopProcessSample = { cpu: number; resident: number; wakeups: number };

function parseTopOutput(
  output: string,
  expectedProcessIds: readonly number[],
  parseResident: boolean,
): Array<Map<number, TopProcessSample>> {
  const samples: Array<Map<number, TopProcessSample>> = [];
  let current: Map<number, TopProcessSample> | undefined;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^PID\s+%?CPU\s+(?:MEM|R(?:SIZE|PRVT))\s+IDLEW$/i.test(line)) {
      current = new Map();
      samples.push(current);
      continue;
    }
    if (current === undefined) continue;
    const columns = line.split(/\s+/);
    if (columns.length < 4) continue;
    const pid = Number(columns[0]);
    if (!expectedProcessIds.includes(pid)) continue;
    current.set(pid, {
      cpu: parseCounter(columns[1] ?? "", "CPU"),
      resident: parseResident ? parseBytes(columns[2] ?? "") : 0,
      wakeups: parseCounter(columns[3] ?? "", "idle wakeup"),
    });
  }
  return samples;
}

function usableTopSamples(
  samples: Array<Map<number, TopProcessSample>>,
  expectedProcessIds: readonly number[],
  sampleCount: number,
  mode: "delta" | "current",
): Array<Map<number, TopProcessSample>> {
  const usable = samples.slice(1);
  if (usable.length !== sampleCount) {
    throw new Error(
      `top ${mode} mode returned ${usable.length} usable samples; expected ${sampleCount}`,
    );
  }
  for (const [index, sample] of usable.entries()) {
    const missing = expectedProcessIds.filter((pid) => !sample.has(pid));
    if (missing.length > 0) {
      throw new Error(
        `top ${mode} sample ${index + 1} omitted configured process IDs: ${missing.join(", ")}`,
      );
    }
  }
  return usable;
}

function parseTopSamples(
  deltaOutput: string,
  currentOutput: string,
  expectedProcessIds: readonly number[],
  sampleCount: number,
  intervalSeconds: number,
): IdleMeasurement {
  const deltaSamples = usableTopSamples(
    parseTopOutput(deltaOutput, expectedProcessIds, false),
    expectedProcessIds,
    sampleCount,
    "delta",
  );
  const currentSamples = usableTopSamples(
    parseTopOutput(currentOutput, expectedProcessIds, true),
    expectedProcessIds,
    sampleCount,
    "current",
  );

  const totals = deltaSamples.map((sample, index) => {
    const current = currentSamples[index]!;
    return {
      cpu: [...sample.values()].reduce((sum, process) => sum + process.cpu, 0),
      resident: [...current.values()].reduce((sum, process) => sum + process.resident, 0),
      wakeups: [...sample.values()].reduce((sum, process) => sum + process.wakeups, 0),
    };
  });
  return {
    residentMemoryBytes: Math.round(
      totals.reduce((sum, sample) => sum + sample.resident, 0) / sampleCount,
    ),
    cpuPercent: round(totals.reduce((sum, sample) => sum + sample.cpu, 0) / sampleCount),
    wakeupsPerSecond: round(
      totals.reduce((sum, sample) => sum + sample.wakeups, 0) / (sampleCount * intervalSeconds),
    ),
    sampleCount,
    sampleIntervalSeconds: intervalSeconds,
    processIds: expectedProcessIds,
  };
}

async function measureIdle(config: MeasurementConfig): Promise<IdleMeasurement> {
  await settle(config.sampling.settleSeconds);
  const ids = await processIds(config);
  const commonArguments = [
    "-l",
    String(config.sampling.sampleCount + 1),
    "-s",
    String(config.sampling.intervalSeconds),
    ...ids.flatMap((id) => ["-pid", String(id)]),
    "-stats",
    "pid,cpu,rsize,idlew",
  ];
  const [deltaResult, currentResult] = await Promise.all([
    run("top", ["-c", "d", ...commonArguments], config.workingDirectory),
    run("top", ["-c", "n", ...commonArguments], config.workingDirectory),
  ]);
  return parseTopSamples(
    deltaResult.stdout,
    currentResult.stdout,
    ids,
    config.sampling.sampleCount,
    config.sampling.intervalSeconds,
  );
}

async function installedBytes(installedPath: string, cwd: string): Promise<number> {
  const result = await run("du", ["-sk", installedPath], cwd);
  const blocks = Number(result.stdout.trim().split(/\s+/)[0]);
  if (!Number.isFinite(blocks)) {
    throw new Error(`Unable to read installed size from du: ${result.stdout.trim()}`);
  }
  return blocks * 1_024;
}

async function optionalCommand(
  executable: string,
  arguments_: readonly string[],
  cwd: string,
): Promise<string> {
  try {
    return (await run(executable, arguments_, cwd)).stdout.trim();
  } catch {
    return "unknown";
  }
}

async function hostMetadata(): Promise<MeasurementRecord["host"]> {
  const [macOSVersion, hardwareModel, processor, memory] = await Promise.all([
    optionalCommand("sw_vers", ["-productVersion"], repositoryRoot),
    optionalCommand("sysctl", ["-n", "hw.model"], repositoryRoot),
    optionalCommand("sysctl", ["-n", "machdep.cpu.brand_string"], repositoryRoot),
    optionalCommand("sysctl", ["-n", "hw.memsize"], repositoryRoot),
  ]);
  const memoryBytes = Number(memory);
  return {
    macOSVersion,
    hardwareModel,
    processor,
    memoryBytes: Number.isSafeInteger(memoryBytes) ? memoryBytes : null,
  };
}

async function repositoryMetadata(): Promise<{
  readonly repositoryCommit: string;
  readonly repositoryDirty: boolean;
}> {
  const [repositoryCommit, status] = await Promise.all([
    optionalCommand("git", ["rev-parse", "HEAD"], repositoryRoot),
    optionalCommand("git", ["status", "--porcelain"], repositoryRoot),
  ]);
  return {
    repositoryCommit,
    repositoryDirty: status !== "",
  };
}

function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function defaultOutputPath(config: MeasurementConfig, measuredAt: string): string {
  const timestamp = measuredAt.replace(/[:.]/g, "-");
  return path.join(
    repositoryRoot,
    "docs",
    "measurements",
    "results",
    `${safeFilename(config.runtime)}-${safeFilename(config.buildId)}-${timestamp}.json`,
  );
}

async function writeJsonAtomic(target: string, record: MeasurementRecord): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporaryPath = `${target}.tmp-${String(process.pid)}`;
  await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`);
  await rename(temporaryPath, target);
}

function formatMebibytes(bytes: number): string {
  return (bytes / 1_024 ** 2).toFixed(2);
}

function formatMetric(value: number): string {
  return value.toFixed(2);
}

function comparisonTable(records: readonly MeasurementRecord[]): string {
  const columns = [
    { label: "Runtime", numeric: false },
    { label: "Build", numeric: false },
    { label: "Measured at", numeric: false },
    { label: "Distribution MiB", numeric: true },
    { label: "Installed MiB", numeric: true },
    { label: "Open RSS MiB", numeric: true },
    { label: "Closed RSS MiB", numeric: true },
    { label: "Open CPU %", numeric: true },
    { label: "Closed CPU %", numeric: true },
    { label: "Open Wakeups/s", numeric: true },
    { label: "Closed Wakeups/s", numeric: true },
    { label: "Startup ms", numeric: true },
    { label: "Reconnect ms", numeric: true },
    { label: "Dev build ms", numeric: true },
    { label: "Dev reload ms", numeric: true },
  ] as const;
  const values = records.map((record) => [
    record.runtime.replaceAll("|", "\\|"),
    record.buildId.replaceAll("|", "\\|"),
    record.measuredAt,
    formatMebibytes(record.sizes.compressedDistributionBytes),
    formatMebibytes(record.sizes.installedBytes),
    formatMebibytes(record.idle.dashboardOpen.residentMemoryBytes),
    formatMebibytes(record.idle.dashboardClosed.residentMemoryBytes),
    formatMetric(record.idle.dashboardOpen.cpuPercent),
    formatMetric(record.idle.dashboardClosed.cpuPercent),
    formatMetric(record.idle.dashboardOpen.wakeupsPerSecond),
    formatMetric(record.idle.dashboardClosed.wakeupsPerSecond),
    formatMetric(record.timings.startupMilliseconds),
    formatMetric(record.timings.reconnectMilliseconds),
    formatMetric(record.timings.developerBuildMilliseconds),
    formatMetric(record.timings.developerReloadMilliseconds),
  ]);
  const widths = columns.map((column, index) =>
    Math.max(column.label.length, ...values.map((row) => row[index]?.length ?? 0)),
  );
  const renderRow = (row: readonly string[], header: boolean): string =>
    `| ${row
      .map((cell, index) => {
        const width = widths[index] ?? cell.length;
        return !header && columns[index]?.numeric ? cell.padStart(width) : cell.padEnd(width);
      })
      .join(" | ")} |`;
  const separator = `| ${columns
    .map((column, index) => {
      const width = widths[index] ?? column.label.length;
      return column.numeric ? `${"-".repeat(width - 1)}:` : "-".repeat(width);
    })
    .join(" | ")} |`;

  return [
    "# Release Runtime Comparison",
    "",
    "Generated by `bun run measure:release`. Values are direct measurements; columns are not substitutes for one another.",
    "",
    renderRow(
      columns.map((column) => column.label),
      true,
    ),
    separator,
    ...values.map((row) => renderRow(row, false)),
    "",
  ].join("\n");
}

function isMeasurementRecord(value: unknown): value is MeasurementRecord {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<MeasurementRecord>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.runtime === "string" &&
    typeof candidate.buildId === "string" &&
    typeof candidate.measuredAt === "string" &&
    candidate.sizes !== undefined &&
    candidate.idle !== undefined &&
    candidate.timings !== undefined
  );
}

async function updateComparison(resultsDirectory: string, comparisonPath: string): Promise<void> {
  const entries = await readdir(resultsDirectory, { withFileTypes: true });
  const records: MeasurementRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name) !== ".json") continue;
    try {
      const value: unknown = JSON.parse(
        await readFile(path.join(resultsDirectory, entry.name), "utf8"),
      );
      if (isMeasurementRecord(value)) records.push(value);
    } catch {
      // Ignore unrelated or incomplete JSON files in a custom results directory.
    }
  }
  records.sort(
    (left, right) =>
      left.runtime.localeCompare(right.runtime) ||
      left.buildId.localeCompare(right.buildId) ||
      left.measuredAt.localeCompare(right.measuredAt),
  );
  await mkdir(path.dirname(comparisonPath), { recursive: true });
  await writeFile(comparisonPath, comparisonTable(records));
}

async function measure(
  config: MeasurementConfig,
  configPath: string,
  configSource: string,
): Promise<MeasurementRecord> {
  const developerBuildMilliseconds = await measureCommand(config, "developerBuild");
  const developerReloadMilliseconds = await measureCommand(config, "developerReload");
  const measuredAt = new Date().toISOString();
  const distribution = await stat(config.release.distributionPath);
  if (!distribution.isFile()) {
    throw new Error(
      `release.distributionPath must name the compressed distribution file: ${config.release.distributionPath}`,
    );
  }
  const installed = await stat(config.release.installedPath);
  if (!installed.isDirectory()) {
    throw new Error(
      `release.installedPath must name the installed application directory: ${config.release.installedPath}`,
    );
  }

  let launched = false;
  try {
    const startupStartedAt = performance.now();
    await runProtocolCommand(config, "launch");
    launched = true;
    await runProtocolCommand(config, "waitForDashboard");
    const startupMilliseconds = round(performance.now() - startupStartedAt);
    const dashboardOpen = await measureIdle(config);

    await runProtocolCommand(config, "closeDashboard");
    const dashboardClosed = await measureIdle(config);

    await runProtocolCommand(config, "openDashboard");
    const reconnectStartedAt = performance.now();
    await runProtocolCommand(config, "triggerReconnect");
    await runProtocolCommand(config, "waitForReconnect");
    const reconnectMilliseconds = round(performance.now() - reconnectStartedAt);

    const [host, repository, installedSize] = await Promise.all([
      hostMetadata(),
      repositoryMetadata(),
      installedBytes(config.release.installedPath, config.workingDirectory),
    ]);
    return {
      schemaVersion: 1,
      runtime: config.runtime,
      buildId: config.buildId,
      measuredAt,
      source: {
        configurationPath: path.relative(repositoryRoot, configPath),
        configurationSha256: createHash("sha256").update(configSource).digest("hex"),
        ...repository,
      },
      host,
      sizes: {
        compressedDistributionBytes: distribution.size,
        installedBytes: installedSize,
      },
      idle: {
        dashboardOpen,
        dashboardClosed,
      },
      timings: {
        startupMilliseconds,
        reconnectMilliseconds,
        developerBuildMilliseconds,
        developerReloadMilliseconds,
      },
    };
  } finally {
    if (launched) {
      await runProtocolCommand(config, "stop");
    }
  }
}

async function main(): Promise<void> {
  const cliArguments = parseArguments(process.argv.slice(2));
  const configPath = path.resolve(cliArguments.configPath);
  const configSource = await readFile(configPath, "utf8");
  const config = parseConfig(JSON.parse(configSource) as unknown, configPath);
  const record = await measure(config, configPath, configSource);
  const outputPath =
    cliArguments.outputPath === undefined
      ? defaultOutputPath(config, record.measuredAt)
      : path.resolve(cliArguments.outputPath);
  const comparisonPath =
    cliArguments.comparisonPath === undefined
      ? path.join(repositoryRoot, "docs", "measurements", "comparison.md")
      : path.resolve(cliArguments.comparisonPath);
  await writeJsonAtomic(outputPath, record);
  await updateComparison(path.dirname(outputPath), comparisonPath);
  console.log(`Recorded release measurement: ${outputPath}`);
  console.log(`Updated release comparison: ${comparisonPath}`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
