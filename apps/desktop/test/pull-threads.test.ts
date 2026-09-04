import { describe, expect, it } from "vitest";
import { ReviewThreadSchema, type ReviewThread } from "@novus/contracts";
import {
  directionTarget,
  hunkTail,
  openLineThreads,
  threadAnchorLabel,
  threadAsDirection,
  threadsAtLine
} from "../src/components/pull-threads";

/**
 * Where the host's comments belong on the request page (D-239): a line
 * thread under its diff line — the new line while it exists, the old line
 * once outdated — and never a review summary or a conversation comment,
 * which anchor to nothing and are read, not resolved.
 */

const thread = (overrides: Partial<ReviewThread>): ReviewThread =>
  ReviewThreadSchema.parse({
    threadId: "PRRT_1",
    author: "leePhilip23",
    body: "Too many globals.",
    path: "train.py",
    line: 57,
    state: "open",
    url: null,
    postedAt: "2026-08-21T10:00:00Z",
    ...overrides
  });

describe("threadsAtLine", () => {
  it("places a live thread on the new file's line and an outdated one on the old file's", () => {
    const live = thread({});
    const stale = thread({ threadId: "PRRT_2", body: "Dead import.", line: 3, outdated: true });
    expect(threadsAtLine([live, stale], "train.py", { oldLine: 50, newLine: 57 })).toEqual([live]);
    expect(threadsAtLine([live, stale], "train.py", { oldLine: 3, newLine: 4 })).toEqual([stale]);
    expect(threadsAtLine([live, stale], "train.py", { oldLine: 57, newLine: 3 })).toEqual([]);
  });

  it("never places a review summary or a conversation comment, and never crosses files", () => {
    const review = thread({ threadId: null, kind: "review", path: null, line: null, reviewState: "approved" });
    const talk = thread({ threadId: null, kind: "conversation", path: null, line: null });
    const other = thread({ path: "model.py" });
    expect(threadsAtLine([review, talk, other], "train.py", { oldLine: 57, newLine: 57 })).toEqual([]);
  });
});

describe("what counts as open, and what a card's anchor says", () => {
  it("counts unresolved line threads only — words beside a verdict are read, not resolved", () => {
    const pull = {
      reviewThreads: [
        thread({}),
        thread({ threadId: "PRRT_2", state: "resolved" }),
        thread({ threadId: null, kind: "review", path: null, line: null, reviewState: "changes_requested" }),
        thread({ threadId: null, kind: "conversation", path: null, line: null })
      ]
    };
    expect(openLineThreads(pull)).toHaveLength(1);
  });

  it("names the anchor in words for each kind", () => {
    expect(threadAnchorLabel(thread({}))).toBe("train.py:57");
    expect(threadAnchorLabel(thread({ outdated: true, line: 3 }))).toBe("train.py:3 · outdated");
    expect(threadAnchorLabel(thread({ kind: "review", path: null, line: null, reviewState: "changes_requested" }))).toBe(
      "review · changes requested"
    );
    expect(threadAnchorLabel(thread({ kind: "review", path: null, line: null, reviewState: "approved" }))).toBe("review · approved");
    expect(threadAnchorLabel(thread({ kind: "conversation", path: null, line: null }))).toBe("on the conversation");
  });

  it("shows the tail of the hunk the words were written over, header dropped, toned by sign", () => {
    const hunk = "@@ -50,4 +55,6 @@\n BATCH = 32\n-LR = 1e-3\n+EPOCHS = 10\n+LR = 3e-4";
    expect(hunkTail(hunk)).toEqual([
      { text: " BATCH = 32", tone: "ctx" },
      { text: "-LR = 1e-3", tone: "del" },
      { text: "+EPOCHS = 10", tone: "add" },
      { text: "+LR = 3e-4", tone: "add" }
    ]);
    expect(hunkTail(hunk, 2)).toHaveLength(2);
    expect(hunkTail(null)).toEqual([]);
  });

  it("renders one comment as words for a chat: who, where, the code, the words", () => {
    const words = threadAsDirection(thread({ diffHunk: "@@ -1,2 +1,3 @@\n # fixture\n+limit = 100" }));
    expect(words).toBe('leePhilip23 on train.py:57: "Too many globals."\n```\n # fixture\n+limit = 100\n```');
    expect(threadAsDirection(thread({ kind: "conversation", path: null, line: null }))).toBe(
      'leePhilip23: "Too many globals."'
    );
  });
});

describe("directionTarget — where Send to chat sends (D-239)", () => {
  const detail = {
    sessions: [
      { sessionId: "csn_first", workstreamId: "wst_1", createdAt: "2026-08-20T10:00:00Z" },
      { sessionId: "csn_codex", workstreamId: "wst_1", createdAt: "2026-08-21T10:00:00Z" },
      { sessionId: "csn_other_lane", workstreamId: "wst_2", createdAt: "2026-08-19T10:00:00Z" }
    ],
    executions: [
      { sessionId: "csn_first", model: "claude-fable-5", effort: "high", createdAt: "2026-08-20T11:00:00Z" },
      { sessionId: "csn_codex", model: "gpt-5.6-sol", effort: "medium", createdAt: "2026-08-21T11:00:00Z" },
      { sessionId: "csn_codex", model: "gpt-5.5", effort: "low", createdAt: "2026-08-21T12:00:00Z" }
    ]
  } as unknown as Parameters<typeof directionTarget>[0];
  const fallback = { model: "claude-sonnet-5", effort: "medium" };

  it("sends to the chat being read, under that chat's latest model — never crossing harnesses", () => {
    expect(directionTarget(detail, "wst_1", "csn_codex", fallback)).toEqual({
      sessionId: "csn_codex",
      model: "gpt-5.5",
      effort: "low"
    });
  });

  it("falls back to the lane's first chat when the chat being read is another lane's, or none", () => {
    expect(directionTarget(detail, "wst_1", "csn_other_lane", fallback).sessionId).toBe("csn_first");
    expect(directionTarget(detail, "wst_1", null, fallback).model).toBe("claude-fable-5");
  });

  it("takes the caller's fallback for a chat that never ran, and no chat at all", () => {
    const fresh = { ...detail, executions: [] };
    expect(directionTarget(fresh, "wst_1", "csn_first", fallback)).toEqual({ sessionId: "csn_first", ...fallback });
    expect(directionTarget(detail, "wst_9", null, fallback)).toEqual({ sessionId: null, ...fallback });
  });
});
