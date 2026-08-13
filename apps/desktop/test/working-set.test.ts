import { describe, expect, it } from "vitest";
import {
  activeTab,
  closeSession,
  closeTab,
  closeTabs,
  decodeWorkingSet,
  emptyWorkingSet,
  encodeWorkingSet,
  openDraft,
  openMission,
  openMissionAt,
  openSession,
  reorderSession,
  promoteDraft,
  selectLane,
  selectSession,
  selectTab,
  tabIsGone,
  type WorkingSet
} from "../src/components/working-set";

/**
 * The rules of the working set, without a window.
 *
 * These are the ones that would be expensive to be wrong about: a mission open
 * twice, a close that takes something else with it, a relaunch that resurrects
 * a mission the server has since refused, and — the one that costs the most —
 * a working set emptied because the network went away for a moment.
 */

/** Deterministic ids, so a failure names a tab rather than a UUID. */
function minter(): () => string {
  let next = 0;
  return () => `tab-${(next += 1)}`;
}

const withTabs = (...missionIds: string[]): WorkingSet => {
  const mint = minter();
  return missionIds.reduce(
    (set, missionId) => openMission(set, missionId, "local:one", mint),
    emptyWorkingSet
  );
};

describe("the working set", () => {
  it("holds two missions from one project at once", () => {
    const set = withTabs("msn_a", "msn_b");
    expect(set.tabs.map((tab) => tab.missionId)).toEqual(["msn_a", "msn_b"]);
    expect(activeTab(set)?.missionId).toBe("msn_b");
  });

  it("holds missions from different projects at once, each keeping its project", () => {
    const mint = minter();
    let set = openMission(emptyWorkingSet, "msn_a", "local:one", mint);
    set = openMission(set, "msn_b", "github:two", mint);
    expect(set.tabs.map((tab) => tab.projectKey)).toEqual(["local:one", "github:two"]);
    expect(set.tabs).toHaveLength(2);
  });

  it("reuses the tab a mission already has instead of opening a second one", () => {
    const mint = minter();
    let set = withTabs("msn_a", "msn_b");
    set = openMission(set, "msn_a", "local:one", mint);
    expect(set.tabs).toHaveLength(2);
    expect(activeTab(set)?.missionId).toBe("msn_a");
    // Asking for the mission already showing changes nothing at all.
    expect(openMission(set, "msn_a", "local:one", mint)).toBe(set);
  });

  it("closes one tab and leaves every other one exactly as it was", () => {
    const set = withTabs("msn_a", "msn_b", "msn_c");
    const closed = closeTab(set, set.tabs[1]!.id);
    expect(closed.tabs.map((tab) => tab.missionId)).toEqual(["msn_a", "msn_c"]);
    // The mission itself is untouched by construction: closing produces a
    // shorter list of open rooms and carries no mission state of any kind.
    expect(closed.tabs[0]).toBe(set.tabs[0]);
    expect(closed.tabs[1]).toBe(set.tabs[2]);
  });

  it("moves the selection to the right, then to the left, then to nothing", () => {
    const three = withTabs("msn_a", "msn_b", "msn_c");
    const middleClosed = closeTab({ ...three, activeId: three.tabs[1]!.id }, three.tabs[1]!.id);
    expect(activeTab(middleClosed)?.missionId).toBe("msn_c");

    const lastClosed = closeTab(three, three.tabs[2]!.id);
    expect(activeTab(lastClosed)?.missionId).toBe("msn_b");

    const one = withTabs("msn_a");
    const none = closeTab(one, one.tabs[0]!.id);
    expect(none.tabs).toHaveLength(0);
    expect(none.activeId).toBeNull();
  });

  it("leaves the selection alone when a background tab is closed", () => {
    const set = withTabs("msn_a", "msn_b");
    const closed = closeTab(set, set.tabs[0]!.id);
    expect(activeTab(closed)?.missionId).toBe("msn_b");
  });

  it("gives one repository one draft, however many times it is asked", () => {
    const mint = minter();
    let set = openDraft(emptyWorkingSet, "local:one", mint);
    const first = set.activeId;
    set = openDraft(set, "local:one", mint);
    expect(set.tabs).toHaveLength(1);
    expect(set.activeId).toBe(first);
    // A different repository is a different draft.
    set = openDraft(set, "github:two", mint);
    expect(set.tabs).toHaveLength(2);
  });

  it("discards only the draft that was closed", () => {
    const mint = minter();
    let set = openMission(emptyWorkingSet, "msn_a", "local:one", mint);
    set = openDraft(set, "local:one", mint);
    const draftId = set.activeId!;
    const closed = closeTab(set, draftId);
    expect(closed.tabs.map((tab) => tab.missionId)).toEqual(["msn_a"]);
  });

  it("turns the draft you typed into into that mission's tab, in place", () => {
    const mint = minter();
    let set = openMission(emptyWorkingSet, "msn_a", "local:one", mint);
    set = openDraft(set, "local:one", mint);
    const draftId = set.activeId!;
    const promoted = promoteDraft(set, draftId, "msn_new");
    expect(promoted.tabs).toHaveLength(2);
    expect(promoted.tabs[1]!.id).toBe(draftId);
    expect(promoted.tabs[1]!.missionId).toBe("msn_new");
    expect(promoted.activeId).toBe(draftId);
  });

  it("selects only tabs that are open", () => {
    const set = withTabs("msn_a");
    expect(selectTab(set, "nothing-like-this")).toBe(set);
  });

  it("drops a restored mission the server says is gone, and keeps the rest", () => {
    const set = withTabs("msn_a", "msn_b", "msn_c");
    const survivors = closeTabs(set, [set.tabs[0]!.id, set.tabs[2]!.id]);
    expect(survivors.tabs.map((tab) => tab.missionId)).toEqual(["msn_b"]);
    expect(activeTab(survivors)?.missionId).toBe("msn_b");
  });

  it("knows which refusals mean gone and which mean try again", () => {
    expect(tabIsGone("not_found")).toBe(true);
    expect(tabIsGone("forbidden")).toBe(true);
    expect(tabIsGone("not_a_participant")).toBe(true);
    // The one that matters: a connection that dropped is not a mission that
    // disappeared, and must never empty somebody's working set.
    expect(tabIsGone("offline")).toBe(false);
    expect(tabIsGone("server_error")).toBe(false);
    expect(tabIsGone("bad_response")).toBe(false);
  });
});

