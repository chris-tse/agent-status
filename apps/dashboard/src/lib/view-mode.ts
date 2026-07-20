import { useCallback, useEffect, useState } from "react";

export type ViewMode = "rows" | "tiles";

export const VIEW_MODE_STORAGE_KEY = "dashboard.viewMode";

function loadViewMode(): ViewMode {
  try {
    return window.localStorage.getItem(VIEW_MODE_STORAGE_KEY) === "tiles"
      ? "tiles"
      : "rows";
  } catch {
    return "rows";
  }
}

export function useViewMode(): [ViewMode, () => void] {
  const [mode, setMode] = useState<ViewMode>(loadViewMode);

  useEffect(() => {
    try {
      window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
    } catch {
      // The view still changes when storage is unavailable.
    }
  }, [mode]);

  const toggle = useCallback(() => {
    setMode((current) => (current === "rows" ? "tiles" : "rows"));
  }, []);

  return [mode, toggle];
}
