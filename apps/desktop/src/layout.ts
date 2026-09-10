import { useSyncExternalStore } from "react";

/**
 * The interface is the person's to arrange (D-257): where the terminal
 * docks, where the evidence panel stands, how dense the rows are, whether Home is the board or a quiet canvas, and whether
 * motion runs. Kept on this machine, applied before first paint as data
 * attributes on the root so every surface reads them from CSS,
 * and remembered — a change made in the room (Dock right) is the same fact
 * as the one on the Layout page.
 */

export interface Layout {
  /** Where the terminal docks in the room. */
  dock: "bottom" | "right" | "left";
  /** Which edge the evidence panel stands against. */
  panel: "right" | "left";
  /** Row and spacing density. */
  density: "comfortable" | "compact";
  /** Home with no mission open: the board, or a quiet canvas. */
  home: "board" | "quiet";
  /** Motion: the product's own, or reduced (always reduced when the system asks). */
  motion: "full" | "reduced";
}

export const DEFAULT_LAYOUT: Layout = { dock: "bottom", panel: "right", density: "comfortable", home: "board", motion: "full" };

const STORAGE_KEY = "novus-layout";
export const LAYOUT_EVENT = "novus:layout";

/** Reads a stored layout leniently: an unknown field falls back to its default, never the whole layout. */
export function readLayout(raw: string | null): Layout {
  if (!raw) return { ...DEFAULT_LAYOUT };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      dock: parsed.dock === "right" || parsed.dock === "left" ? parsed.dock : "bottom",
      panel: parsed.panel === "left" ? "left" : "right",
      density: parsed.density === "compact" ? "compact" : "comfortable",
      home: parsed.home === "quiet" ? "quiet" : "board",
      motion: parsed.motion === "reduced" ? "reduced" : "full"
    };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

export function layout(): Layout {
  try {
    return readLayout(localStorage.getItem(STORAGE_KEY));
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

/** Paints a layout onto the root as attributes for CSS to key on. */
export function paintLayout(root: HTMLElement, next: Layout): void {
  root.dataset.dock = next.dock;
  root.dataset.panel = next.panel;
  root.dataset.density = next.density;
  root.dataset.home = next.home;
  root.dataset.motion = next.motion;
}

export function setLayout(patch: Partial<Layout>): Layout {
  const next: Layout = { ...layout(), ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* a browser that refuses storage keeps the layout for this run only */
  }
  paintLayout(document.documentElement, next);
  window.dispatchEvent(new Event(LAYOUT_EVENT));
  return next;
}

/** Before first paint, so nothing jumps. */
export function initLayout(): void {
  paintLayout(document.documentElement, layout());
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(LAYOUT_EVENT, onChange);
  return () => window.removeEventListener(LAYOUT_EVENT, onChange);
}

let snapshot: { raw: string | null; value: Layout } | null = null;

function snapshotLayout(): Layout {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    raw = null;
  }
  if (!snapshot || snapshot.raw !== raw) snapshot = { raw, value: readLayout(raw) };
  return snapshot.value;
}

/** The layout as React state: re-renders when any surface changes it. */
export function useLayout(): Layout {
  return useSyncExternalStore(subscribe, snapshotLayout);
}
