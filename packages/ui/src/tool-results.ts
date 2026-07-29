/**
 * The sentences a tool result is reduced to before it is drawn.
 *
 * Here rather than in the component for one reason: `git_status` reports three
 * states in two fields, and the third one is easy to lose. `clean` is null when
 * the check could not run, and the worker chose null over false precisely so an
 * unreadable repository could never be reported as a clean one. A renderer that
 * writes `clean ? "clean" : "dirty"` throws that distinction away and tells the
 * reader the most reassuring of the three things it could say. Keeping the
 * mapping in a plain function is what lets a test hold it.
 *
 * No JSX in this file, deliberately: `node --test` runs it under strip-only
 * type stripping, and a component would need a bundler to be looked at at all.
 */

import type { ToolCall, ToolResult } from "@novus/contracts";

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

/** What the row says a requested tool is about to do, in one line. */
export const summariseCall = (call: ToolCall): string => {
  if (call.name === "read_file") {
    return call.input.path;
  }

  if (call.name === "search_repository") {
    return `"${call.input.query}"${call.input.path ? ` in ${call.input.path}` : ""}`;
  }

  if (call.name === "propose_patch") {
    return `${call.input.path} · ${call.input.edits.length} edit${call.input.edits.length === 1 ? "" : "s"}`;
  }

  if (call.name === "run_command") {
    return [call.input.command, ...call.input.args].join(" ");
  }

  if (call.name === "run_tests") {
    return call.input.args.length > 0 ? call.input.args.join(" ") : "full suite";
  }

  if (call.name === "list_directory") {
    return call.input.path ?? ".";
  }

  if (call.name === "git_status") {
    return "working tree";
  }

  if (call.name === "git_diff") {
    return [call.input.staged ? "staged" : "unstaged", call.input.path]
      .filter(Boolean)
      .join(" · ");
  }

  return call.input.patchId;
};

/**
 * The two patch tools draw themselves rather than collapsing to a line, so they
 * are excluded here instead of being given a summary nothing ever reads. That
 * keeps the union exhaustive: a new tool is a compile error in one place.
 */
export type SummarisableToolResult = Exclude<
  ToolResult,
  { name: "propose_patch" | "apply_patch" }
>;

/** The line beside a completed tool's name, before its panel is opened. */
export const summariseToolResult = (result: SummarisableToolResult): string =>
  result.name === "read_file"
    ? result.output.path
    : result.name === "search_repository"
      ? `${result.output.matches.length} match${result.output.matches.length === 1 ? "" : "es"} for "${result.output.query}"`
      : result.name === "run_tests"
        ? result.output.passed
          ? "tests passed"
          : "tests failed"
        : result.name === "list_directory"
          ? `${result.output.entries.length} entr${result.output.entries.length === 1 ? "y" : "ies"}`
          : result.name === "git_status"
            ? result.output.clean === null
              ? "status unavailable"
              : result.output.clean
                ? "working tree clean"
                : `${result.output.files.length} file${result.output.files.length === 1 ? "" : "s"} dirty`
            : result.name === "git_diff"
              ? `${result.output.filesChanged} file${result.output.filesChanged === 1 ? "" : "s"} in diff`
              : result.output.command;
