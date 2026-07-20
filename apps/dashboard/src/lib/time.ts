import { useEffect, useState } from "react";

/** Re-renders on an interval so elapsed times stay live. */
export function useNow(intervalMs = 1_000): number {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);

  return now;
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;

  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function formatRelative(timestamp: string, now: number): string {
  const elapsed = now - Date.parse(timestamp);
  if (elapsed < 5_000) return "just now";
  return `${formatDuration(elapsed)} ago`;
}
