import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  createDesktopLifecycleClient,
  useDesktopLifecycle,
  type DesktopLifecycleClient,
  type DesktopLifecycleOutcome,
} from "../src/desktop-lifecycle";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

describe("desktop service lifecycle", () => {
  it("provides status, start, stop, and restart through the native desktop boundary", async () => {
    const invoke = vi.fn(
      async (command: string): Promise<DesktopLifecycleOutcome> => ({
        state: command === "service_stop" ? "stopped" : "running",
        message: null,
      }),
    );
    const lifecycle = createDesktopLifecycleClient(invoke);

    await expect(lifecycle.status()).resolves.toMatchObject({ state: "running" });
    await expect(lifecycle.start()).resolves.toMatchObject({ state: "running" });
    await expect(lifecycle.stop()).resolves.toMatchObject({ state: "stopped" });
    await expect(lifecycle.restart()).resolves.toMatchObject({ state: "running" });

    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "service_status",
      "service_start",
      "service_stop",
      "service_restart",
    ]);
  });

  it("does not let an older status request overwrite a completed lifecycle action", async () => {
    const staleStatus = deferred<DesktopLifecycleOutcome>();
    const lifecycle: DesktopLifecycleClient = {
      status: async () => await staleStatus.promise,
      start: async () => ({ state: "running" }),
      stop: async () => ({ state: "stopped" }),
      restart: async () => ({ state: "running" }),
    };
    const { result } = renderHook(() => useDesktopLifecycle(lifecycle));

    await act(async () => {
      await result.current?.start();
    });
    expect(result.current?.state).toBe("running");

    await act(async () => {
      staleStatus.resolve({ state: "stopped" });
      await staleStatus.promise;
    });

    expect(result.current?.state).toBe("running");
  });

  it("uses the supported Tauri global boundary when the dashboard is packaged", async () => {
    const commands: string[] = [];
    const invoke = async <T>(command: string): Promise<T> => {
      commands.push(command);
      return { state: "running" } as T;
    };
    window["__TAURI__"] = { core: { invoke } };

    try {
      const { result } = renderHook(() => useDesktopLifecycle());

      await waitFor(() => expect(result.current?.state).toBe("running"));
      expect(commands).toEqual(["service_status"]);
    } finally {
      delete window["__TAURI__"];
    }
  });

  it("does not expose desktop controls in an ordinary browser", () => {
    const { result } = renderHook(() => useDesktopLifecycle());

    expect(result.current).toBeNull();
  });
});
