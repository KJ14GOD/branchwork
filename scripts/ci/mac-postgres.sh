#!/usr/bin/env bash
# An isolated PostgreSQL for the suites on a macOS runner (the Windows
# runner has its own script): one cluster under the workspace, port 5433,
# user novus/novus, database novus — exactly what the tests dial.
set -euo pipefail
PGDIR="${RUNNER_TEMP:-/tmp}/novus-pg"
if ! command -v initdb >/dev/null 2>&1; then
  brew install postgresql@16 >/dev/null
  echo "$(brew --prefix postgresql@16)/bin" >> "$GITHUB_PATH"
  export PATH="$(brew --prefix postgresql@16)/bin:$PATH"
fi
rm -rf "$PGDIR"
initdb -D "$PGDIR" -U novus --auth=trust >/dev/null
pg_ctl -D "$PGDIR" -o "-p 5433 -c listen_addresses=127.0.0.1" -l "$PGDIR/log" start
for attempt in $(seq 1 30); do
  if pg_isready -h 127.0.0.1 -p 5433 -U novus >/dev/null 2>&1; then break; fi
  sleep 1
done
psql -h 127.0.0.1 -p 5433 -U novus -d postgres -c "alter user novus with password 'novus';" >/dev/null
psql -h 127.0.0.1 -p 5433 -U novus -d postgres -c "create database novus;" >/dev/null
echo "PostgreSQL on 127.0.0.1:5433"
