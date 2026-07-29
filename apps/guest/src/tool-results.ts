/**
 * The sentences a tool result is reduced to before it is drawn.
 *
 * Here rather than in the component for one reason: `git_status` reports three
 * states in two fields, and the third one is easy to lose. `clean` is null when
 * the check could not run, and the worker chose null over false precisely so an
 * unreadable repository could never be reported as a clean one. A renderer that
 * writes `clean ? "clean" : "dirty"` throws that distinction away and tells the
 * guest the most reassuring of the three things it could say. Keeping the
 * mapping in a plain function is what lets a test hold it.
 */

import type { SessionEvent } from "@novus/contracts";

type ToolResult = Extract<
  SessionEvent,
  { type: "tool.completed" }
>["payload"]["result"];

export type GitStatusOutput = Extract<
  ToolResult,
  { name: "git_status" }
>["output"];

export type WorkingTreeReport = {
  branch: string;
  /** What the tree is. Never blank, and never "clean" unless it is known. */
  state: string;
  /** `unknown` is not a milder `dirty`; it means the answer is missing. */
  certainty: "clean" | "dirty" | "unknown";
};

export const describeWorkingTree = (
  output: GitStatusOutput,
): WorkingTreeReport => {
  if (output.clean === null) {
    return {
      // A branch is unknown for the same reason the state is: nothing was read.
      branch: output.branch ?? "unknown",
      state: "unknown — Git could not read this repository, so this is not a report that nothing changed",
      certainty: "unknown",
    };
  }

  const branch = output.branch ?? "detached HEAD";

  if (output.clean) {
    return { branch, state: "clean", certainty: "clean" };
  }

  const count = output.files.length;

  return {
    branch,
    // The list is capped by the worker, so a dirty tree with nothing listed is
    // possible and must still say it is dirty.
    state:
      count === 0
        ? "changed, with no files listed"
        : `${count} file${count === 1 ? "" : "s"} changed`,
    certainty: "dirty",
  };
};
