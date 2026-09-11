import { useSyncExternalStore } from "react";

/**
 * The room notices what this person does and adopts it (D-258). Three
 * habits are watched, each a small ring of recent observations kept on this
 * machine: which evidence section they open first in a room, whether they
 * open the panel soon after a turn finishes, and whether they open the
 * terminal soon after a run starts. When one choice wins five of the last
 * seven times the room adopts it as its default and says so once, with
 * Undo — nothing moves silently, and nothing leaves the machine. Learning
 * from many people's clicks is the learning pipeline's business (D-255).
 */

export type HabitKey = "firstSection" | "panelOnFinish" | "terminalOnRun";

/** What each habit can conclude. */
export type HabitValue = "overview" | "changes" | "verification" | "yes" | "no";

export interface HabitsState {
  /** Off means: observe nothing, adopt nothing, keep what was adopted. */
  noticing: boolean;
  /** The last observations per habit, oldest first. */
  observed: Record<HabitKey, HabitValue[]>;
  /** What the room adopted, and whether the person has already been told. */
  adopted: Partial<Record<HabitKey, { value: HabitValue; told: boolean }>>;
  /** Habits the person undid: not adopted again until they Forget. */
  pinned: Partial<Record<HabitKey, true>>;
}

export const WINDOW = 7;
export const MAJORITY = 5;
/** How long after a turn finishes or a run starts an opening still counts as a response to it. */
export const RESPONSE_WINDOW_MS = 20_000;

const STORAGE_KEY = "novus-habits";
export const HABITS_EVENT = "novus:habits";
const KEYS: HabitKey[] = ["firstSection", "panelOnFinish", "terminalOnRun"];
const VALUES = new Set<HabitValue>(["overview", "changes", "verification", "yes", "no"]);

export const DEFAULT_HABITS: HabitsState = {
  noticing: true,
  observed: { firstSection: [], panelOnFinish: [], terminalOnRun: [] },
  adopted: {},
  pinned: {}
};

/** Reads a stored state leniently: a bad field falls back, never the whole store. */
export function readHabits(raw: string | null): HabitsState {
  const out: HabitsState = { noticing: true, observed: { firstSection: [], panelOnFinish: [], terminalOnRun: [] }, adopted: {}, pinned: {} };
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.noticing === false) out.noticing = false;
    const observed = (parsed.observed ?? {}) as Record<string, unknown>;
    const adopted = (parsed.adopted ?? {}) as Record<string, unknown>;
    const pinned = (parsed.pinned ?? {}) as Record<string, unknown>;
    for (const key of KEYS) {
      const ring = observed[key];
      if (Array.isArray(ring)) out.observed[key] = ring.filter((v): v is HabitValue => VALUES.has(v as HabitValue)).slice(-WINDOW);
      const entry = adopted[key] as { value?: unknown; told?: unknown } | undefined;
      if (entry && VALUES.has(entry.value as HabitValue)) out.adopted[key] = { value: entry.value as HabitValue, told: entry.told === true };
      if (pinned[key] === true) out.pinned[key] = true;
    }
  } catch {
    /* noise reads as nothing noticed */
  }
  return out;
}

/** The value that wins a ring by the majority rule, or null. */
export function winnerOf(ring: HabitValue[]): HabitValue | null {
  const recent = ring.slice(-WINDOW);
  const counts = new Map<HabitValue, number>();
  for (const value of recent) counts.set(value, (counts.get(value) ?? 0) + 1);
  for (const [value, count] of counts) if (count >= MAJORITY) return value;
  return null;
}

function load(): HabitsState {
  try {
    return readHabits(localStorage.getItem(STORAGE_KEY));
  } catch {
    return readHabits(null);
  }
}

function save(state: HabitsState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* a browser that refuses storage forgets at relaunch */
  }
  window.dispatchEvent(new Event(HABITS_EVENT));
}

export function habits(): HabitsState {
  return load();
}

/**
 * Records one observation and adopts a winner. A "no" winner on a yes/no
 * habit means the room stops doing the thing, which is also an adoption
 * worth a word. A pinned habit records but never adopts.
 */
export function observe(key: HabitKey, value: HabitValue): HabitsState {
  const state = load();
  if (!state.noticing) return state;
  state.observed[key] = [...state.observed[key], value].slice(-WINDOW);
  const winner = winnerOf(state.observed[key]);
  if (winner !== null && !state.pinned[key] && state.adopted[key]?.value !== winner) {
    state.adopted[key] = { value: winner, told: false };
  }
  save(state);
  return state;
}

/** The person saw the line about an adoption. */
export function acknowledge(key: HabitKey): void {
  const state = load();
  const entry = state.adopted[key];
  if (entry) state.adopted[key] = { ...entry, told: true };
  save(state);
}

/** Undo: drop the adoption and pin the habit so it is not adopted again. */
export function undo(key: HabitKey): void {
  const state = load();
  delete state.adopted[key];
  state.pinned[key] = true;
  state.observed[key] = [];
  save(state);
}

export function setNoticing(noticing: boolean): void {
  const state = load();
  state.noticing = noticing;
  save(state);
}

/** Forget everything noticed, adopted, and pinned; keep the switch as it is. */
export function forgetHabits(): void {
  const state = load();
  save({ ...DEFAULT_HABITS, noticing: state.noticing });
}

/** The words for an adoption, for the line and the Layout page. */
export function habitWords(key: HabitKey, value: HabitValue): string {
  if (key === "firstSection") return `The evidence panel opens on ${sectionWord(value)} first`;
  if (key === "panelOnFinish") return value === "yes" ? "The evidence panel opens when a turn finishes" : "The evidence panel stays closed when a turn finishes";
  return value === "yes" ? "The terminal opens when a run starts" : "The terminal stays closed when a run starts";
}

function sectionWord(value: HabitValue): string {
  return value === "changes" ? "Changes" : value === "verification" ? "Verification" : "Overview";
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(HABITS_EVENT, onChange);
  return () => window.removeEventListener(HABITS_EVENT, onChange);
}

let snapshot: { raw: string | null; value: HabitsState } | null = null;

function snapshotHabits(): HabitsState {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    raw = null;
  }
  if (!snapshot || snapshot.raw !== raw) snapshot = { raw, value: readHabits(raw) };
  return snapshot.value;
}

/** The habits as React state: re-renders when an observation or an undo lands. */
export function useHabits(): HabitsState {
  return useSyncExternalStore(subscribe, snapshotHabits);
}
