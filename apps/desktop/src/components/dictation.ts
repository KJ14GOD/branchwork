import { useSyncExternalStore } from "react";
import type { DictationEvent, DictationSettings, DictationStartInput, DictationState } from "@novus/contracts";
import { novus } from "../bridge";

/**
 * The renderer's side of dictation (D-240): one take at a time, machine-wide,
 * held in a module store every composer subscribes to — the keybinding
 * registry's own shape — so the box that started a take, the chord that
 * toggles it, and the settings page all read one snapshot.
 *
 * The store carries words only. Audio, the key, and the vendor never reach
 * this process; the main process tells it what it heard.
 */

export interface DictationTake {
  sessionId: string;
  /** Which composer the words belong to. */
  owner: string;
  state: DictationState;
  startedAtMs: number | null;
  /** Settled segments, in order: as heard, and as refined once the editor
   *  has answered for them (D-242) — until then the two are the same. */
  segments: { raw: string; text: string }[];
  /** The volatile tail: the open segment's words so far. */
  interim: string;
  /** The take's settled answer, once stop has run its course. */
  refined: { raw: string; text: string; note: string | null } | null;
  error: string | null;
}

export interface DictationSnapshot {
  take: DictationTake | null;
  /** A start in flight: the microphone, the vocabulary, the vendor's hello. */
  starting: boolean;
}

let snapshot: DictationSnapshot = { take: null, starting: false };
const listeners = new Set<() => void>();
let wired = false;

function publish(next: DictationSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function wire(): void {
  if (wired) return;
  wired = true;
  novus().dictation.onEvent((event: DictationEvent) => {
    const take = snapshot.take;
    if (!take || take.sessionId !== event.sessionId) return;
    switch (event.kind) {
      case "state":
        if (event.state === "idle" && take.refined === null) {
          // Cancelled, or failed before it settled: the take is over and
          // left nothing behind but its error, if any.
          publish({ take: take.error ? { ...take, state: "idle", startedAtMs: null } : null, starting: false });
        } else {
          publish({ take: { ...take, state: event.state, startedAtMs: event.startedAtMs }, starting: false });
        }
        break;
      case "interim":
        publish({ ...snapshot, take: { ...take, interim: event.text } });
        break;
      case "final":
        publish({ ...snapshot, take: { ...take, segments: [...take.segments, { raw: event.text, text: event.text }], interim: "" } });
        break;
      case "segment":
        publish({
          ...snapshot,
          take: {
            ...take,
            segments: take.segments.map((segment, index) =>
              index === event.index ? { raw: event.raw, text: event.text } : segment
            )
          }
        });
        break;
      case "refined":
        publish({
          ...snapshot,
          take: { ...take, interim: "", refined: { raw: event.raw, text: event.text, note: event.note } }
        });
        break;
      case "error":
        publish({ ...snapshot, take: { ...take, error: event.message } });
        break;
      default:
        break;
    }
  });
}

export function useDictation(): DictationSnapshot {
  return useSyncExternalStore(
    (listener) => {
      wire();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot
  );
}

/** Begins a take for one composer. Refusals come back in words. */
export async function startDictation(
  owner: string,
  input: DictationStartInput
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  wire();
  if (snapshot.take && snapshot.take.state !== "idle") {
    return { ok: false, code: "busy", message: "Novus is already listening." };
  }
  publish({ take: null, starting: true });
  const started = await novus().dictation.start(input);
  if (!started.ok) {
    publish({ take: null, starting: false });
    return { ok: false, code: started.code, message: started.message };
  }
  publish({
    take: {
      sessionId: started.value.sessionId,
      owner,
      state: "starting",
      startedAtMs: Date.now(),
      segments: [],
      interim: "",
      refined: null,
      error: null
    },
    starting: false
  });
  return { ok: true };
}

export async function stopDictation(): Promise<void> {
  if (!snapshot.take || snapshot.take.state === "idle") return;
  await novus().dictation.stop();
}

export async function cancelDictation(): Promise<void> {
  if (!snapshot.take || snapshot.take.state === "idle") return;
  await novus().dictation.cancel();
}

/** Forgets a settled take, once its words have landed in the box. */
export function releaseDictation(sessionId: string): void {
  if (snapshot.take?.sessionId === sessionId) publish({ take: null, starting: false });
}

/** The listening words for the chip and the note: the elapsed time as
 *  `m:ss`, the recording word's own form (D-237). */
export function elapsedLabel(startedAtMs: number | null, nowMs: number): string {
  if (startedAtMs === null) return "0:00";
  const seconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// --- The chord's target ------------------------------------------------------
// The dictate chord is global to the window, and the box it means is the one
// a person is in: the composer that owns the live take, else the focused
// one, else the one mounted last. Composers register here on mount, so the
// shell's handler need not know which surface holds a box.

interface MountedComposer {
  id: string;
  toggle: () => void;
  enabled: () => boolean;
  hasFocus: () => boolean;
}

const mounted: MountedComposer[] = [];

export function registerComposer(entry: MountedComposer): () => void {
  mounted.push(entry);
  return () => {
    const at = mounted.indexOf(entry);
    if (at !== -1) mounted.splice(at, 1);
  };
}

/** A press held this long is push-to-talk: the take ends when the key
 *  lifts. A shorter tap leaves the take running until the next tap. */
export const HOLD_TO_TALK_MS = 350;

let press: { at: number; started: boolean } | null = null;

/**
 * The chord's key going down (D-243) — never on key repeat, which a held
 * key fires many times a second and which used to stop and restart a take
 * until nothing was heard. A take already listening stops; otherwise the
 * composer the chord means starts one, and the press is remembered so its
 * release can decide whether this was a hold or a tap.
 */
export function pressDictationKey(): boolean {
  const take = snapshot.take;
  if (take && (take.state === "starting" || take.state === "listening")) {
    press = null;
    void stopDictation();
    return true;
  }
  const started = toggleDictationFromKeyboard();
  press = started ? { at: Date.now(), started: true } : null;
  return started;
}

/** The chord's key (or its modifier) lifting: a press held long enough was
 *  push-to-talk, and the take ends with it. A tap changes nothing here. */
export function releaseDictationKey(): void {
  const held = press;
  press = null;
  if (!held?.started) return;
  if (Date.now() - held.at < HOLD_TO_TALK_MS) return;
  const take = snapshot.take;
  if (take && (take.state === "starting" || take.state === "listening")) void stopDictation();
}

/** The chord's act: toggles the take on the composer it means. Returns
 *  whether any composer took it, so the shell can let the key fall through. */
export function toggleDictationFromKeyboard(): boolean {
  const owner = snapshot.take && snapshot.take.state !== "idle" ? snapshot.take.owner : null;
  const target =
    (owner !== null ? mounted.find((entry) => entry.id === owner) : undefined) ??
    mounted.find((entry) => entry.hasFocus() && entry.enabled()) ??
    [...mounted].reverse().find((entry) => entry.enabled());
  if (!target) return false;
  target.toggle();
  return true;
}

/** What the settings page reads and writes. */
export async function readDictationSettings(): Promise<DictationSettings | null> {
  const result = await novus().dictation.settings();
  return result.ok ? result.value : null;
}
