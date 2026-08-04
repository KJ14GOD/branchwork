import { describe, expect, it } from "vitest";
import {
  activeTab,
  closeTab,
  closeTabs,
  decodeWorkingSet,
  emptyWorkingSet,
  encodeWorkingSet,
  openDraft,
  openMission,
  promoteDraft,
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
