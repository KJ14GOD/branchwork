import { useCallback, useEffect, useState } from "react";

export type Theme = "dark" | "light";

const STORAGE_KEY = "novus.theme";

const readStored = (): Theme | null => {
  try {
    const value = localStorage.getItem(STORAGE_KEY);

    return value === "dark" || value === "light" ? value : null;
  } catch {
    // Storage can throw in a locked-down webview; fall back to the OS.
    return null;
  }
};

const systemPrefersLight = (): boolean =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-color-scheme: light)").matches === true;

/**
 * The theme to apply before React has rendered anything.
 *
 * Exported so `main.tsx` can stamp `data-theme` on `<html>` synchronously,
 * before the first paint — the same reason it already stamps `data-shell`
 * there rather than in an effect. Without this a stored "light" preference
 * would flash dark for one frame, the CSS default, before `useTheme`'s own
 * effect had a chance to run.
 */
export const initialTheme = (): Theme =>
  readStored() ?? (systemPrefersLight() ? "light" : "dark");

/**
 * Light/dark, persisted host-side in localStorage — this is a per-machine
 * display preference, not session state, so it has no business on the event
 * log or crossing to a guest.
 */
export const useTheme = (): { theme: Theme; toggleTheme: () => void } => {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;

    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Non-fatal — the toggle still works for the rest of this window's life.
    }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }, []);

  return { theme, toggleTheme };
};
