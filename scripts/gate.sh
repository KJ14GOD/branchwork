#!/usr/bin/env bash
# The repository gate. Exits 0 only when every check passes.
# Usage: scripts/gate.sh          (full check)
# See AGENTS.md — this script is the required gate for every change.
set -u
cd "$(dirname "$0")/.."

FAIL=0
fail() { echo "GATE FAIL: $1"; FAIL=1; }

CANON="README.md PRODUCT.md DESIGN.md ARCHITECTURE.md PROGRESS.md DECISIONS.md AGENTS.md"

# 1. Frontmatter: five fields, present and in order, in every canonical doc.
for f in $CANON; do
  [ -f "$f" ] || { fail "missing canonical doc: $f"; continue; }
  order=$(grep -nE '^(Purpose|Authoritative for|Not authoritative for|Update when|Last reviewed):' "$f" | head -5 | cut -d: -f2 | paste -sd'|' -)
  [ "$order" = "Purpose|Authoritative for|Not authoritative for|Update when|Last reviewed" ] \
    || fail "$f frontmatter fields missing or out of order"
done

# 2. CLAUDE.md is a symlink to AGENTS.md.
{ [ -L CLAUDE.md ] && [ "$(readlink CLAUDE.md)" = "AGENTS.md" ]; } || fail "CLAUDE.md is not a symlink to AGENTS.md"

# 3. Root Markdown allowlist: no undecided root docs.
for f in *.md; do
  case " $CANON CLAUDE.md " in
    *" $f "*) ;;
    *) fail "root Markdown file not in canon: $f (requires a DECISIONS.md entry)";;
  esac
done

# 4. Internal file links resolve.
grep -RhoE '\]\([A-Za-z0-9._/-]+\.md' $CANON | sed -E 's/.*\(//' | sort -u | while read -r t; do
  [ -f "$t" ] || echo "$t"
done | while read -r broken; do fail "broken file link: $broken"; done
# (subshell can't set FAIL; re-check)
missing_links=$(grep -RhoE '\]\([A-Za-z0-9._/-]+\.md' $CANON | sed -E 's/.*\(//' | sort -u | while read -r t; do [ -f "$t" ] || echo "$t"; done)
[ -z "$missing_links" ] || { echo "$missing_links" | sed 's/^/GATE FAIL: broken file link: /'; FAIL=1; }

# 5. Internal anchors resolve (GitHub style: lowercase, spaces->hyphens, punctuation stripped).
broken_anchors=$(grep -RnoE '\]\([A-Za-z0-9._/-]+\.md#[a-z0-9-]+\)' $CANON | sed -E 's/\]\(/ /; s/\)$//' | awk '{print $1, $2}' | \
while read -r src target; do
  file="${target%%#*}"; anchor="${target##*#}"
  [ -f "$file" ] || continue
  n=$(grep -iE '^#+ ' "$file" | sed -E 's/^#+ +//; s/[^a-zA-Z0-9 -]//g; s/ /-/g' | tr '[:upper:]' '[:lower:]' | grep -cx "$anchor")
  [ "$n" -ge 1 ] || echo "$src -> $target"
done)
[ -z "$broken_anchors" ] || { echo "$broken_anchors" | sed 's/^/GATE FAIL: broken anchor: /'; FAIL=1; }

# 6. Banned language (outside the lines that state the ban).
banned=$(grep -rniE 'seamless|single pane of glass|ai-powered|supercharge your' $CANON | grep -viE 'language rules|banned|never "seamless"' || true)
[ -z "$banned" ] || { echo "$banned" | sed 's/^/GATE FAIL: banned language: /'; FAIL=1; }

# 7. Canonical terms defined only in PRODUCT.md (definition = bolded domain-model bullet).
term_dups=$(grep -rlE '^- \*\*(Mission|Workstream|Execution|Direction|ControlLease|ControlRequest|HandoffOffer|Receipt|Participant|Capability|Harness|Runner|Workspace|Evidence|Artifact|Event)\*\*' \
  $CANON .claude/ skills/ 2>/dev/null | grep -v '^PRODUCT.md$' | grep -v '^.claude/worktrees/' || true)
[ -z "$term_dups" ] || { echo "$term_dups" | sed 's/^/GATE FAIL: domain term defined outside PRODUCT.md: /'; FAIL=1; }

