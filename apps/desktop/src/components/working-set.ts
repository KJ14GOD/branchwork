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
  /** The approach lane this room is reading, null for the lane the mission
   *  started with. Part of the tab because it is part of "the room you left":
   *  reopening a mission puts you back in the lane you were directing, with
   *  the composer targeting it (D-080). */
  workstreamId: string | null;
  /** The session this room is reading, null for the lane's first — the
   *  conversation every lane is born with, which is the default and never
   *  carried around as an id (D-083). Part of the tab for the same reason the
   *  lane is: the composer's target must come back as it was left. There is no
   *  open/closed subset any more: the rail's tree lists every session of the
   *  selected approach, so nothing closes (D-084). */
  sessionId: string | null;
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
 * Opens a mission's default view, or selects the tab that view already has.
 * Uniqueness is per **view** (D-085): one tab per (mission, lane), so opening
 * what is already open moves to it rather than making a second copy — while a
 * sibling lane's tab is a different view and sits beside it.
 */
export function openMission(
  set: WorkingSet,
  missionId: string,
  projectKey: string,
  mint: () => string
): WorkingSet {
  return openLane(set, missionId, projectKey, null, mint);
}

/**
 * Opens one lane of a mission as its own tab, or selects the tab that view
 * already has (D-085). Null is the lane the mission started with. Everything a
 * tab remembers — its session, its files, its canvas — belongs to this view
 * and to no other.
 */
export function openLane(
  set: WorkingSet,
  missionId: string,
  projectKey: string,
  workstreamId: string | null,
  mint: () => string
): WorkingSet {
  const existing = set.tabs.find(
    (tab) => tab.missionId === missionId && tab.workstreamId === workstreamId
  );
  if (existing) return set.activeId === existing.id ? set : { ...set, activeId: existing.id };
  const tab: OpenTab = {
    id: mint(),
    projectKey,
    missionId,
    workstreamId,
    sessionId: null
  };
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
  const tab: OpenTab = {
    id: mint(),
    projectKey,
    missionId: null,
    workstreamId: null,
    sessionId: null
  };
  return { tabs: [...set.tabs, tab].slice(-MAX_TABS), activeId: tab.id };
}

export function selectTab(set: WorkingSet, id: string): WorkingSet {
  if (!set.tabs.some((tab) => tab.id === id)) return set;
  return set.activeId === id ? set : { ...set, activeId: id };
}

/**
 * Selects which approach lane a tab is reading. Null returns to the lane the
 * mission started with. The choice survives a relaunch exactly as the open
 * tab does, because the composer's target must come back as it was left —
 * never silently reset to the first lane (D-080).
 */
export function selectLane(set: WorkingSet, tabId: string, workstreamId: string | null): WorkingSet {
  const tab = set.tabs.find((entry) => entry.id === tabId);
  if (!tab || tab.workstreamId === workstreamId) return set;
  return {
    ...set,
    tabs: set.tabs.map((entry) =>
      // A session belongs to one lane, so moving lanes returns to the new
      // lane's first conversation rather than carrying a foreign id (D-083).
      entry.id === tabId ? { ...entry, workstreamId, sessionId: null } : entry
    )
  };
}

/**
 * Selects which session a tab is reading. Null returns to the lane's first —
 * the conversation the lane was born with, which is the default and never
 * stored as an id (D-083). The choice survives a relaunch exactly as the lane
 * does, because the composer's target must come back as it was left.
 */
export function selectSession(set: WorkingSet, tabId: string, sessionId: string | null): WorkingSet {
  const tab = set.tabs.find((entry) => entry.id === tabId);
  if (!tab || tab.sessionId === sessionId) return set;
  return {
    ...set,
    tabs: set.tabs.map((entry) => (entry.id === tabId ? { ...entry, sessionId } : entry))
  };
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
  workstreamId?: string | null;
  sessionId?: string | null;
}

interface StoredWorkingSet {
  missions: StoredTab[];
  activeMissionId: string | null;
  /** Which of the mission's views was showing (D-085). Absent in stores from
   *  before lanes had tabs of their own, where a mission had exactly one. */
  activeWorkstreamId?: string | null;
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
      .map((tab) => ({
        missionId: tab.missionId,
        projectKey: tab.projectKey,
        workstreamId: tab.workstreamId,
        sessionId: tab.sessionId
      })),
    activeMissionId: active?.missionId ?? null,
    activeWorkstreamId: active?.workstreamId ?? null
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
    const candidate = entry as {
      missionId?: unknown;
      projectKey?: unknown;
      workstreamId?: unknown;
      sessionId?: unknown;
    };
    if (typeof candidate.missionId !== "string" || typeof candidate.projectKey !== "string") continue;
    // A stored lane comes back as it was left; anything malformed is the
    // default lane rather than a broken tab.
    const workstreamId =
      typeof candidate.workstreamId === "string" && candidate.workstreamId.startsWith("wst_")
        ? candidate.workstreamId
        : null;
    // One tab per view (D-085): a mission may come back several times, once
    // per lane, and the same view never twice.
    const viewKey = `${candidate.missionId}:${workstreamId ?? "first"}`;
    if (candidate.missionId === "" || seen.has(viewKey)) continue;
    seen.add(viewKey);
    tabs.push({
      id: mint(),
      projectKey: candidate.projectKey,
      missionId: candidate.missionId,
      workstreamId,
      // The session being read comes back the same way: malformed means the
      // lane's first conversation, never a broken tab (D-083). A store from
      // the tab era may carry an open-session list; it is simply not read,
      // because the tree lists every session now (D-084).
      sessionId:
        typeof candidate.sessionId === "string" && candidate.sessionId.startsWith("csn_")
          ? candidate.sessionId
          : null
    });
    if (tabs.length === MAX_TABS) break;
  }
  if (tabs.length === 0) return emptyWorkingSet;
  // The exact view that was showing, where the store says which (D-085);
  // any tab of the mission otherwise, and the first tab as the last resort.
  const activeRecord = record as { activeWorkstreamId?: unknown };
  const wantedLane =
    typeof activeRecord.activeWorkstreamId === "string" &&
    activeRecord.activeWorkstreamId.startsWith("wst_")
      ? activeRecord.activeWorkstreamId
      : null;
  const wanted =
    typeof record.activeMissionId === "string"
      ? (tabs.find(
          (tab) => tab.missionId === record.activeMissionId && tab.workstreamId === wantedLane
        ) ??
        tabs.find((tab) => tab.missionId === record.activeMissionId) ??
        null)
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
