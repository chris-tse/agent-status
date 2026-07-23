import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PROTOCOL_VERSION, SERVICE_NAME } from "@status-dashboard/model";
import { afterEach, describe, expect, it } from "vitest";

import { createLaunchdSupervisor, type CommandResult } from "../src/launchd.js";
import { createServiceLifecycle } from "../src/lifecycle.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("launchd-backed service lifecycle", () => {
  it("uses current-login supervision without registering a login item", async () => {
    const supportDirectory = join(
      tmpdir(),
      `status-dashboard-launchd-${process.pid}-${crypto.randomUUID()}`,
    );
    temporaryDirectories.push(supportDirectory);
    const commands: Array<{ command: string; arguments: readonly string[] }> = [];
    let active = false;
    const run = async (command: string, arguments_: readonly string[]): Promise<CommandResult> => {
      commands.push({ command, arguments: arguments_ });
      if (arguments_[0] === "print") {
        return { exitCode: active ? 0 : 113, stdout: "", stderr: "" };
      }
      if (arguments_[0] === "bootstrap") {
        active = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (arguments_[0] === "bootout") {
        active = false;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected launchctl command: ${arguments_.join(" ")}`);
    };
    const supervisor = createLaunchdSupervisor({
      uid: 502,
      supportDirectory,
      executable: "/opt/status-dashboard/bin/bun",
      serviceArguments: ["/opt/status-dashboard/app/service.js"],
      workingDirectory: "/opt/status-dashboard/app",
      environment: { HOME: "/Users/example", PORT: "4317" },
      launchctlPath: "/bin/launchctl",
      run,
    });
    const lifecycle = createServiceLifecycle({
      endpoint: "http://127.0.0.1:4317",
      supervisor,
      fetch: async () => {
        if (!active) throw new TypeError("connection refused");
        return Response.json({
          status: "ok",
          service: SERVICE_NAME,
          protocolVersion: PROTOCOL_VERSION,
          version: 1,
          provider: "test",
        });
      },
    });

    await expect(lifecycle.start()).resolves.toMatchObject({ state: "running" });

    const bootstrap = commands.find(({ arguments: arguments_ }) => arguments_[0] === "bootstrap");
    expect(bootstrap?.arguments[1]).toBe("gui/502");
    const plistPath = bootstrap?.arguments[2];
    expect(plistPath).toBe(join(supportDirectory, "launchd", "com.status-dashboard.service.plist"));
    expect(plistPath).not.toContain("/Library/LaunchAgents/");
    const plist = await readFile(plistPath!, "utf8");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>SuccessfulExit</key>");
    expect(plist).toContain("<false/>");
    expect(plist).toContain("<key>LimitLoadToSessionType</key>");
    expect(plist).toContain("<string>Aqua</string>");

    active = false;
    await expect(lifecycle.status()).resolves.toMatchObject({ state: "stopped" });
    await expect(lifecycle.start()).resolves.toMatchObject({ state: "running" });

    await expect(lifecycle.stop()).resolves.toMatchObject({ state: "stopped" });
    expect(commands).toContainEqual({
      command: "/bin/launchctl",
      arguments: ["bootout", "gui/502/com.status-dashboard.service"],
    });
  });
});