describe("what a relaunch restores", () => {
  it("brings back the open missions and the one that was showing", () => {
    const set = withTabs("msn_a", "msn_b", "msn_c");
    const showing = { ...set, activeId: set.tabs[1]!.id };
    const restored = decodeWorkingSet(encodeWorkingSet(showing), minter());
    expect(restored.tabs.map((tab) => tab.missionId)).toEqual(["msn_a", "msn_b", "msn_c"]);
    expect(activeTab(restored)?.missionId).toBe("msn_b");
    expect(restored.tabs[0]!.projectKey).toBe("local:one");
  });

  it("never writes down a draft", () => {
    const mint = minter();
    let set = openMission(emptyWorkingSet, "msn_a", "local:one", mint);
    set = openDraft(set, "local:one", mint);
    const restored = decodeWorkingSet(encodeWorkingSet(set), minter());
    expect(restored.tabs.map((tab) => tab.missionId)).toEqual(["msn_a"]);
    // The draft was the selected tab; the restored selection falls back to a
    // real room rather than to nothing.
    expect(activeTab(restored)?.missionId).toBe("msn_a");
  });

  it("treats an unreadable store as an empty one rather than a broken shell", () => {
    expect(decodeWorkingSet(null, minter())).toEqual(emptyWorkingSet);
    expect(decodeWorkingSet("", minter())).toEqual(emptyWorkingSet);
    expect(decodeWorkingSet("{not json", minter())).toEqual(emptyWorkingSet);
    expect(decodeWorkingSet("[]", minter())).toEqual(emptyWorkingSet);
    expect(decodeWorkingSet('{"missions":"nope"}', minter())).toEqual(emptyWorkingSet);
  });

  it("restores the approach lane a tab was reading, so the composer's target survives a relaunch", () => {
    const mint = minter();
    let set = openMission(emptyWorkingSet, "msn_a", "local:one", mint);
    set = openMission(set, "msn_b", "local:one", mint);
    // Reading msn_a's Alternative; msn_b stays on its default lane.
    set = selectLane(set, set.tabs[0]!.id, "wst_alternative");
    const restored = decodeWorkingSet(encodeWorkingSet(set), minter());
    expect(restored.tabs[0]!.workstreamId).toBe("wst_alternative");
    expect(restored.tabs[1]!.workstreamId).toBeNull();
  });

  it("selecting a lane changes that tab alone, and null returns to the default lane", () => {
    const mint = minter();
    let set = openMission(emptyWorkingSet, "msn_a", "local:one", mint);
    set = openMission(set, "msn_b", "local:one", mint);
    set = selectLane(set, set.tabs[0]!.id, "wst_alternative");
    expect(set.tabs[0]!.workstreamId).toBe("wst_alternative");
    expect(set.tabs[1]!.workstreamId).toBeNull();
    set = selectLane(set, set.tabs[0]!.id, null);
    expect(set.tabs[0]!.workstreamId).toBeNull();
  });

  it("drops a malformed stored lane rather than a whole tab", () => {
    const raw = JSON.stringify({
      missions: [{ missionId: "msn_a", projectKey: "local:one", workstreamId: "not-a-lane" }],
      activeMissionId: "msn_a"
    });
    const restored = decodeWorkingSet(raw, minter());
    expect(restored.tabs.map((tab) => tab.missionId)).toEqual(["msn_a"]);
    expect(restored.tabs[0]!.workstreamId).toBeNull();
  });

  it("skips entries it cannot use and never restores one mission twice", () => {
    const raw = JSON.stringify({
      missions: [
        { missionId: "msn_a", projectKey: "local:one" },
        { missionId: "msn_a", projectKey: "local:one" },
        { missionId: 7, projectKey: "local:one" },
        null,
        { missionId: "msn_b" }
      ],
      activeMissionId: "msn_a"
    });
    const restored = decodeWorkingSet(raw, minter());
    expect(restored.tabs.map((tab) => tab.missionId)).toEqual(["msn_a"]);
  });
});

