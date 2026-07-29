#!/usr/bin/env bash
# Put the Node the repo actually requires on PATH. Source this, do not run it.
#
# nvm is a shell function loaded from an interactive profile, so anything the
# fleet spawns — a hook, a background run, an agent's subshell — inherits
# whatever /usr/local/bin/node happens to be instead. On this machine that is
# Node 22, which cannot run the repo at all: package.json wants >=24, and the
# strip-only TypeScript the whole codebase depends on is a 24 feature.
#
# The failure is nasty because it does not look like a version problem. pnpm
# reports an engine mismatch, the install half-finishes, and the agent that
# lands in that worktree sees a broken repo it did not break.
#
# So resolve it here, once, from nvm's directory rather than from nvm itself.

_novus_node_major() { "$1" -v 2>/dev/null | sed 's/^v//' | cut -d. -f1; }

novus_use_node() {
  local required=24 current root pinned pinned_major available chosen dir version

  current="$(_novus_node_major "$(command -v node 2>/dev/null)" 2>/dev/null || echo 0)"
  if [ -n "$current" ] && [ "$current" -ge "$required" ] 2>/dev/null; then
    return 0
  fi

  root="$(git rev-parse --show-toplevel 2>/dev/null)"
  pinned="$(tr -d 'v \n' < "$root/.node-version" 2>/dev/null)"
  pinned_major="${pinned%%.*}"

  available="$(
    for dir in "$HOME/.nvm/versions/node"/*/; do
      [ -x "$dir/bin/node" ] || continue
      version="$(basename "$dir" | tr -d v)"
      [ "${version%%.*}" -ge "$required" ] 2>/dev/null && printf '%s\n' "$version"
    done | sort -V
  )"

  if [ -z "$available" ]; then
    echo "No Node >=$required found under ~/.nvm/versions/node." >&2
    echo "Install one with: nvm install ${pinned:-$required}" >&2
    return 1
  fi

  # Honour the pin when it is installed. When it is not — .node-version drifts
  # ahead of what anyone actually installed — stay inside the pinned major
  # rather than silently jumping a major version, because staying on a known
  # major is the whole reason the pin exists. Fall back to newest only if that
  # major is absent entirely.
  chosen="$(printf '%s\n' "$available" | grep -Fx "$pinned" || true)"
  [ -n "$chosen" ] || chosen="$(printf '%s\n' "$available" | grep "^${pinned_major}\." | tail -1 || true)"
  [ -n "$chosen" ] || chosen="$(printf '%s\n' "$available" | tail -1)"

  PATH="$HOME/.nvm/versions/node/v$chosen/bin:$PATH"
  export PATH
  return 0
}
