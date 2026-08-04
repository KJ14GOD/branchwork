/**
 * The working set: the missions a person currently has *open*.
 *
 * It is not the list of missions. That is the projects rail's, and only the
 * rail's (D-055): every mission of every project, once, next to the project
 * that owns it. This is the smaller, mutable set of rooms someone is working in
 * right now — the way an editor's tabs are the files you are working in rather
 * than the repository. The two never mirror each other: opening from the rail
 * adds to this set, closing here removes from this set, and the rail is
 * untouched either way.
 *
 * Everything here is pure, so the rules that matter — a mission appears at most
 * once, closing a tab does nothing but close it, a restored mission the server
 * refuses is dropped rather than crashing the shell — are provable without a
 * window.
 */

/**
 * One open room.
 *
 * `id` is stable for the life of the tab, including across the moment a draft
 * becomes a real mission: the tab a person is looking at must not be replaced
 * by a different one the instant their first direction lands.
 */
export interface OpenTab {
  id: string;
  projectKey: string;
  /** Null while this tab is an unsent local draft — no mission exists yet. */
  missionId: string | null;
}

export interface WorkingSet {
  tabs: OpenTab[];
  activeId: string | null;
}

export const emptyWorkingSet: WorkingSet = { tabs: [], activeId: null };

/** More open rooms than this is a corrupt store, not a person's working set. */
const MAX_TABS = 24;

export function activeTab(set: WorkingSet): OpenTab | null {
  return set.tabs.find((tab) => tab.id === set.activeId) ?? null;
}

export function tabFor(set: WorkingSet, missionId: string): OpenTab | null {
  return set.tabs.find((tab) => tab.missionId === missionId) ?? null;
}

/**
 * Opens a mission, or selects the tab it already has. A mission is open at most
 * once: asking for one that is already open moves to it rather than making a
 * second copy of the same room.
 */
export function openMission(
  set: WorkingSet,
  missionId: string,
  projectKey: string,
  mint: () => string
): WorkingSet {
  const existing = tabFor(set, missionId);
  if (existing) return set.activeId === existing.id ? set : { ...set, activeId: existing.id };
  const tab: OpenTab = { id: mint(), projectKey, missionId };
  return { tabs: [...set.tabs, tab].slice(-MAX_TABS), activeId: tab.id };
}

/**
 * Opens a draft in a repository, or selects the draft that repository already
 * has. One repository never accumulates two empty rooms nobody can tell apart:
 * `+` pressed twice is the same draft twice.
 */
export function openDraft(set: WorkingSet, projectKey: string, mint: () => string): WorkingSet {
  const existing = set.tabs.find((tab) => tab.missionId === null && tab.projectKey === projectKey);
  if (existing) return set.activeId === existing.id ? set : { ...set, activeId: existing.id };
  const tab: OpenTab = { id: mint(), projectKey, missionId: null };
  return { tabs: [...set.tabs, tab].slice(-MAX_TABS), activeId: tab.id };
}

export function selectTab(set: WorkingSet, id: string): WorkingSet {
  if (!set.tabs.some((tab) => tab.id === id)) return set;
  return set.activeId === id ? set : { ...set, activeId: id };
}

/**
 * The draft's first direction created a mission: the tab a person is already
 * looking at becomes that mission's tab, in place. It keeps its id, its
 * position, and the selection — a new tab appearing beside the one you just
 * typed into would be the same room twice.
 */
export function promoteDraft(set: WorkingSet, tabId: string, missionId: string): WorkingSet {
  if (tabFor(set, missionId)) return set;
  return {
    ...set,
    tabs: set.tabs.map((tab) => (tab.id === tabId ? { ...tab, missionId } : tab))
  };
}

/**
 * Closes a tab, and does nothing else.
 *
 * This removes a room from the working set. It does not stop an execution,
 * discard a change, archive a mission, or forget any history: everything the
 * mission is lives on the server, the rail keeps listing it, and a harness that
 * was working goes on working. Selection moves to the neighbour on the right,
 * or the left when there is none, so closing the tab you are in never lands on
 * a dead canvas.
 */
