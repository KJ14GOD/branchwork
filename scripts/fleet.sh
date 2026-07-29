#!/usr/bin/env bash
# Cut isolated worktrees so several agents can work on Novus at once.
#
# Each slice gets its own directory, branch, and node_modules, so agents never
# fight over the working tree. The committed .claude/settings.json travels with
# every worktree, which is the reason permissions live there and not in
# settings.local.json.
#
#   ./scripts/fleet.sh add <slice> "<task>"   create the worktree and brief
#   ./scripts/fleet.sh list                   show the fleet
#   ./scripts/fleet.sh rm <slice>             tear one down
#
# One rule this cannot enforce for you: packages/contracts is the bottleneck.
# Exactly one slice may own it at a time. Everything downstream can run beside it.

set -euo pipefail

root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
fleet="$(dirname "$root")/novus-fleet"
cmd="${1:-list}"

usage() {
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 1
}

case "$cmd" in
  add)
    slice="${2:-}"
    task="${3:-}"
    [ -n "$slice" ] && [ -n "$task" ] || usage

    dir="$fleet/$slice"
    branch="fleet/$slice"

    if [ -e "$dir" ]; then
      echo "$dir already exists — pick another name or rm it first." >&2
      exit 1
    fi

    mkdir -p "$fleet"
    git -C "$root" worktree add -b "$branch" "$dir" HEAD

    # Worktrees start with no node_modules. The pnpm store is shared, so this is
    # a link-only install rather than a real download.
    (cd "$dir" && pnpm install --prefer-offline --silent)

    printf '%s\n' "$task" > "$dir/.fleet-task"

    cat <<EOF

  slice   $slice
  branch  $branch
  dir     $dir

  Launch it:

    cd "$dir" && claude "\$(cat .fleet-task)"

  Merge it when the gate is green:

    cd "$root" && git merge --no-ff $branch

EOF
    ;;

  list)
    git -C "$root" worktree list
    ;;

  rm)
    slice="${2:-}"
    [ -n "$slice" ] || usage
    dir="$fleet/$slice"
    git -C "$root" worktree remove "$dir" --force
    git -C "$root" branch -D "fleet/$slice" 2>/dev/null || true
    echo "removed $slice"
    ;;

  *)
    usage
    ;;
esac
