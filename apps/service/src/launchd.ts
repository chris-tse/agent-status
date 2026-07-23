import { execFile } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ServiceSupervisor } from "./lifecycle.js";

const DEFAULT_LABEL = "com.status-dashboard.service";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  arguments_: readonly string[],
) => Promise<CommandResult>;

export interface LaunchdSupervisorOptions {
  uid: number;
  supportDirectory: string;
  executable: string;
  serviceArguments: readonly string[];
  workingDirectory: string;
  environment?: Readonly<Record<string, string>>;
  label?: string;
  launchctlPath?: string;
  run?: CommandRunner;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function renderStringArray(values: readonly string[]): string {
  return values.map((value) => `      <string>${escapeXml(value)}</string>`).join("\n");
}

function renderEnvironment(environment: Readonly<Record<string, string>>): string {
  const entries = Object.entries(environment).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  if (entries.length === 0) return "";
  const values = entries
    .flatMap(([key, value]) => [
      `      <key>${escapeXml(key)}</key>`,
      `      <string>${escapeXml(value)}</string>`,
    ])
    .join("\n");
  return `\n    <key>EnvironmentVariables</key>\n    <dict>\n${values}\n    </dict>`;
}

function renderLaunchAgent(options: {
  label: string;
  executable: string;
  serviceArguments: readonly string[];
  workingDirectory: string;
  standardOutputPath: string;
  standardErrorPath: string;
  environment: Readonly<Record<string, string>>;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${escapeXml(options.label)}</string>
    <key>ProgramArguments</key>
    <array>
${renderStringArray([options.executable, ...options.serviceArguments])}
    </array>
    <key>WorkingDirectory</key>
    <string>${escapeXml(options.workingDirectory)}</string>${renderEnvironment(options.environment)}
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ProcessType</key>
    <string>Background</string>
    <key>LimitLoadToSessionType</key>
    <string>Aqua</string>
    <key>ThrottleInterval</key>
    <integer>1</integer>
    <key>StandardOutPath</key>
    <string>${escapeXml(options.standardOutputPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(options.standardErrorPath)}</string>
  </dict>
</plist>
`;
}

export const runCommand: CommandRunner = async (command, arguments_) =>
  await new Promise((resolve, reject) => {
    execFile(command, [...arguments_], { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ exitCode: 0, stdout, stderr });
        return;
      }
      if (typeof error.code === "number") {
        resolve({ exitCode: error.code, stdout, stderr });
        return;
      }
      reject(error);
    });
  });

function launchctlError(action: string, result: CommandResult): Error {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
  return new Error(`launchctl ${action} failed: ${detail}`);
}

export function createLaunchdSupervisor(options: LaunchdSupervisorOptions): ServiceSupervisor {
  const label = options.label ?? DEFAULT_LABEL;
  const launchctlPath = options.launchctlPath ?? "/bin/launchctl";
  const run = options.run ?? runCommand;
  const sessionDomain = `gui/${options.uid}`;
  const jobTarget = `${sessionDomain}/${label}`;
  const launchdDirectory = join(options.supportDirectory, "launchd");
  const logsDirectory = join(options.supportDirectory, "logs");
  const plistPath = join(launchdDirectory, `${label}.plist`);

  async function isActive(): Promise<boolean> {
    const result = await run(launchctlPath, ["print", jobTarget]);
    return result.exitCode === 0;
  }

  return {
    isActive,
    async activate() {
      if (await isActive()) return;
      await Promise.all([
        mkdir(launchdDirectory, { recursive: true }),
        mkdir(logsDirectory, { recursive: true }),
      ]);
      const plist = renderLaunchAgent({
        label,
        executable: options.executable,
        serviceArguments: options.serviceArguments,
        workingDirectory: options.workingDirectory,
        standardOutputPath: join(logsDirectory, "service.stdout.log"),
        standardErrorPath: join(logsDirectory, "service.stderr.log"),
        environment: options.environment ?? {},
      });
      const temporaryPath = `${plistPath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, plist, { mode: 0o600 });
      await rename(temporaryPath, plistPath);

      const result = await run(launchctlPath, ["bootstrap", sessionDomain, plistPath]);
      if (result.exitCode !== 0 && !(await isActive())) {
        throw launchctlError("bootstrap", result);
      }
    },
    async deactivate() {
      if (!(await isActive())) return;
      const result = await run(launchctlPath, ["bootout", jobTarget]);
      if (result.exitCode !== 0) {
        throw launchctlError("bootout", result);
      }
    },
  };
}
