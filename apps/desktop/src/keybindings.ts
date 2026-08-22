import { useSyncExternalStore } from "react";

/**
 * The rebindable chords (D-177's recorded revisit). Only single ⌘-chords live
 * here: the mission range ⌘1–9 is a range, the room's G sequences and bare
 * letters are modal, and Esc is the platform's own word — none of those can
 * honestly wear a pencil. Defaults are the shipped keys; a person's overrides
 * live in localStorage on this machine, like the theme does.
 */

export type BindingAction =
  | "palette"
  | "newMission"
  | "toggleRail"
  | "toggleDock"
  | "togglePanel"
  | "openSettings"
  | "find"
  | "nextMission"
  | "previousMission";

/** One chord. ⌘ (or Ctrl elsewhere) is always implied — these are global
 *  chords, and a global binding without a modifier would eat plain typing. */
export interface Chord {
  key: string;
  shift: boolean;
  alt: boolean;
}

export const BINDING_ACTIONS: { action: BindingAction; does: string }[] = [
  { action: "palette", does: "Open the command palette" },
  { action: "newMission", does: "Start a mission in the selected project" },
  { action: "toggleRail", does: "Show or hide the projects rail" },
  { action: "toggleDock", does: "Show or hide the terminal dock" },
  { action: "togglePanel", does: "Show or hide the evidence panel" },
  { action: "find", does: "Find in the conversation" },
  { action: "openSettings", does: "Open the theme control" },
  // Moving along the open rooms (D-212): the strip is a ring, Tab walks it.
  { action: "nextMission", does: "Go to the next open mission" },
  { action: "previousMission", does: "Go to the previous open mission" }
];

const DEFAULTS: Record<BindingAction, Chord> = {
  palette: { key: "k", shift: false, alt: false },
  newMission: { key: "t", shift: false, alt: false },
  toggleRail: { key: "b", shift: false, alt: false },
  toggleDock: { key: "j", shift: false, alt: false },
  togglePanel: { key: "e", shift: false, alt: false },
  openSettings: { key: ",", shift: false, alt: false },
  find: { key: "f", shift: false, alt: false },
  nextMission: { key: "tab", shift: false, alt: false },
  previousMission: { key: "tab", shift: true, alt: false }
};

const STORAGE_KEY = "novus.keybindings";

/** Bare-⌘ keys the app may not take: quit, close, the edit set every field
 *  needs, the mission range, and the room's own fixed chords (⌘Enter, ⌘.). */
const RESERVED = new Set(["q", "w", "c", "v", "x", "a", "z", "enter", ".", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);

type Overrides = Partial<Record<BindingAction, Chord>>;

function readOverrides(): Overrides {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as Overrides;
    const held: Overrides = {};
    for (const { action } of BINDING_ACTIONS) {
      const chord = parsed[action];
      if (
        chord &&
        typeof chord.key === "string" &&
        chord.key.length > 0 &&
        typeof chord.shift === "boolean" &&
        typeof chord.alt === "boolean"
      ) {
        held[action] = { key: chord.key, shift: chord.shift, alt: chord.alt };
      }
    }
    return held;
  } catch {
    return {};
  }
}

let overrides: Overrides = typeof localStorage === "undefined" ? {} : readOverrides();
let snapshot: Record<BindingAction, Chord> = merge();
const listeners = new Set<() => void>();

function merge(): Record<BindingAction, Chord> {
  return { ...DEFAULTS, ...overrides };
}

function commit(): void {
  try {
    if (Object.keys(overrides).length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // A machine that cannot persist still rebinds for this window's lifetime.
  }
  snapshot = merge();
  for (const listener of listeners) listener();
}

export function setBinding(action: BindingAction, chord: Chord): void {
  overrides = { ...overrides, [action]: chord };
  commit();
}

export function resetBinding(action: BindingAction): void {
  const rest = { ...overrides };
  delete rest[action];
  overrides = rest;
  commit();
}

export function isOverridden(action: BindingAction): boolean {
  return overrides[action] !== undefined;
}

/** The live bindings, as a React subscription so every surface re-renders the
 *  moment a chord changes — the shell's handler and the settings page read
 *  the same snapshot. */
export function useKeybindings(): Record<BindingAction, Chord> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot
  );
}

export function matchesChord(event: KeyboardEvent, chord: Chord): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    event.shiftKey === chord.shift &&
    event.altKey === chord.alt &&
    event.key.toLowerCase() === chord.key
  );
}

/** The chord a keydown describes, or null while only modifiers are down. */
export function chordFromEvent(event: KeyboardEvent): Chord | null {
  if (["Meta", "Control", "Shift", "Alt"].includes(event.key)) return null;
  if (!(event.metaKey || event.ctrlKey)) return null;
  return { key: event.key.toLowerCase(), shift: event.shiftKey, alt: event.altKey };
}

/** Why a chord cannot be taken, in words, or null when it can. */
export function chordRefusal(action: BindingAction, chord: Chord, current: Record<BindingAction, Chord>): string | null {
  if (!chord.shift && !chord.alt && RESERVED.has(chord.key)) {
    return `⌘${prettyKey(chord.key)} belongs to the system or the room already.`;
  }
  for (const { action: other, does } of BINDING_ACTIONS) {
    if (other === action) continue;
    const held = current[other];
    if (held.key === chord.key && held.shift === chord.shift && held.alt === chord.alt) {
      return `${chordLabel(chord)} already means “${does}”.`;
    }
  }
  return null;
}

function prettyKey(key: string): string {
  if (key === "enter") return "↵";
  if (key === "escape") return "Esc";
  if (key === " ") return "Space";
  if (key === "arrowup") return "↑";
  if (key === "arrowdown") return "↓";
  if (key === "arrowleft") return "←";
  if (key === "arrowright") return "→";
  if (key === "tab") return "⇥";
  return key.length === 1 ? key.toUpperCase() : key;
}

export function chordLabel(chord: Chord): string {
  // ⌘⇥ is the platform's app switcher and never reaches the window, so a Tab
  // chord is only ever the Control one — and says so rather than claiming a
  // key it could not be (D-212).
  const modifier = chord.key === "tab" ? "⌃" : "⌘";
  return `${modifier}${chord.alt ? "⌥" : ""}${chord.shift ? "⇧" : ""}${prettyKey(chord.key)}`;
}
