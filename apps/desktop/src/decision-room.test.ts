import assert from "node:assert/strict";
import test from "node:test";

import {
  approachKey,
  decideDecisionRoom,
  missionLayout,
  openDecisionRoom,
  type ViewMode,
} from "./decision-room.ts";

/**
 * The Decision Room opening itself, and what it leaves on screen.
 *
 * a5b24d5 landed this behaviour inline in a `useEffect` and nothing held it:
 * "once per arrival", "never interrupt browse" and "open again for a later
 * decision" are three rules that a well-meaning dependency-array edit can
 * turn into "every three seconds, forever", which is the most obnoxious
 * failure a self-moving interface has.
 *
 * `room()` below is the wiring from `session-tab.tsx` — remember what the
 * decision answered, move the view — so these read as sequences of events a
 * person would recognise rather than as calls.
 */
const room = (start: ViewMode = "timeline") => {
  let answered: string | null = null;
  let mode: ViewMode = start;

  return {
    view: () => mode,
    /** One evaluation: the state, and which approaches are in play. */
    state: (needsDecision: boolean, attempts: string[] = ["a", "b"]) => {
      const outcome = decideDecisionRoom({
        needsDecision,
        approaches: approachKey(attempts.map((runId) => ({ runId }))),
        answered,
      });

      answered = outcome.answered;

      if (outcome.open) {
        mode = openDecisionRoom(mode);
      }
    },
    /** A person clicking the view switcher. */
    switchTo: (next: ViewMode) => {
      mode = next;
    },
  };
};

test("entering needs-decision opens the Decision Room", () => {
  const session = room();

  session.state(true);

  assert.equal(session.view(), "compare");
});

test("it opens once per arrival, not on every comparison refetch", () => {
  const session = room();

  session.state(true);
  session.switchTo("timeline");

  // The comparison polls; the phases recompute on every event. Neither is a
  // new arrival at the state.
  session.state(true);
  session.state(true);
  session.state(true);

  assert.equal(session.view(), "timeline");
});

test("a deliberate switch back to Activity is respected", () => {
  const session = room();

  session.state(true);
  assert.equal(session.view(), "compare");

  session.switchTo("timeline");
  session.state(true);

  assert.equal(
    session.view(),
    "timeline",
    "the person chose Activity — nothing may yank them forward again",
  );
});

test("browse is not interrupted mid-read", () => {
  const session = room("browse");

  session.state(true);

  assert.equal(session.view(), "browse");
  assert.equal(openDecisionRoom("browse"), "browse");
  assert.equal(openDecisionRoom("timeline"), "compare");
  assert.equal(openDecisionRoom("compare"), "compare");
});

test("a later transition back into needs-decision opens the room again", () => {
  const session = room();

  session.state(true);
  session.switchTo("timeline");

  // The decision is recorded: the phase stops needing attention.
  session.state(false);
  assert.equal(session.view(), "timeline");

  // A second decision, later in the same mission.
  session.state(true);

  assert.equal(session.view(), "compare");
});

test("forking again after adopting is a new decision", () => {
  const session = room();

  session.state(true, ["a", "b"]);
  session.switchTo("timeline");
  session.state(true, ["a", "b"]);
  assert.equal(session.view(), "timeline");

  // A third approach exists now, so what is being decided is not what was
  // already looked at.
  session.state(true, ["a", "b", "c"]);

  assert.equal(session.view(), "compare");
});

test("leaving the state clears what was answered", () => {
  assert.deepEqual(
    decideDecisionRoom({
      needsDecision: false,
      approaches: "a,b",
      answered: "a,b",
    }),
    { answered: null, open: false },
  );
});

test("approaches with no runs is a stable key, not a fresh one", () => {
  assert.equal(approachKey([]), "");
  assert.deepEqual(
    decideDecisionRoom({ needsDecision: true, approaches: "", answered: "" }),
    { answered: "", open: false },
  );
});

test("the Decision Room keeps the composer and the evidence inspector", () => {
  const decisionRoom = missionLayout("compare");

  assert.equal(decisionRoom.canvas, "decision-room");
  assert.equal(
    decisionRoom.composer,
    true,
    "reaching a decision must not cost the ability to say anything",
  );
  assert.equal(
    decisionRoom.evidence,
    true,
    "the evidence panel belongs beside the thing it is evidence for",
  );
  assert.equal(decisionRoom.tree, false);
});

test("Activity and the Decision Room differ only in the centre column", () => {
  const activity = missionLayout("timeline");
  const decisionRoom = missionLayout("compare");

  assert.equal(activity.canvas, "activity");
  assert.notEqual(activity.canvas, decisionRoom.canvas);
  assert.equal(activity.composer, decisionRoom.composer);
  assert.equal(activity.evidence, decisionRoom.evidence);
  assert.equal(activity.tree, decisionRoom.tree);
});

test("browse takes the whole body", () => {
  assert.deepEqual(missionLayout("browse"), {
    tree: true,
    canvas: null,
    composer: false,
    evidence: false,
  });
});