# 8. No product truth in skills/agent config.
truth_leak=$(grep -rlE '^(Mission|Workstream|Execution|Direction|ControlLease|Receipt):' .claude/ skills/ 2>/dev/null | grep -v '^.claude/worktrees/' || true)
[ -z "$truth_leak" ] || { echo "$truth_leak" | sed 's/^/GATE FAIL: product definitions outside canonical docs: /'; FAIL=1; }

# 9. No gradients in source code (once it exists).
grads=$(grep -rln 'linear-gradient\|radial-gradient\|conic-gradient' --include='*.css' --include='*.tsx' --include='*.ts' apps/ packages/ src/ services/ clients/ 2>/dev/null || true)
[ -z "$grads" ] || { echo "$grads" | sed 's/^/GATE FAIL: gradient in source: /'; FAIL=1; }

# 10. No raw color values in component source (tokens only; token definition files exempt via 'tokens' in path).
rawhex=$(grep -rlnE '#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(' --include='*.tsx' --include='*.ts' apps/ packages/ src/ services/ clients/ 2>/dev/null | grep -v tokens || true)
[ -z "$rawhex" ] || { echo "$rawhex" | sed 's/^/GATE FAIL: raw color value in component source: /'; FAIL=1; }

# 11. Any implementation change requires a PROGRESS.md reconciliation in the same working change.
changed=$(
  {
    git diff --name-only 2>/dev/null || true
    git diff --cached --name-only 2>/dev/null || true
    git ls-files --others --exclude-standard 2>/dev/null || true
  } | sort -u
)
if echo "$changed" | grep -qE '^(apps|packages|src|services|clients|spikes|scripts)/|^(package.json|pnpm-lock.yaml|pnpm-workspace.yaml|tsconfig[^/]*\.json)$'; then
  echo "$changed" | grep -q '^PROGRESS.md$' || fail "implementation changes without a PROGRESS.md reconciliation"
fi

# 12. Untracked files: nothing sits in the repo undecided.
untracked=$(git status --porcelain 2>/dev/null | grep '^??' | awk '{print $2}' || true)
[ -z "$untracked" ] || { echo "$untracked" | sed 's/^/GATE FAIL: untracked file (track it or ignore it deliberately): /'; FAIL=1; }

# 12b. Every decision cited anywhere must actually exist (D-059).
#
# D-053 was cited by six files — two canonical documents, three source files and
# a test — for a full session before anyone noticed it had never been written.
# Nothing caught it because nothing looked. This is deliberately the narrowest
# possible check: it does not police numbering, gaps, or ordering, only that a
# reference resolves to a heading. A gap in the sequence is fine: one number in
# the thirties has never existed, and PROGRESS.md says so.
# Build output is not a citation — it is a copy of one, and it lags.
# A line that says a number does *not* exist is prose about the gap, not a
# reference to follow, so it opts out by saying so in those words.
cited=$(grep -rhE 'D-[0-9]{3}' $CANON apps/ packages/ scripts/ 2>/dev/null \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=dist-electron \
  --exclude-dir=dist-renderer --exclude-dir=worktrees \
  | grep -viE 'never existed|never been written|never happened|no such decision' \
  | grep -oE 'D-[0-9]{3}' | sort -u || true)
for d in $cited; do
  grep -qE "^## $d " DECISIONS.md || fail "decision cited but never written: $d"
done

# 13. Application build, typecheck, lint, and deterministic tests.
#
# Output is kept rather than discarded. It used to go to /dev/null, which made
# an intermittent failure here undiagnosable by construction: the only way to
# see what broke was to run the command outside the gate, and outside the gate
# — unloaded, after nothing else — is exactly the condition it does not break
# under. A gate that says a step failed and not why is one bit of information.
GATE_LOGS="${TMPDIR:-/tmp}/novus-gate-$$"
mkdir -p "$GATE_LOGS"

step() {
  local name="$1" script="$2" log="$GATE_LOGS/$2.log"
  if ! pnpm run "$script" >"$log" 2>&1; then
    echo "--- last 40 lines of $log ---" >&2
    tail -40 "$log" >&2
    echo "--- full output: $log ---" >&2
    fail "$name failed (pnpm run $script)"
  fi
}

if [ -f package.json ]; then
  pnpm run db:up >/dev/null 2>&1 || true
  step "application build" build
  step "typecheck" typecheck
  step "lint" lint
  step "deterministic tests" test
fi

if [ "$FAIL" -eq 0 ]; then
  echo "GATE PASS"
  exit 0
else
  exit 1
fi
