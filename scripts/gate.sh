#!/usr/bin/env bash
# The single definition of "is Novus green right now".
#
# Everything else in the loop — the Stop hook, the fleet script, a human before
# pushing — asks this one question. Exit 0 means green. Any other exit means the
# work is not done, and the tail of the output says why.

set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1

failed=""

step() {
  local name="$1"
  shift
  local output
  if ! output="$("$@" 2>&1)"; then
    failed="${failed}${name} "
    printf '%s FAILED\n' "$name"
    printf '%s\n' "$output" | tail -25
    printf '\n'
  fi
}

step typecheck pnpm -s typecheck
step test pnpm -s test
step whitespace git diff --check

if [ -n "$failed" ]; then
  printf 'GATE RED: %s\n' "$failed"
  exit 1
fi

printf 'GATE GREEN\n'
