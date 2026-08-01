/**
 * When the Decision Room opens itself, and what the mission screen shows.
 *
 * a5b24d5 made the Decision Room the screen rather than a tab on the
 * timeline: the spine said "Approaches are waiting on you" in eleven-pixel
 * type in the narrowest column on screen while the largest area showed a
 * scrolling list of tool calls. Work waiting for a person should not be
 * something they have to click a tab to discover.
 *
 * All of it lived inline in a `useEffect` in `session-tab.tsx`, which meant
 * the rules below — fires once per arrival, never yanks somebody out of the
 * file browser, opens again for a *later* decision — were pinned by nothing.
 * They are pure functions here so a test can state each rule directly, and
 * `session-tab.tsx` calls them rather than restating them.
 */

/** Which of the body's three mutually exclusive views is showing. */
export type ViewMode = "timeline" | "compare" | "browse";

/**
 * The approaches in play, as one comparable value.
 *
 * Keyed on which approaches exist rather than on a boolean, so adopting one
 * and forking again is a *new* decision and opens the room again, while the
 * same decision re-rendering forty times does not.
 */
export const approachKey = (
  attempts: readonly { runId: string }[],
): string => attempts.map((attempt) => attempt.runId).join(",");

export type DecisionRoomOutcome = {
  /** The key now considered answered — what to remember for the next call. */
  answered: string | null;
  /** Whether the Decision Room should be brought forward now. */
  open: boolean;
};

/**
 * Whether arriving at this state should open the Decision Room.
 *
 * Fires once per arrival, not continuously: a host who looks at the decision
 * and deliberately switches back to Activity must be allowed to stay there,
 * and a comparison that refetches every few seconds must not drag them
 * forward again. Leaving the state clears the memory, so a second decision
 * later in the same mission opens the room a second time.
 */
export const decideDecisionRoom = ({
  needsDecision,
  approaches,
  answered,
}: {
  needsDecision: boolean;
  approaches: string;
  /** What `decideDecisionRoom` last returned as answered, or null. */
  answered: string | null;
}): DecisionRoomOutcome => {
  if (!needsDecision) {
    return { answered: null, open: false };
  }

  if (answered === approaches) {
    return { answered, open: false };
  }

  return { answered: approaches, open: true };
};

/**
 * The view the Decision Room opening leaves you on.
 *
 * Browse is the one view it will not interrupt: reading a file is a
 * deliberate act with no natural end, and pulling somebody out of it
 * mid-read to show a decision that will still be there in a minute is the
 * behaviour that makes people distrust an interface that moves on its own.
 */
export const openDecisionRoom = (current: ViewMode): ViewMode =>
  current === "browse" ? current : "compare";

/**
 * Which surfaces the mission screen shows in a given view.
 *
 * The Decision Room used to replace the whole body — composer and evidence
 * inspector included — which meant reaching a decision cost you the ability
 * to say anything and the panel showing what was verified. Only the middle
 * column swaps now. `session-tab.tsx` renders from this rather than from
 * three separate `mode === …` checks, so "the composer is still there in the
 * Decision Room" is a thing a test can assert instead of a thing a later
 * refactor can quietly delete.
 */
export type MissionLayout = {
  /** The file tree and viewer, which take the whole body when browsing. */
  tree: boolean;
  /** What occupies the centre column, or null when the tree has the body. */
  canvas: "decision-room" | "activity" | null;
  composer: boolean;
  /** The changed-files panel, which carries the verification verdict. */
  evidence: boolean;
};

export const missionLayout = (mode: ViewMode): MissionLayout =>
  mode === "browse"
    ? { tree: true, canvas: null, composer: false, evidence: false }
    : {
        tree: false,
        canvas: mode === "compare" ? "decision-room" : "activity",
        composer: true,
        evidence: true,
      };
