import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Native notifications (D-180): the machine tells a person the room needs
 * them while they are somewhere else.
 *
 * Exactly two moments speak, because exactly two moments are theirs to act
 * on: a turn ending (the work is ready to read) and the harness asking a
 * question (nothing moves until somebody answers). Both are suppressed while
 * the window is focused — a person watching the room needs no echo — and
 * each is its own preference, persisted machine-locally, defaulting on.
 * Clicking a notification focuses the window and opens the mission.
 *
 * Pure logic here; Electron's Notification and the window are injected, so
 * the gating (focus, preferences, kinds) is testable without an app.
 */

export type NotificationKind = "turn_completed" | "turn_failed" | "needs_you";

export interface NotificationPrefs {
  /** A turn ending — completed or failed. */
  turns: boolean;
  /** The harness asking a person's question. */
  needsYou: boolean;
}

const DEFAULTS: NotificationPrefs = { turns: true, needsYou: true };

const prefsPath = (userDataPath: string) => join(userDataPath, "notifications.json");

export function loadNotificationPrefs(userDataPath: string): NotificationPrefs {
  try {
    const path = prefsPath(userDataPath);
    if (!existsSync(path)) return { ...DEFAULTS };
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<NotificationPrefs>;
    return {
      turns: typeof raw.turns === "boolean" ? raw.turns : DEFAULTS.turns,
      needsYou: typeof raw.needsYou === "boolean" ? raw.needsYou : DEFAULTS.needsYou
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveNotificationPrefs(userDataPath: string, prefs: NotificationPrefs): void {
  writeFileSync(prefsPath(userDataPath), JSON.stringify(prefs));
}

export interface NotifierDeps {
  userDataPath: string;
  /** True while the window has the person's attention — nothing speaks then. */
  isFocused: () => boolean;
  /** Shows the native notification; injected so the gate is testable. */
  show: (title: string, body: string, onClick: () => void) => void;
  /** Focuses the window and opens the mission the note was about. */
  open: (missionId: string) => void;
  /** The mission's own words for the body; null falls back to nothing. */
  missionWords: (missionId: string) => Promise<string | null>;
}

const TITLES: Record<NotificationKind, string> = {
  turn_completed: "Turn completed",
  turn_failed: "Turn failed",
  needs_you: "Claude Code needs you"
};

export interface Notifier {
  notify(note: { kind: NotificationKind; missionId: string }): void;
  prefs(): NotificationPrefs;
  setPrefs(next: NotificationPrefs): void;
}

export function createNotifier(deps: NotifierDeps): Notifier {
  let prefs = loadNotificationPrefs(deps.userDataPath);
  return {
    prefs: () => ({ ...prefs }),
    setPrefs: (next) => {
      prefs = { ...next };
      saveNotificationPrefs(deps.userDataPath, prefs);
    },
    notify: (note) => {
      if (deps.isFocused()) return;
      const wanted = note.kind === "needs_you" ? prefs.needsYou : prefs.turns;
      if (!wanted) return;
      // The body is the mission's own goal, fetched when the moment comes —
      // a notification about "a mission" tells a person nothing.
      void deps
        .missionWords(note.missionId)
        .catch(() => null)
        .then((words) => {
          deps.show(TITLES[note.kind], words ?? "", () => deps.open(note.missionId));
        });
    }
  };
}
