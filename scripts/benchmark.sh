#!/usr/bin/env bash
# Run the evaluation benchmarks and print a verdict.
#
# The scoring lives in apps/worker/src/benchmark.ts, because scoring means
# reading typed events and a run receipt back out of the harness and that is
# not a thing to do in shell. What is left here is the part that is genuinely
# environmental, and that every previous attempt to run Novus by hand got
# wrong: putting Node 24 on PATH, and loading the provider key in the one way
# that actually works.
#
#   ./scripts/benchmark.sh                     all three, deterministic, free
#   ./scripts/benchmark.sh bug-fix             one of them
#   ./scripts/benchmark.sh repo-reasoning --live   one real model run, costs money
#   ./scripts/benchmark.sh --keep              leave the scratch repositories on disk
#
# The three tasks are bug-fix, small-feature, and repo-reasoning; each has a
# directory under benchmarks/ with a README explaining what it is for. Naming
# none of them runs all three in sequence, which is what the deterministic
# variant is for. Naming none of them with --live spends three provider calls'
# worth of run, so say which one you meant.
#
# The live run reads its key from .env at the repository root, or from the file
# NOVUS_ENV_FILE names. `--env-file` does not override a variable that is
# already exported, so ANTHROPIC_API_KEY is unset first — otherwise a stale key
# in the parent shell silently wins and the failure arrives as a 401 that looks
# like a bad key in .env.

set -uo pipefail

root="$(git rev-parse --show-toplevel)" || exit 1
cd "$root" || exit 1

. "$root/scripts/toolchain.sh"
novus_use_node || exit 1

variant="scripted"

for arg in "$@"; do
  case "$arg" in
    --live) variant="live" ;;
    -h | --help)
      sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*) ;;
    bug-fix | small-feature | repo-reasoning) ;;
    *)
      echo "Unknown benchmark: $arg" >&2
      echo "Known: bug-fix, small-feature, repo-reasoning." >&2
      exit 2
      ;;
  esac
done

if [ "${NOVUS_BENCHMARK_LIVE:-}" = "1" ]; then
  variant="live"
fi

if [ "$variant" != "live" ]; then
  exec env -u ANTHROPIC_API_KEY \
    node --experimental-strip-types apps/worker/src/benchmark.ts "$@"
fi

env_file="${NOVUS_ENV_FILE:-$root/.env}"

if [ ! -f "$env_file" ]; then
  echo "The live benchmark needs a provider key and found no env file." >&2
  echo "Expected $env_file, or point NOVUS_ENV_FILE at one." >&2
  echo "A worktree does not inherit .env from the main checkout — it is" >&2
  echo "gitignored — so from a fleet worktree this is the usual cause." >&2
  exit 1
fi

exec env -u ANTHROPIC_API_KEY NOVUS_BENCHMARK_LIVE=1 \
  node "--env-file=$env_file" \
  --experimental-strip-types apps/worker/src/benchmark.ts "$@"
