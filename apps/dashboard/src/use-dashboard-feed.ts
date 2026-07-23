import {
  DashboardSnapshotSchema,
  DashboardWireMessageSchema,
  type DashboardSnapshot,
} from "@status-dashboard/model";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { reduceWireMessage } from "./snapshot";

const DEFAULT_SERVICE_URL = "http://127.0.0.1:4317";

export type FeedPhase = "connecting" | "live" | "reconnecting" | "disconnected" | "error";

export type DashboardFeed = {
  snapshot: DashboardSnapshot | null;
  phase: FeedPhase;
  isRefreshing: boolean;
  error: string | null;
  lastMessageAt: number | null;
  refresh: () => Promise<void>;
  runDemoAction: (action: "advance" | "reset") => Promise<void>;
};

type ServiceUrls = {
  http: string;
  websocket: string;
};

export function getServiceUrls(
  configuredUrl = import.meta.env.VITE_STATUS_SERVICE_URL as string | undefined,
): ServiceUrls {
  const base = new URL(configuredUrl || DEFAULT_SERVICE_URL);
  base.pathname = base.pathname.replace(/\/+$/, "");
  base.search = "";
  base.hash = "";

  const http = new URL(base);
  const websocket = new URL(base);

  if (http.protocol === "ws:") http.protocol = "http:";
  if (http.protocol === "wss:") http.protocol = "https:";
  if (websocket.protocol === "http:") websocket.protocol = "ws:";
  if (websocket.protocol === "https:") websocket.protocol = "wss:";

  return {
    http: http.toString().replace(/\/$/, ""),
    websocket: websocket.toString().replace(/\/$/, ""),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown dashboard error";
}

type DashboardSocketCallbacks = {
  onOpen: (reconnected: boolean) => void;
  onMessage: (event: MessageEvent) => void;
  onInterrupted: () => void;
  onPhaseChange: (phase: FeedPhase) => void;
};

function connectDashboardSocket(url: string, callbacks: DashboardSocketCallbacks): () => void {
  const listeners = new AbortController();
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let hasConnected = false;
  let stopped = false;

  const connect = () => {
    if (stopped) return;
    callbacks.onPhaseChange(hasConnected ? "reconnecting" : "connecting");

    let nextSocket: WebSocket;
    try {
      nextSocket = new WebSocket(url);
    } catch {
      callbacks.onInterrupted();
      callbacks.onPhaseChange("reconnecting");
      const delay = Math.min(1_000 * 2 ** reconnectAttempt, 10_000);
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(connect, delay);
      return;
    }
    socket = nextSocket;

    nextSocket.addEventListener(
      "open",
      () => {
        if (stopped || socket !== nextSocket) return;
        reconnectAttempt = 0;
        callbacks.onOpen(hasConnected);
        hasConnected = true;
      },
      { signal: listeners.signal },
    );

    nextSocket.addEventListener(
      "message",
      (event) => {
        if (stopped || socket !== nextSocket) return;
        callbacks.onMessage(event);
      },
      { signal: listeners.signal },
    );

    nextSocket.addEventListener(
      "error",
      () => {
        if (stopped || socket !== nextSocket) return;
        callbacks.onInterrupted();
      },
      { signal: listeners.signal },
    );

    nextSocket.addEventListener(
      "close",
      () => {
        if (stopped || socket !== nextSocket) return;
        socket = null;
        callbacks.onPhaseChange("reconnecting");
        const delay = Math.min(1_000 * 2 ** reconnectAttempt, 10_000);
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      },
      { signal: listeners.signal },
    );
  };

  connect();

  return () => {
    stopped = true;
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    listeners.abort();
    socket?.close();
    socket = null;
  };
}

export function useDashboardFeed(): DashboardFeed {
  const urls = useMemo(() => getServiceUrls(), []);
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [phase, setPhase] = useState<FeedPhase>("connecting");
  const [isRefreshing, setIsRefreshing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastMessageAt, setLastMessageAt] = useState<number | null>(null);
  const snapshotRef = useRef<DashboardSnapshot | null>(null);
  const mountedRef = useRef(false);
  const lifecycleAbortRef = useRef<AbortController | null>(null);
  const requestSequence = useRef(0);

  const acceptSnapshot = useCallback((next: DashboardSnapshot) => {
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);

  const refresh = useCallback(async () => {
    const lifecycle = lifecycleAbortRef.current;
    if (!mountedRef.current || lifecycle === null || lifecycle.signal.aborted) return;

    const request = ++requestSequence.current;
    setIsRefreshing(true);

    try {
      const response = await fetch(`${urls.http}/api/snapshot`, {
        headers: { Accept: "application/json" },
        signal: lifecycle.signal,
      });

      if (!response.ok) {
        throw new Error(`Snapshot request failed (${response.status})`);
      }

      const parsed = DashboardSnapshotSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new Error("Snapshot response did not match the dashboard schema");
      }

      if (!mountedRef.current || request !== requestSequence.current) return;
      acceptSnapshot(parsed.data);
      setError(null);
      setLastMessageAt(Date.now());
    } catch (cause) {
      if (!mountedRef.current || request !== requestSequence.current) return;
      setError(errorMessage(cause));
      if (snapshotRef.current === null) setPhase("error");
    } finally {
      if (mountedRef.current && request === requestSequence.current) {
        setIsRefreshing(false);
      }
    }
  }, [acceptSnapshot, urls.http]);

  const runDemoAction = useCallback(
    async (action: "advance" | "reset") => {
      const lifecycle = lifecycleAbortRef.current;
      if (!mountedRef.current || lifecycle === null || lifecycle.signal.aborted) return;

      try {
        const response = await fetch(`${urls.http}/api/demo/${action}`, {
          method: "POST",
          signal: lifecycle.signal,
        });

        if (!response.ok) {
          throw new Error(`Demo ${action} failed (${response.status})`);
        }

        if (!mountedRef.current || lifecycle.signal.aborted) return;
        setError(null);
        if (action === "reset") await refresh();
      } catch (cause) {
        if (!mountedRef.current || lifecycle.signal.aborted) return;
        setError(errorMessage(cause));
      }
    },
    [refresh, urls.http],
  );

  useEffect(() => {
    const lifecycle = new AbortController();
    mountedRef.current = true;
    lifecycleAbortRef.current = lifecycle;
    let disconnectSocket: (() => void) | null = null;

    void refresh();

    if (typeof WebSocket === "undefined") {
      setPhase("disconnected");
      setError("WebSocket is not available in this browser");
    } else {
      disconnectSocket = connectDashboardSocket(`${urls.websocket}/ws`, {
        onOpen: (reconnected) => {
          setPhase("live");
          setError(null);
          if (reconnected) void refresh();
        },
        onMessage: (event) => {
          try {
            const parsedJson: unknown = JSON.parse(String(event.data));
            const parsed = DashboardWireMessageSchema.safeParse(parsedJson);

            if (!parsed.success) {
              setError("Ignored an invalid live update; refreshing snapshot");
              void refresh();
              return;
            }

            const result = reduceWireMessage(snapshotRef.current, parsed.data);
            if (result.snapshot !== snapshotRef.current) {
              snapshotRef.current = result.snapshot;
              setSnapshot(result.snapshot);
            }

            setLastMessageAt(Date.now());
            if (result.shouldRefetch) void refresh();
          } catch {
            setError("Ignored an unreadable live update; refreshing snapshot");
            void refresh();
          }
        },
        onInterrupted: () => {
          setError("Live connection was interrupted");
        },
        onPhaseChange: setPhase,
      });
    }

    return () => {
      mountedRef.current = false;
      requestSequence.current += 1;
      lifecycle.abort();
      disconnectSocket?.();
      if (lifecycleAbortRef.current === lifecycle) {
        lifecycleAbortRef.current = null;
      }
    };
  }, [refresh, urls.websocket]);

  return {
    snapshot,
    phase,
    isRefreshing,
    error,
    lastMessageAt,
    refresh,
    runDemoAction,
  };
}
