import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A column a person can drag wider or narrower (D-065).
 *
 * Both of Novus's side columns are things a developer lives in: the rail holds
 * project names that are frequently longer than 240px, and the evidence panel
 * holds diffs, whose readable width is a property of the code being read and
 * not of a number chosen once. Fixed widths made both of them somebody else's
 * decision.
 *
 * The width is remembered per column, on this machine, because it is a fact
 * about how this person works rather than about the mission — the same reason
 * the working set is local (D-061).
 */

/** Where a column's own edge is: the rail's is on its right, the panel's on
 *  its left, and the drag reads the opposite way for each. */
export type Edge = "right" | "left";

export function useColumnWidth(
  key: string,
  fallback: number,
  min: number,
  max: number
): [number, (next: number) => void] {
  const clamp = useCallback((value: number) => Math.min(max, Math.max(min, value)), [min, max]);
  const [width, setWidth] = useState<number>(() => {
    try {
      if (typeof localStorage === "undefined") return fallback;
      const stored = Number.parseInt(localStorage.getItem(key) ?? "", 10);
      return Number.isFinite(stored) ? clamp(stored) : fallback;
    } catch {
      return fallback;
    }
  });

  const set = useCallback(
    (next: number) => {
      const value = clamp(Math.round(next));
      setWidth(value);
      try {
        if (typeof localStorage !== "undefined") localStorage.setItem(key, String(value));
      } catch {
        /* A store that will not take a write is not a reason to stop working. */
      }
    },
    [clamp, key]
  );

  return [width, set];
}

/**
 * The handle itself: a hairline that widens to a comfortable target without
 * taking any layout width, so dragging is easy and the seam stays a seam.
 *
 * Keyboard-operable, because a column a person cannot resize without a mouse is
 * a column some people cannot resize. Arrow keys move it a step at a time;
 * Home returns it to where it started.
 */
export function ColumnHandle({
  edge,
  width,
  onWidth,
  reset,
  label,
  step = 16
}: {
  edge: Edge;
  width: number;
  onWidth: (next: number) => void;
  reset: number;
  label: string;
  step?: number;
}) {
  const dragging = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const from = dragging.current;
      if (!from) return;
      const delta = event.clientX - from.startX;
      onWidth(from.startWidth + (edge === "right" ? delta : -delta));
    };
    const end = () => {
      if (!dragging.current) return;
      dragging.current = null;
      document.body.classList.remove("resizing");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [edge, onWidth]);

  return (
    <div
      className={`column-handle column-handle-${edge}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      data-testid="column-handle"
      onPointerDown={(event) => {
        dragging.current = { startX: event.clientX, startWidth: width };
        document.body.classList.add("resizing");
      }}
      onDoubleClick={() => onWidth(reset)}
      onKeyDown={(event) => {
        const out = edge === "right" ? step : -step;
        if (event.key === "ArrowRight") onWidth(width + out);
        else if (event.key === "ArrowLeft") onWidth(width - out);
        else if (event.key === "Home") onWidth(reset);
        else return;
        event.preventDefault();
      }}
    />
  );
}