describe("sessions in a tab (D-083, presented per D-084)", () => {
  it("selects a session for one tab alone, and null returns to the lane's first", () => {
    const mint = minter();
    let set = openMission(emptyWorkingSet, "msn_a", "local:one", mint);
    set = openMission(set, "msn_b", "local:one", mint);
    set = selectSession(set, set.tabs[0]!.id, "csn_two");
    expect(set.tabs[0]!.sessionId).toBe("csn_two");
    expect(set.tabs[1]!.sessionId).toBeNull();
    // Selecting what is already selected changes nothing at all.
    expect(selectSession(set, set.tabs[0]!.id, "csn_two")).toBe(set);
    set = selectSession(set, set.tabs[0]!.id, null);
    expect(set.tabs[0]!.sessionId).toBeNull();
    // A tab that is not open cannot be given a session.
    expect(selectSession(set, "nothing-like-this", "csn_two")).toBe(set);
  });

  it("opens a session as a tab and selects it, at most once (D-087)", () => {
    const mint = minter();
    let set = openMission(emptyWorkingSet, "msn_a", "local:one", mint);
    const tabId = set.tabs[0]!.id;
    set = openSession(set, tabId, "csn_two");
    expect(set.tabs[0]!.openSessionIds).toEqual(["csn_two"]);
    expect(set.tabs[0]!.sessionId).toBe("csn_two");
    // Opening the session already open and selected changes nothing at all.
    expect(openSession(set, tabId, "csn_two")).toBe(set);
    // Opening another adds beside it, in the order they were opened.
    set = openSession(set, tabId, "csn_three");
    expect(set.tabs[0]!.openSessionIds).toEqual(["csn_two", "csn_three"]);
    expect(set.tabs[0]!.sessionId).toBe("csn_three");
    // Reopening one that is open but not selected only moves the selection.
    set = openSession(set, tabId, "csn_two");
    expect(set.tabs[0]!.openSessionIds).toEqual(["csn_two", "csn_three"]);
    expect(set.tabs[0]!.sessionId).toBe("csn_two");
  });

  it("closes a session tab and falls back to the lane's first when it was being read", () => {
    const mint = minter();
    let set = openMission(emptyWorkingSet, "msn_a", "local:one", mint);
    const tabId = set.tabs[0]!.id;
    set = openSession(set, tabId, "csn_two");
    set = openSession(set, tabId, "csn_three");
    // Closing a background session leaves the one being read alone.
    set = closeSession(set, tabId, "csn_two");
    expect(set.tabs[0]!.openSessionIds).toEqual(["csn_three"]);
    expect(set.tabs[0]!.sessionId).toBe("csn_three");
    // Closing the one being read falls back to the lane's first.
    set = closeSession(set, tabId, "csn_three");
    expect(set.tabs[0]!.openSessionIds).toEqual([]);
    expect(set.tabs[0]!.sessionId).toBeNull();
    // Closing what is not open changes nothing at all.
    expect(closeSession(set, tabId, "csn_three")).toBe(set);
  });

  it("moves an open session to the person's chosen place, and nowhere else (D-088)", () => {
    const mint = minter();
    let set = openMission(emptyWorkingSet, "msn_a", "local:one", mint);
    const tabId = set.tabs[0]!.id;
    set = openSession(set, tabId, "csn_two");
    set = openSession(set, tabId, "csn_three");
    set = openSession(set, tabId, "csn_four");
    set = reorderSession(set, tabId, "csn_four", 0);
    expect(set.tabs[0]!.openSessionIds).toEqual(["csn_four", "csn_two", "csn_three"]);
    set = reorderSession(set, tabId, "csn_two", 2);
    expect(set.tabs[0]!.openSessionIds).toEqual(["csn_four", "csn_three", "csn_two"]);
    // Nothing moves for an id that is not open, an index out of range, or a
    // tab that does not exist.
    expect(reorderSession(set, tabId, "csn_missing", 0)).toBe(set);
    expect(reorderSession(set, tabId, "csn_two", 9)).toBe(set);
    expect(reorderSession(set, "nothing-like-this", "csn_two", 0)).toBe(set);
  });

  it("restores the open session tabs beside the one being read", () => {
    const mint = minter();
    let set = openMission(emptyWorkingSet, "msn_a", "local:one", mint);
    set = openSession(set, set.tabs[0]!.id, "csn_two");
    set = openSession(set, set.tabs[0]!.id, "csn_three");
    set = selectSession(set, set.tabs[0]!.id, "csn_two");
    const restored = decodeWorkingSet(encodeWorkingSet(set), minter());
    expect(restored.tabs[0]!.sessionId).toBe("csn_two");
    expect(restored.tabs[0]!.openSessionIds).toEqual(["csn_two", "csn_three"]);
    // And a malformed stored open set is an empty one, not a broken tab.
    const malformed = decodeWorkingSet(
      JSON.stringify({
        missions: [{ missionId: "msn_a", projectKey: "local:one", openSessionIds: "csn_two" }],
        activeMissionId: "msn_a"
      }),
      minter()
    );
    expect(malformed.tabs[0]!.openSessionIds).toEqual([]);
  });

  it("moving lanes returns to the new lane's first session — a session belongs to one lane", () => {
    const mint = minter();
    let set = openMission(emptyWorkingSet, "msn_a", "local:one", mint);
    const tabId = set.tabs[0]!.id;
    set = selectSession(set, tabId, "csn_two");
    set = selectLane(set, tabId, "wst_alternative");
    expect(set.tabs[0]!.workstreamId).toBe("wst_alternative");
    expect(set.tabs[0]!.sessionId).toBeNull();
  });

  it("restores the session being read", () => {
    const mint = minter();
    let set = openMission(emptyWorkingSet, "msn_a", "local:one", mint);
    set = selectSession(set, set.tabs[0]!.id, "csn_two");
    const restored = decodeWorkingSet(encodeWorkingSet(set), minter());
    expect(restored.tabs[0]!.sessionId).toBe("csn_two");
  });

  it("drops a malformed stored session rather than a whole tab", () => {
    const raw = JSON.stringify({
      missions: [
        {
          missionId: "msn_a",
          projectKey: "local:one",
          sessionId: "not-a-session"
        }
      ],
      activeMissionId: "msn_a"
    });
    const restored = decodeWorkingSet(raw, minter());
    expect(restored.tabs.map((tab) => tab.missionId)).toEqual(["msn_a"]);
    expect(restored.tabs[0]!.sessionId).toBeNull();
  });

  it("reads a store from the session-tab era without its open list, and one from before sessions", () => {
    // The tab era wrote openSessionIds; the tree lists every session, so the
    // field is simply not read any more (D-084) — and the store still parses.
    const tabEra = decodeWorkingSet(
      JSON.stringify({
        missions: [
          {
            missionId: "msn_a",
            projectKey: "local:one",
            sessionId: "csn_two",
            openSessionIds: ["csn_two", "csn_three"]
          }
        ],
        activeMissionId: "msn_a"
      }),
      minter()
    );
    expect(tabEra.tabs[0]!.sessionId).toBe("csn_two");
    const preSessions = decodeWorkingSet(
      JSON.stringify({
        missions: [{ missionId: "msn_a", projectKey: "local:one", workstreamId: "wst_alt" }],
        activeMissionId: "msn_a"
      }),
      minter()
    );
    expect(preSessions.tabs[0]!.sessionId).toBeNull();
    expect(preSessions.tabs[0]!.workstreamId).toBe("wst_alt");
  });
});

