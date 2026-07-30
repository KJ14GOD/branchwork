---
name: novus-run-app
description: Launch Novus and confirm it is actually working — the Electron desktop app, the worker on its own, or a single headless run against a goal. Use when asked to run, start, open, demo, or manually verify Novus, when a change needs checking in the real app rather than in tests, or when the app fails to start, returns 401, or reports a port already in use.
---

# Novus Run App

Three ways to start Novus. Pick by what you need to see, then verify it came up
rather than assuming it did.

## Choose the entry point

| you want | run |
| --- | --- |
| the desktop app | `pnpm --filter @novus/desktop dev` |
| the worker alone, waiting for a client | `pnpm --filter @novus/worker start` |
| one headless run and its transcript | `pnpm --filter @novus/worker start "<goal>"` |
| a browser guest (second window, or a teammate) | `pnpm --filter @novus/guest dev` |
| the relay, for a guest off this machine | `pnpm --filter @novus/session-service start` |

`electron .` on its own will not work. `dist-electron/` is produced by
`vite-plugin-electron` during `vite`, so the desktop script is the only entry.

The desktop app owns the worker: its main process spawns
`node --env-file=<root>/.env --experimental-strip-types` and waits up to 15s for
`/health`. Do not start the worker yourself first — you will take port 4319 and
the app will fail its health check.

Full multiplayer testing is four terminals: worker, desktop, guest, and the
relay if a teammate is off-machine. The relay prints the invite link itself —
use that one, not one you construct by hand, since the watch token is minted
fresh each run unless `NOVUS_RELAY_WATCH_TOKEN` is pinned in `.env`.

## When a dev server "can't be reached" but is running

Vite's default host resolution can bind `[::1]` (IPv6) only. Every link this
project prints and every doc in it uses `127.0.0.1` (IPv4), so a browser
hitting that address gets a flat connection refusal with nothing in either log
to explain why. Confirm with:

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep -E ':5273|:5274'
```

If you see `[::1]` instead of `127.0.0.1`, the fix is `server.host: "127.0.0.1"`
in that app's `vite.config.ts`, not a restart with different flags.

## Writes are denied unless you opt in

`apply_patch` is refused by default, because the fallback approval gate denies.
To let a run modify files, prefix with `NOVUS_ALLOW_WRITES=1`. The worker prints
which mode it is in on the first two lines; read them instead of guessing.

## When the key looks wrong

A 401 that looks like a bad API key is usually a shadowed one. `--env-file` does
**not** override a variable that is already set, so an exported
`ANTHROPIC_API_KEY` silently wins over `.env`. This bites agent shells and CI far
more often than a human terminal, and it reaches the worker even through the
desktop app, which passes its own environment to the child process.

Check before changing anything:

```bash
[ -n "$ANTHROPIC_API_KEY" ] && echo "exported — it is shadowing .env" || echo "clean"
```

If it is exported, prefix the command with `env -u ANTHROPIC_API_KEY`. Do not
edit `.env` to work around this, and never print the key to confirm it.

The same shadowing applies to `NOVUS_TOKEN`, and it is harder to notice because
the failure is a plain `401` on every route rather than something naming the
key. If a client using the token from the current `.env` is refused, the
worker process was very likely started before `.env` last changed — it minted
or pinned its token at boot and has held it in memory since. There is no live
way to ask a running worker what token it holds; restart it.

## Verify it is up

```bash
curl -s --max-time 3 http://127.0.0.1:4319/health
```

`{"status":"ok"}` means the worker is listening. For the desktop app also expect
a window; Vite serves the renderer on 5273. Both bind loopback only.

A run is working when the worker prints its goal, then tool lines, then a
summary. A run that ends on `✗ run failed` is a real failure — report it with
the message rather than retrying blindly.

## When a port is taken

`EADDRINUSE` means a previous worker is still alive. Find and stop it rather
than picking a new port at random:

```bash
pkill -f src/worker.ts
pkill -f "Electron.app/Contents/MacOS/Electron"
pkill -f vite
```

Use `NOVUS_PORT` only when you genuinely need two workers at once.

## Before handing back

Stop what you started. A worker, an Electron shell, or a Vite dev server left
running will collide with the next launch, and the user cannot see your
background processes. Confirm both ports are free before you report.
