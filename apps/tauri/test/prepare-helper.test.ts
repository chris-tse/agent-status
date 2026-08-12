import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareTauriHelper } from "../scripts/prepare-helper.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(async (path) => await rm(path, { recursive: true })));
});

describe("Tauri helper package", () => {
  it("contains an executable runtime and a runnable lifecycle CLI", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "status-dashboard-tauri-helper-"));
    cleanup.push(outputDirectory);

    const prepared = await prepareTauriHelper({
      outputDirectory,
      runtimeExecutable: execFileSync("which", ["bun"], { encoding: "utf8" }).trim(),
      targetTriple: "aarch64-apple-darwin",
    });
    await chmod(prepared.runtimePath, 0o755);

    const command = spawnSync(
      prepared.runtimePath,
      [prepared.lifecycleCliPath, "--json", "status"],
      {
        env: {
          ...process.env,
          HOME: outputDirectory,
          PORT: "43991",
        },
        encoding: "utf8",
      },
    );

    expect(command.error).toBeUndefined();
    expect(command.status).toBe(0);
    expect(JSON.parse(command.stdout)).toEqual({ state: "stopped" });
    expect(command.stderr).toBe("");
  });
});
import { execFileSync, spawnSync } from "node:child_process";
