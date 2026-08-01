#!/usr/bin/env bash
#
# Launch Novus against a throwaway log holding every mission state.
#
# Nothing here can reach a provider: ANTHROPIC_API_KEY is pinned to an obvious
# placeholder, which is the only reliable way to guarantee it — `--env-file`
# does not override a variable that is already set, so unsetting is not enough
# on a machine where a real key is exported.
#
# The log and the fixture repositories live under .fixtures/, which is
# disposable. Delete it and re-run to start clean.
#
#   ./scripts/fixtures.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."

FIXTURES="$PWD/.fixtures"
DB="$FIXTURES/missions.db"
REPO="$FIXTURES/checkout-service"

rm -rf "$FIXTURES"
mkdir -p "$REPO/src/auth" "$REPO/src/routes" "$REPO/src/billing"

# A real repository, because the app refuses one without a commit — the
# start canvas says "No commits yet" rather than "Ready", which is a
# different fixture from the one this is trying to produce.
printf 'export const session = 1;\n' > "$REPO/src/auth/session.ts"
printf 'export const middleware = 1;\n' > "$REPO/src/auth/middleware.ts"
printf 'export const login = 1;\n' > "$REPO/src/routes/login.ts"
printf 'export const token = 1;\n' > "$REPO/src/routes/token.ts"
printf 'export const billing = 1;\n' > "$REPO/src/billing/index.ts"
printf '{"name":"checkout-service"}\n' > "$REPO/package.json"

git -C "$REPO" init -q
git -C "$REPO" add -A
git -C "$REPO" -c user.email=fixtures@novus -c user.name=Fixtures commit -qm "initial"

node --experimental-strip-types scripts/seed-fixtures.ts "$FIXTURES" "$DB" > /dev/null

cat <<'NOTE'

Fixture missions seeded. In the app: Missions (top right) → pick one.

  Opened, nothing run yet          the start canvas
  Replace the hand-rolled retry…   an agent part-way through
  Migrate authentication…          changed, nothing verified
  Add rate limiting…               verified — the only green
  Upgrade the payment SDK…         stopped before it changed anything
  Add a health endpoint            two turns, which is still one agent
  Split the billing worker…        two approaches, side by side
  Fix the failing checkout total…  finished: resolved, and verified
  Rewrite the billing worker…      finished: abandoned, nothing verified

Nothing routes you off the Workroom any more. A mission with two approaches
shows them in the rail; Approaches opens as a focus pane over the same screen,
and only when you ask for it. The Decision Room that used to take the whole
window on arrival is gone.

NOTE

NOVUS_DB="$DB" \
NOVUS_ALLOW_WRITES=1 \
ANTHROPIC_API_KEY=sk-ant-FIXTURES-PLACEHOLDER-not-a-key \
  pnpm --filter @novus/desktop dev