export function closeTab(set: WorkingSet, id: string): WorkingSet {
  const index = set.tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return set;
  const tabs = set.tabs.filter((tab) => tab.id !== id);
  if (set.activeId !== id) return { tabs, activeId: set.activeId };
  const next = tabs[index] ?? tabs[index - 1] ?? null;
  return { tabs, activeId: next?.id ?? null };
}

export function closeTabs(set: WorkingSet, ids: readonly string[]): WorkingSet {
  return ids.reduce((current, id) => closeTab(current, id), set);
}

/**
 * Whether a failure to read a mission means the tab should go.
 *
 * Gone is gone: a mission that no longer exists, or one this person may not
 * see, cannot be a room they have open. Everything else — above all `offline` —
 * is a fact about the network and not about the mission, and dropping tabs on
 * it would quietly empty someone's working set the moment their connection did.
 */
export function tabIsGone(code: string): boolean {
  return code === "not_found" || code === "forbidden" || code === "not_a_participant";
}

/* ---------- What survives a relaunch ---------- */

interface StoredTab {
  missionId: string;
  projectKey: string;
}

interface StoredWorkingSet {
  missions: StoredTab[];
  activeMissionId: string | null;
}

/**
 * Only real missions are written down. A draft is unsent local text with no
 * mission behind it, so restoring one would put a room nobody asked for back on
 * screen with nothing in it — and two relaunches would put two there.
 */
export function encodeWorkingSet(set: WorkingSet): string {
  const active = activeTab(set);
  const stored: StoredWorkingSet = {
    missions: set.tabs
      .filter((tab): tab is OpenTab & { missionId: string } => tab.missionId !== null)
      .map((tab) => ({ missionId: tab.missionId, projectKey: tab.projectKey })),
    activeMissionId: active?.missionId ?? null
  };
  return JSON.stringify(stored);
}

/**
 * Reads a stored working set back, defensively: anything malformed is no
 * working set rather than a broken one, because a shell that will not start is
 * a worse answer than a shell that starts empty.
 */
export function decodeWorkingSet(raw: string | null, mint: () => string): WorkingSet {
  if (!raw) return emptyWorkingSet;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyWorkingSet;
  }
  if (typeof parsed !== "object" || parsed === null) return emptyWorkingSet;
  const record = parsed as { missions?: unknown; activeMissionId?: unknown };
  if (!Array.isArray(record.missions)) return emptyWorkingSet;
  const seen = new Set<string>();
  const tabs: OpenTab[] = [];
  for (const entry of record.missions) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as { missionId?: unknown; projectKey?: unknown };
    if (typeof candidate.missionId !== "string" || typeof candidate.projectKey !== "string") continue;
    if (candidate.missionId === "" || seen.has(candidate.missionId)) continue;
    seen.add(candidate.missionId);
    tabs.push({ id: mint(), projectKey: candidate.projectKey, missionId: candidate.missionId });
    if (tabs.length === MAX_TABS) break;
  }
  if (tabs.length === 0) return emptyWorkingSet;
  const wanted =
    typeof record.activeMissionId === "string"
      ? (tabs.find((tab) => tab.missionId === record.activeMissionId) ?? null)
      : null;
  return { tabs, activeId: (wanted ?? tabs[0])?.id ?? null };
}

/** The renderer's own store. Absent in tests and in any non-browser context,
 *  where an unreadable working set is simply an empty one. */
export function readWorkingSet(key: string, mint: () => string): WorkingSet {
  try {
    if (typeof localStorage === "undefined") return emptyWorkingSet;
    return decodeWorkingSet(localStorage.getItem(key), mint);
  } catch {
    return emptyWorkingSet;
  }
}

export function writeWorkingSet(key: string, set: WorkingSet): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(key, encodeWorkingSet(set));
  } catch {
    /* A store that will not take a write is not a reason to stop working. */
  }
}