describe("opening a mission AT a place (D-120)", () => {
  it("lands on the named lane and conversation, and the conversation joins the open row", () => {
    const mint = minter();
    const opened = openMissionAt(emptyWorkingSet, "msn_1", "p1", mint, {
      workstreamId: "wst_alt",
      sessionId: "csn_blocked"
    });
    const tab = activeTab(opened);
    expect(tab?.missionId).toBe("msn_1");
    expect(tab?.workstreamId).toBe("wst_alt");
    expect(tab?.sessionId).toBe("csn_blocked");
    expect(tab?.openSessionIds).toEqual(["csn_blocked"]);
  });

  it("re-aims an already-open tab rather than minting a second one", () => {
    const mint = minter();
    let set = openMissionAt(emptyWorkingSet, "msn_1", "p1", mint, { sessionId: "csn_a" });
    set = openMissionAt(set, "msn_1", "p1", mint, { workstreamId: "wst_b", sessionId: "csn_b" });
    expect(set.tabs).toHaveLength(1);
    const tab = activeTab(set);
    expect(tab?.workstreamId).toBe("wst_b");
    expect(tab?.sessionId).toBe("csn_b");
    expect(tab?.openSessionIds).toEqual(["csn_a", "csn_b"]);
  });

  it("with no place named, keeps whatever the tab remembered", () => {
    const mint = minter();
    let set = openMissionAt(emptyWorkingSet, "msn_1", "p1", mint, { workstreamId: "wst_alt" });
    set = { ...set, activeId: null };
    set = openMissionAt(set, "msn_1", "p1", mint, {});
    const tab = activeTab(set);
    expect(tab?.workstreamId).toBe("wst_alt");
  });
});
