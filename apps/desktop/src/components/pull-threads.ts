import type { MissionDetailResponse, PullRequest, ReviewThread } from "@novus/contracts";

/**
 * Where the host's comments belong on a request page (D-239).
 *
 * A line thread anchors to a diff line: the new file's line while the diff
 * still has it, the old file's line once the host calls it outdated — the
 * thread stays where the reviewer left it rather than vanishing. Review
 * summaries and conversation comments anchor to nothing and live on the
 * Conversation tab alone. "Open" as a count means unresolved line threads:
 * the things a person can still resolve — a review's words or a
 * conversation comment are read, never resolved.
 */

export function isLineThread(thread: ReviewThread): boolean {
  return thread.kind === "line";
}

/** Unresolved line threads: what the tab count and the readiness row mean. */
export function openLineThreads(pull: Pick<PullRequest, "reviewThreads">): ReviewThread[] {
  return pull.reviewThreads.filter((thread) => isLineThread(thread) && thread.state === "open");
}

/** The threads that sit under one rendered diff line of one file. */
export function threadsAtLine(
  threads: readonly ReviewThread[],
  path: string,
  at: { oldLine: number | null; newLine: number | null }
): ReviewThread[] {
  return threads.filter((thread) => {
    if (!isLineThread(thread) || thread.path !== path || thread.line === null) return false;
    return thread.outdated ? at.oldLine === thread.line : at.newLine === thread.line;
  });
}

/** The lines of code a conversation card shows above a line comment (D-239):
 *  the tail of the host's diff hunk — the hunk header dropped, at most the
 *  last `keep` lines, each with the tone its leading character gives it. */
export function hunkTail(
  diffHunk: string | null,
  keep = 6
): { text: string; tone: "add" | "del" | "ctx" }[] {
  if (!diffHunk) return [];
  const lines = diffHunk.replace(/\n+$/, "").split("\n").filter((line) => !line.startsWith("@@"));
  return lines.slice(-keep).map((line) => ({
    text: line,
    tone: line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx"
  }));
}

/**
 * Where "Send to chat" sends (D-239): the chat the person is reading when it
 * belongs to the request's lane, else the lane's first chat — and under that
 * chat's OWN model and effort, read off its latest turn, so a comment never
 * crosses harnesses (a chat is one harness's, D-232). A chat that has not
 * run yet takes the caller's fallback — the composer's remembered choice.
 */
export function directionTarget(
  detail: Pick<MissionDetailResponse, "sessions" | "executions">,
  workstreamId: string,
  preferredSessionId: string | null,
  fallback: { model: string; effort: string }
): { sessionId: string | null; model: string; effort: string } {
  const lane = detail.sessions
    .filter((session) => session.workstreamId === workstreamId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const session =
    lane.find((candidate) => candidate.sessionId === preferredSessionId) ?? lane[0] ?? null;
  if (session === null) return { sessionId: null, ...fallback };
  const latest = detail.executions
    .filter((execution) => execution.sessionId === session.sessionId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return {
    sessionId: session.sessionId,
    model: latest?.model ?? fallback.model,
    effort: latest?.effort ?? fallback.effort
  };
}

/** One review comment as words for a chat (D-239): who, where, the code it
 *  was written over, and the words — bounded, never a summary of them. */
export function threadAsDirection(thread: ReviewThread, quoteAt = 400): string {
  const quoted = thread.body.length > quoteAt ? `${thread.body.slice(0, quoteAt - 1)}…` : thread.body;
  const where = thread.path ? ` on ${thread.path}${thread.line !== null ? `:${thread.line}` : ""}` : "";
  const code = hunkTail(thread.diffHunk, 6)
    .map((line) => line.text)
    .join("\n");
  return `${thread.author}${where}: "${quoted}"${code ? `\n\`\`\`\n${code}\n\`\`\`` : ""}`;
}

/** The words a card's anchor slot says for each kind of comment. */
export function threadAnchorLabel(thread: ReviewThread): string {
  if (thread.kind === "review") {
    return thread.reviewState === "approved"
      ? "review · approved"
      : thread.reviewState === "changes_requested"
        ? "review · changes requested"
        : "review";
  }
  if (thread.kind === "conversation" || thread.path === null) return "on the conversation";
  return `${thread.path}${thread.line !== null ? `:${thread.line}` : ""}${thread.outdated ? " · outdated" : ""}`;
}
