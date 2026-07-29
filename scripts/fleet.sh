#!/usr/bin/env bash
# Cut isolated worktrees so several agents can work on Novus at once.
#
# Each slice gets its own directory, branch, and node_modules, so agents never
# fight over the working tree. The committed .claude/settings.json travels with
# every worktree, which is the reason permissions live there and not in
# settings.local.json.
#
#   ./scripts/fleet.sh add <slice> "<task>"   create the worktree and brief
#   ./scripts/fleet.sh list                   worktrees, branches, drift, lock
#   ./scripts/fleet.sh status                 same, plus run the gate in each
#   ./scripts/fleet.sh integrate [slice...]   gate the slices merged together
#   ./scripts/fleet.sh launch <slice>         print the command to drive it
#   ./scripts/fleet.sh run <slice> [rounds]   drive it unattended until green
#   ./scripts/fleet.sh rm <slice>             tear one down
#
# packages/contracts is the bottleneck: exactly one slice may own it at a time.
# scripts/contract-lock.sh enforces that, and the PreToolUse hook denies writes
# from any branch that has not claimed it.

set -uo pipefail

root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
fleet="$(dirname "$root")/novus-fleet"
cmd="${1:-list}"

# Agents inherit this PATH, so resolve the toolchain before spawning anything.
. "$root/scripts/toolchain.sh"
novus_use_node || exit 1

usage() {
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 1
}

