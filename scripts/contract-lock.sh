#!/usr/bin/env bash
# The mutex on packages/contracts.
#
# Every slice eventually edits contracts.ts — it is the boundary both sides
# share, so it is also the one file two parallel agents will silently corrupt.
# Git cannot help here: both branches edit the same lines and the conflict only
# surfaces at merge, long after both agents have built on top of their own
# version of the truth.
#
# So the lock is taken before the edit, not after. It lives in the shared
# .git directory, which every worktree of this repo already points at, so a
# claim made in one worktree is visible in all of them without any coordination
# between the agents themselves.
#
#   ./scripts/contract-lock.sh acquire   claim the boundary for this branch
#   ./scripts/contract-lock.sh release   give it back
#   ./scripts/contract-lock.sh status    who holds it, if anyone
#   ./scripts/contract-lock.sh check     exit 0 if this branch may edit contracts
#
# The PreToolUse hook calls `check` on every write to packages/contracts, so an
# agent that forgets to acquire is denied rather than trusted.

set -uo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
common="$(git rev-parse --git-common-dir 2>/dev/null)" || exit 0
case "$common" in /*) ;; *) common="$root/$common" ;; esac

lock="$common/novus-contract.lock"
holder_file="$lock/holder"
branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"

# A lock older than this is assumed abandoned — an agent was killed, a laptop
# slept. Better to reclaim it loudly than to wedge the whole fleet.
STALE_SECONDS=${NOVUS_LOCK_STALE_SECONDS:-7200}

read_holder() { cat "$holder_file" 2>/dev/null | head -1; }

lock_age() {
  local mtime now
  mtime="$(stat -f %m "$holder_file" 2>/dev/null || stat -c %Y "$holder_file" 2>/dev/null)" || return 1
  now="$(date +%s)"
  echo $(( now - mtime ))
}

drop_if_stale() {
  local age
  age="$(lock_age)" || return 1
  if [ "$age" -gt "$STALE_SECONDS" ]; then
    printf 'contract lock held by %s for %ss — treating as abandoned.\n' \
      "$(read_holder)" "$age" >&2
    rm -rf "$lock"
    return 0
  fi
  return 1
}

case "${1:-status}" in
  acquire)
    # mkdir is atomic, which is the entire reason the lock is a directory.
    if mkdir "$lock" 2>/dev/null; then
      printf '%s\n' "$branch" > "$holder_file"
      echo "contract lock acquired by $branch"
      exit 0
    fi

    current="$(read_holder)"
    if [ "$current" = "$branch" ]; then
      echo "contract lock already held by $branch"
      exit 0
    fi

    if drop_if_stale && mkdir "$lock" 2>/dev/null; then
      printf '%s\n' "$branch" > "$holder_file"
      echo "contract lock reclaimed by $branch"
      exit 0
    fi

    cat >&2 <<EOF
contract lock is held by: $current

$branch may not edit packages/contracts right now. Either:
  - build the part of this slice that does not touch the boundary, or
  - wait for $current to merge, rebase onto it, then acquire.

If $current is dead: ./scripts/contract-lock.sh force-release
EOF
    exit 1
    ;;

  release)
    current="$(read_holder)"
    if [ ! -d "$lock" ]; then
      echo "contract lock was not held"
      exit 0
    fi
    if [ "$current" != "$branch" ]; then
      echo "contract lock is held by $current, not $branch — refusing to release." >&2
      exit 1
    fi
    rm -rf "$lock"
    echo "contract lock released by $branch"
    ;;

  force-release)
    rm -rf "$lock"
    echo "contract lock forcibly released"
    ;;

  status)
    if [ -d "$lock" ]; then
      printf 'contract lock: %s (held %ss)\n' "$(read_holder)" "$(lock_age 2>/dev/null || echo '?')"
    else
      echo "contract lock: free"
    fi
    ;;

  check)
    # Silent by design: this is the hook's question, asked on every write.
    [ -d "$lock" ] || exit 1
    [ "$(read_holder)" = "$branch" ] || exit 1
    exit 0
    ;;

  *)
    sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
