#!/usr/bin/env bash
# Stop hook: refuse to let a turn end on a red gate.
#
# Reads the hook payload on stdin, and when the working tree has code changes
# that do not pass scripts/gate.sh, returns decision "block" so the failure goes
# back to the model instead of to the user. That is the whole loop: the agent
# cannot declare victory while the repo is broken.
#
# The circuit breaker matters as much as the block. Three consecutive blocks per
# session and the hook gives up and reports instead, so a genuinely unfixable
# failure ends the turn rather than spinning forever.

set -uo pipefail

MAX_BLOCKS=3
payload="$(cat)"
session="$(printf '%s' "$payload" | jq -r '.session_id // "unknown"' 2>/dev/null || echo unknown)"
counter="${TMPDIR:-/tmp}/novus-gate-${session}"

root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
cd "$root" || exit 0

# Nothing was touched under version control, so there is nothing to verify.
if [ -z "$(git status --porcelain -- apps packages scripts 2>/dev/null)" ]; then
  rm -f "$counter"
  exit 0
fi

if output="$(./scripts/gate.sh 2>&1)"; then
  rm -f "$counter"
  exit 0
fi

blocks=$(( $(cat "$counter" 2>/dev/null || echo 0) + 1 ))
printf '%s' "$blocks" > "$counter"

if [ "$blocks" -gt "$MAX_BLOCKS" ]; then
  rm -f "$counter"
  jq -n --arg o "$output" \
    '{systemMessage: ("Gate still red after \($ARGS.named.n) attempts — stopping. \n" + $o), continue: true}' \
    --arg n "$MAX_BLOCKS"
  exit 0
fi

jq -n --arg o "$output" --arg n "$blocks" --arg m "$MAX_BLOCKS" \
  '{decision: "block", reason: ("The gate is red, so this work is not finished (attempt \($ARGS.named.n) of \($ARGS.named.m)). Fix the failures below and re-run ./scripts/gate.sh yourself before stopping.\n\n" + $o)}'