# Underscore-prefixed directories are the fleet's own scratch space, not slices
# anyone is working in, so they stay out of list, status, and tmux.
slices() {
  [ -d "$fleet" ] || return 0
  for d in "$fleet"/*/; do
    [ -d "$d" ] || continue
    case "$(basename "$d")" in _*) continue ;; esac
    basename "$d"
  done
}

# One line per slice: where it is, how far it has drifted, whether it is dirty.
report() {
  local run_gate="${1:-no}"
  local slice dir branch ahead behind dirty gate

  printf '%-16s %-22s %-9s %-7s %s\n' SLICE BRANCH DRIFT TREE GATE
  for slice in $(slices); do
    dir="$fleet/$slice"
    branch="$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
    read -r behind ahead <<<"$(git -C "$dir" rev-list --left-right --count main...HEAD 2>/dev/null || echo '? ?')"
    dirty=$([ -n "$(git -C "$dir" status --porcelain 2>/dev/null)" ] && echo dirty || echo clean)

    gate='-'
    if [ "$run_gate" = "gate" ]; then
      gate=$( (cd "$dir" && ./scripts/gate.sh >/dev/null 2>&1) && echo GREEN || echo RED )
    fi

    printf '%-16s %-22s +%-3s-%-3s %-7s %s\n' "$slice" "$branch" "$ahead" "$behind" "$dirty" "$gate"
  done

  echo
  "$root/scripts/contract-lock.sh" status
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
    # a link-only install rather than a real download. A failure here has to be
    # loud: a half-installed worktree looks fine until an agent runs the gate in
    # it and starts debugging a repo that was never wired up.
    if ! (cd "$dir" && pnpm install --prefer-offline --silent); then
      echo >&2
      echo "pnpm install failed in $dir — removing the worktree rather than" >&2
      echo "handing an agent a repo that cannot build." >&2
      git -C "$root" worktree remove "$dir" --force 2>/dev/null || true
      git -C "$root" branch -D "$branch" 2>/dev/null || true
      exit 1
    fi

    printf '%s\n' "$task" > "$dir/.fleet-task"

    cat <<EOF

  slice   $slice
  branch  $branch
  dir     $dir

  Drive it yourself:

    ./scripts/fleet.sh launch $slice

  Or let it run unattended until the gate is green:

    ./scripts/fleet.sh run $slice

EOF
    ;;

  list)
    report no
    ;;

  status)
    report gate
    ;;

  launch)
    slice="${2:-}"
    [ -n "$slice" ] || usage
    dir="$fleet/$slice"
    [ -d "$dir" ] || { echo "no such slice: $slice" >&2; exit 1; }
    # Printed rather than executed: this is the interactive path, and the human
    # wants the session attached to their own terminal.
    echo "cd \"$dir\" && claude \"\$(cat .fleet-task)\""
    ;;

  run)
    slice="${2:-}"
    rounds="${3:-4}"
    [ -n "$slice" ] || usage
    dir="$fleet/$slice"
    [ -d "$dir" ] || { echo "no such slice: $slice" >&2; exit 1; }

    # The Stop hook already refuses to end a turn on a red gate, and gives up
    # after three tries so it cannot spin forever. This outer loop is the second
    # layer: when the hook exhausts itself, start a fresh session on the same
    # branch. Fresh context is often what an agent stuck on its own reasoning
    # actually needs.
    mode="${NOVUS_FLEET_PERMISSION_MODE:-acceptEdits}"
    task="$(cat "$dir/.fleet-task")"

    for round in $(seq 1 "$rounds"); do
      echo "── $slice · round $round/$rounds ──"

      if [ "$round" -eq 1 ]; then
        prompt="$task"
      else
        prompt="The previous session ended with the gate red. Run ./scripts/gate.sh, read the failures, and finish this task:

$task"
      fi

      (cd "$dir" && claude -p "$prompt" --permission-mode "$mode") || true

      if (cd "$dir" && ./scripts/gate.sh >/dev/null 2>&1); then
        echo "── $slice GREEN after round $round ──"
        exit 0
      fi
    done

    echo "── $slice still RED after $rounds rounds — needs a human ──" >&2
    (cd "$dir" && ./scripts/gate.sh) || true
    exit 1
    ;;

  integrate)
    # Two slices that are each green alone can still be broken together: they
    # touch the same function from different directions, or both add a field the
    # other does not handle. Nothing in a worktree can discover that, because a
    # worktree only ever contains one slice.
    #
    # So assemble them somewhere disposable. This merges the named slices (or
    # every slice) onto a scratch branch cut from main and runs the gate on the
    # combination. Main is never touched, and a bad result costs a directory.
    shift || true
    targets="${*:-$(slices)}"
    [ -n "$targets" ] || { echo "no slices to integrate" >&2; exit 1; }

    dir="$fleet/_integration"
    branch="fleet/_integration"

    git -C "$root" worktree remove "$dir" --force 2>/dev/null || true
    git -C "$root" branch -D "$branch" 2>/dev/null || true
    mkdir -p "$fleet"
    git -C "$root" worktree add -b "$branch" "$dir" main >/dev/null

    conflicted=""
    for slice in $targets; do
      if git -C "$dir" merge --no-ff -m "integrate $slice" "fleet/$slice" >/dev/null 2>&1; then
        echo "merged   $slice"
      else
        # Report which files, then back the merge out so the remaining slices
        # still get their turn. One conflicting pair should not hide the rest.
        echo "CONFLICT $slice"
        git -C "$dir" diff --name-only --diff-filter=U | sed 's/^/           /'
        git -C "$dir" merge --abort 2>/dev/null || true
        conflicted="${conflicted}${slice} "
      fi
    done

    echo
    if [ -n "$conflicted" ]; then
      echo "conflicts: $conflicted"
      echo "Those slices overlap. Land one, rebase the other onto main, re-run."
    fi

    (cd "$dir" && pnpm install --prefer-offline --silent) || {
      echo "install failed in the integration worktree" >&2; exit 1; }

    echo "── gate on the combination ──"
    if (cd "$dir" && ./scripts/gate.sh); then
      echo
      echo "The merged result is green. Inspect it at:"
      echo "  $dir"
      [ -n "$conflicted" ] && echo "(excluding the conflicted slices above)"
      exit 0
    fi

    echo
    echo "Green apart, red together — that is what this command is for." >&2
    echo "Fix it in the slice that owns the behaviour, not here: this branch is" >&2
    echo "thrown away and rebuilt on the next integrate." >&2
    exit 1
    ;;

  tmux)
    command -v tmux >/dev/null || { echo "tmux is not installed: brew install tmux" >&2; exit 1; }
    [ -n "$(slices)" ] || { echo "no slices yet — ./scripts/fleet.sh add <slice> \"<task>\"" >&2; exit 1; }

    session=novus
    if tmux has-session -t "$session" 2>/dev/null; then
      echo "attaching to the existing '$session' session"
    else
      # Window 0 is the main repo: this is where you watch status and merge from,
      # and it is deliberately not a slice so there is always one checkout that
      # no agent is writing to.
      tmux new-session -d -s "$session" -n main -c "$root"
      tmux send-keys -t "$session:main" './scripts/fleet.sh status' C-m

      for slice in $(slices); do
        dir="$fleet/$slice"
        tmux new-window -t "$session" -n "$slice" -c "$dir"
        # Pre-typed, not sent: starting several agents is the human's call, and
        # a slice whose brief has drifted should be read before it runs.
        tmux send-keys -t "$session:$slice" 'claude "$(cat .fleet-task)"'
      done
      tmux select-window -t "$session:main"
    fi

    if [ -n "${TMUX:-}" ]; then
      tmux switch-client -t "$session"
    else
      tmux attach-session -t "$session"
    fi
    ;;

  rm)
    slice="${2:-}"
    [ -n "$slice" ] || usage
    dir="$fleet/$slice"
    branch="fleet/$slice"

    # A slice that dies holding the boundary would wedge every other slice.
    if [ "$(cd "$dir" 2>/dev/null && "$root/scripts/contract-lock.sh" check; echo $?)" = 0 ]; then
      (cd "$dir" && "$root/scripts/contract-lock.sh" release) || true
    fi

    git -C "$root" worktree remove "$dir" --force
    git -C "$root" branch -D "$branch" 2>/dev/null || true
    echo "removed $slice"
    ;;

  *)
    usage
    ;;
esac
