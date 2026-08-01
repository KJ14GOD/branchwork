/**
 * Novus's permissions, translated into Claude Code's argv.
 *
 * Pure and separately tested because this is the one place in the adapter
 * where a mistake widens what an agent may do. Everything else it gets wrong
 * produces a bad timeline; this produces a write nobody authorised.
 *
 * The honest statement of what this buys: Claude Code enforces its own
 * permissions, and Novus's approval gate is never in the path. That is why the
 * adapter declares `approvals: "harness-internal"` — the difference from the
 * built-in loop is real and is recorded, rather than papered over by a
 * translation that looks equivalent and is not. What argv can do is refuse
 * whole tools outright, and the deny-by-default row is the one that matters.
 */

/** Tools that can write to the tree. */
const WRITE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"] as const;

/** Tools that can run arbitrary programs, which is a superset of writing. */
const COMMAND_TOOLS = ["Bash", "BashOutput", "KillShell"] as const;

/** Tools that reach the network. Refused whenever commands are. */
const NETWORK_TOOLS = ["WebFetch", "WebSearch"] as const;

export type ClaudeCodePermissions = {
  allowWrites: boolean;
  allowCommands: boolean;
};

/**
 * The argv for one session under one permission set.
 *
 * `--dangerously-skip-permissions` is never produced under any combination.
 * There is no input to this function that returns it, which is the point of
 * the function existing rather than the flags being assembled at the call
 * site.
 */
export const claudeCodeArgs = (
  permissions: ClaudeCodePermissions,
  model: string | null,
): string[] => {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--verbose",
  ];

  if (model) {
    args.push("--model", model);
  }

  const denied: string[] = [];

  if (!permissions.allowCommands) {
    denied.push(...COMMAND_TOOLS, ...NETWORK_TOOLS);
  }

  if (!permissions.allowWrites) {
    denied.push(...WRITE_TOOLS);
  }

  // `plan` refuses every mutation regardless of the deny list, so a session
  // with neither permission is refused twice over. Belt and braces on purpose:
  // this is the row where a translation bug is a write nobody authorised, and
  // the deny list alone would depend on the tool names above staying complete
  // as Claude Code adds tools.
  args.push(
    "--permission-mode",
    permissions.allowWrites ? "acceptEdits" : "plan",
  );

  if (denied.length > 0) {
    args.push("--disallowedTools", denied.join(","));
  }

  return args;
};
