import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type DesktopLifecycleState = "stopped" | "starting" | "running" | "restarting" | "unhealthy";

export type DesktopLifecycleOutcome = {
  state: DesktopLifecycleState;
  message?: string | null;
};

export type DesktopLifecycleClient = {
  status: () => Promise<DesktopLifecycleOutcome>;
  start: () => Promise<DesktopLifecycleOutcome>;
  stop: () => Promise<DesktopLifecycleOutcome>;
  restart: () => Promise<DesktopLifecycleOutcome>;
  openLogs: () => Promise<void>;
};

export type DesktopLifecycleControls = {
  state: DesktopLifecycleState;
  message?: string;
  pendingAction: "start" | "stop" | "restart" | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  restart: () => Promise<void>;
  isOpeningLogs: boolean;
  diagnosticError?: string;
  openLogs: () => Promise<void>;
};

export type NativeInvoke = (command: string) => Promise<unknown>;

declare global {
  interface Window {
    __TAURI__?: {
      core: {
        invoke: <T>(command: string) => Promise<T>;
      };
    };
  }
}

export function createDesktopLifecycleClient(invoke: NativeInvoke): DesktopLifecycleClient {
  return {
    status: async () => (await invoke("service_status")) as DesktopLifecycleOutcome,
    start: async () => (await invoke("service_start")) as DesktopLifecycleOutcome,
    stop: async () => (await invoke("service_stop")) as DesktopLifecycleOutcome,
    restart: async () => (await invoke("service_restart")) as DesktopLifecycleOutcome,
    openLogs: async () => {
      await invoke("open_diagnostic_logs");
    },
  };
}

function nativeLifecycleClient(): DesktopLifecycleClient | null {
  const invoke = window["__TAURI__"]?.core.invoke;
  return invoke === undefined
    ? null
    : createDesktopLifecycleClient(async (command) => await invoke<unknown>(command));
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useDesktopLifecycle(
  clientOverride?: DesktopLifecycleClient | null,
): DesktopLifecycleControls | null {
  const nativeClient = useMemo(nativeLifecycleClient, []);
  const client = clientOverride === undefined ? nativeClient : clientOverride;
  const [outcome, setOutcome] = useState<DesktopLifecycleOutcome>({ state: "starting" });
  const [pendingAction, setPendingAction] = useState<"start" | "stop" | "restart" | null>(null);
  const [isOpeningLogs, setIsOpeningLogs] = useState(false);
  const [diagnosticError, setDiagnosticError] = useState<string>();
  const pendingActionRef = useRef(false);
  const requestGeneration = useRef(0);

  const accept = useCallback((next: DesktopLifecycleOutcome) => {
    setOutcome({
      state: next.state,
      message: next.message ?? undefined,
    });
  }, []);

  const refresh = useCallback(async () => {
    if (client === null || pendingActionRef.current) return;
    const generation = ++requestGeneration.current;
    try {
      const next = await client.status();
      if (generation === requestGeneration.current) accept(next);
    } catch (error) {
      if (generation === requestGeneration.current) {
        setOutcome({ state: "unhealthy", message: messageFor(error) });
      }
    }
  }, [accept, client]);

  useEffect(() => {
    if (client === null) return;
    void refresh();
    const interval = window.setInterval(() => void refresh(), 1_000);
    return () => window.clearInterval(interval);
  }, [client, refresh]);

  const run = useCallback(
    async (action: "start" | "stop" | "restart") => {
      if (client === null || pendingActionRef.current) return;
      pendingActionRef.current = true;
      const generation = ++requestGeneration.current;
      setPendingAction(action);
      if (action === "start") setOutcome({ state: "starting" });
      if (action === "restart") setOutcome({ state: "restarting" });
      try {
        const next = await client[action]();
        if (generation === requestGeneration.current) accept(next);
      } catch (error) {
        if (generation === requestGeneration.current) {
          setOutcome({ state: "unhealthy", message: messageFor(error) });
        }
      } finally {
        pendingActionRef.current = false;
        setPendingAction(null);
      }
    },
    [accept, client],
  );

  const openLogs = useCallback(async () => {
    if (client === null || isOpeningLogs) return;
    setIsOpeningLogs(true);
    setDiagnosticError(undefined);
    try {
      await client.openLogs();
    } catch (error) {
      setDiagnosticError(messageFor(error));
    } finally {
      setIsOpeningLogs(false);
    }
  }, [client, isOpeningLogs]);

  if (client === null) return null;
  return {
    state: outcome.state,
    message: outcome.message ?? undefined,
    pendingAction,
    start: async () => await run("start"),
    stop: async () => await run("stop"),
    restart: async () => await run("restart"),
    isOpeningLogs,
    diagnosticError,
    openLogs,
  };
}
