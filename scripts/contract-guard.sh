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

root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

if "$root/scripts/contract-lock.sh" check; then
  exit 0
fi

holder="$("$root/scripts/contract-lock.sh" status 2>/dev/null)"
branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"

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
