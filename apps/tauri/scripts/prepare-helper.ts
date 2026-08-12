import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface PrepareTauriHelperOptions {
  outputDirectory: string;
  runtimeExecutable: string;
  targetTriple: string;
}

export interface PreparedTauriHelper {
  runtimePath: string;
  serviceEntryPointPath: string;
  lifecycleCliPath: string;
}

const tauriDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(tauriDirectory, "../..");

async function run(command: string, arguments_: readonly string[]): Promise<void> {
  await new Promise<void>((resolveRun, reject) => {
    execFile(command, [...arguments_], { cwd: repositoryRoot }, (error, _stdout, stderr) => {
      if (error === null) {
        resolveRun();
        return;
      }
      reject(new Error(stderr.trim() || error.message));
    });
  });
}

export async function prepareTauriHelper(
  options: PrepareTauriHelperOptions,
): Promise<PreparedTauriHelper> {
  const binariesDirectory = join(options.outputDirectory, "binaries");
  const serviceDirectory = join(options.outputDirectory, "generated", "service");
  const runtimePath = join(binariesDirectory, `status-service-runtime-${options.targetTriple}`);

  await Promise.all([
    mkdir(binariesDirectory, { recursive: true }),
    rm(serviceDirectory, { recursive: true, force: true }),
  ]);
  await mkdir(serviceDirectory, { recursive: true });

  await Promise.all([
    run(options.runtimeExecutable, [
      "build",
      join(repositoryRoot, "apps/service/src/index.ts"),
      "--target=bun",
      "--format=esm",
      "--minify",
      `--outfile=${join(serviceDirectory, "index.js")}`,
    ]),
    run(options.runtimeExecutable, [
      "build",
      join(repositoryRoot, "apps/service/src/lifecycle-cli.ts"),
      "--target=bun",
      "--format=esm",
      "--minify",
      `--outfile=${join(serviceDirectory, "lifecycle-cli.js")}`,
    ]),
  ]);

  await copyFile(options.runtimeExecutable, runtimePath);
  await chmod(runtimePath, 0o755);

  return {
    runtimePath,
    serviceEntryPointPath: join(serviceDirectory, "index.js"),
    lifecycleCliPath: join(serviceDirectory, "lifecycle-cli.js"),
  };
}

function currentTargetTriple(): string {
  const result = Bun.spawnSync(["rustc", "--print", "host-tuple"]);
  if (result.exitCode !== 0) {
    throw new Error(`Could not determine Rust target: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
}

function verifyTauriCli(): void {
  const result = Bun.spawnSync(["cargo", "tauri", "--version"]);
  const version = result.stdout.toString().trim();
  if (result.exitCode !== 0 || version !== "tauri-cli 2.11.1") {
    throw new Error(
      `Tauri CLI 2.11.1 is required (received ${version || result.stderr.toString().trim()})`,
    );
  }
}

if (import.meta.main) {
  verifyTauriCli();
  await prepareTauriHelper({
    outputDirectory: join(tauriDirectory, "src-tauri"),
    runtimeExecutable: process.execPath,
    targetTriple: currentTargetTriple(),
  });
}
