#!/usr/bin/env bash
# PreToolUse hook: no writing the boundary without holding the boundary lock.
#
# Reads the hook payload on stdin. If the tool is about to write a file under
# packages/contracts and this branch does not hold the contract lock, the call
# is denied and the reason goes back to the model, which can then either acquire
# the lock or go build something else in the meantime.
#
# A denial here is not a failure. It is the fleet working: two agents wanted the
# same file and only one got it.

set -uo pipefail

payload="$(cat)"

path="$(printf '%s' "$payload" | jq -r '.tool_input.file_path // .tool_input.path // empty' 2>/dev/null)"
[ -n "$path" ] || exit 0

case "$path" in
  *packages/contracts/*) ;;
  *) exit 0 ;;
esac

# Ask the question from where the file lives, not from where the process happens
# to be. A session rooted in the main checkout can be told to edit a file inside
# a slice's worktree, and it is the worktree that owns the branch and therefore
# the claim — deciding by process CWD would deny that write while the slice
# legitimately holds the lock.
target_dir="$(cd "$(dirname "$path")" 2>/dev/null && pwd)" || target_dir="$PWD"
root="$(git -C "$target_dir" rev-parse --show-toplevel 2>/dev/null)" || exit 0

if (cd "$root" && ./scripts/contract-lock.sh check); then
  exit 0
fi

holder="$(cd "$root" && ./scripts/contract-lock.sh status 2>/dev/null)"
branch="$(git -C "$root" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"

jq -n --arg h "$holder" --arg b "$branch" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: (
      "packages/contracts is the shared boundary and this branch (\($ARGS.named.b)) does not hold its lock.\n" +
      "Current \($ARGS.named.h).\n\n" +
      "Run ./scripts/contract-lock.sh acquire to claim it. If another slice holds it, build the part of this slice that does not touch the boundary instead, and take the lock after that slice merges."
    )
  }
}'
