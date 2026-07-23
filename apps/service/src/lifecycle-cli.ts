import {
  createDefaultServiceLifecycle,
  type ServiceLifecycle,
  type ServiceLifecycleStatus,
} from "./lifecycle.js";

const USAGE = "Usage: bun run service <status|start|stop|restart>";

export interface LifecycleCliOutput {
  log(message: string): void;
  error(message: string): void;
}

function describe(status: ServiceLifecycleStatus): string {
  return status.message === undefined ? status.state : `${status.state}: ${status.message}`;
}

export async function runLifecycleCli(
  arguments_: readonly string[],
  lifecycle: ServiceLifecycle = createDefaultServiceLifecycle(),
  output: LifecycleCliOutput = console,
): Promise<number> {
  const command = arguments_[0];
  if (command !== "status" && command !== "start" && command !== "stop" && command !== "restart") {
    output.error(USAGE);
    return 2;
  }

  try {
    const status = await lifecycle[command]();
    output.log(describe(status));
    return status.state === "unhealthy" ? 1 : 0;
  } catch (error) {
    output.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runLifecycleCli(process.argv.slice(2));
}
