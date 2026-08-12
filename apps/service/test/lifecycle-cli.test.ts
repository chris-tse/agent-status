import { PROTOCOL_VERSION, SERVICE_NAME } from "@status-dashboard/model";
import { describe, expect, it, vi } from "vitest";

import { runLifecycleCli } from "../src/lifecycle-cli.js";
import type { ServiceLifecycle } from "../src/lifecycle.js";

describe("service lifecycle CLI", () => {
  it("returns the complete process and health outcome as JSON", async () => {
    const status = {
      state: "running",
      health: {
        status: "ok",
        service: SERVICE_NAME,
        protocolVersion: PROTOCOL_VERSION,
        version: 7,
        provider: "herdr",
      },
    } as const;
    const lifecycle: ServiceLifecycle = {
      status: vi.fn(async () => status),
      start: vi.fn(async () => status),
      stop: vi.fn(async () => ({ state: "stopped" as const })),
      restart: vi.fn(async () => status),
    };
    const output = { log: vi.fn(), error: vi.fn() };

    await expect(runLifecycleCli(["--json", "status"], lifecycle, output)).resolves.toBe(0);

    expect(output.log).toHaveBeenCalledWith(JSON.stringify(status));
    expect(output.error).not.toHaveBeenCalled();
  });
});
