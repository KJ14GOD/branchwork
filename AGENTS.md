# Novus

A multiplayer coding harness for humans and AI agents. pnpm workspace: `apps/worker`
(agent loop, tools, event server), `apps/desktop` (React + Electron), `apps/guest`
(read-only browser viewer of one session's event log), `packages/contracts` (the Zod
boundary all of them share).

## Gate

Green before any commit:

```
pnpm typecheck && pnpm test && git diff --check
```

## Facts you cannot derive from the source

- **Node 24 runs TypeScript in strip-only mode** (`--experimental-strip-types`). No
  parameter properties, no `enum`, no decorators, no namespaces. Relative imports keep
  their `.ts` extension.
- **pnpm 11 moved build approvals** to `allowBuilds:` in `pnpm-workspace.yaml`. Adding
  them under `package.json` silently does nothing, and native postinstalls stay blocked.
- **`--env-file` does not override an already-set variable.** If `ANTHROPIC_API_KEY` is
  exported in the parent environment it shadows `.env` and you get a 401 that looks like
  a bad key. Run with `env -u ANTHROPIC_API_KEY …`.
- **`electron .` alone fails.** `dist-electron/` is produced by `vite-plugin-electron`
  during `vite`, and Electron only loads ESM from `.mjs`, so both entries emit `.mjs`.
  The desktop entry point is `pnpm --filter @novus/desktop dev`.
- **Writes are denied by default.** `DenyAllApprovalGate` is the fallback, so a missing
  gate denies rather than allows. `NOVUS_ALLOW_WRITES=1` opts in. `apply_patch` is the
  only tool in the write class.
- **The worker requires a token on every route except `/health`.** It mints one
  per process and prints an invite line carrying it; `NOVUS_TOKEN` pins one
  instead and must be at least 32 characters. Requests also have to come from a
  loopback origin or no origin at all, so a page on the open internet is refused
  before its token is even read.
- **The guest reads from whichever it is pointed at.** With `?relay=` in the URL
  it reads the session from the relay and never contacts the worker, which is
  what lets a teammate be on another machine. Without it, it talks to the worker
  over loopback as before — a host watching their own run should not need a
  relay standing up. Either way `?token=` is required; `?session=<id>` alone
  gets a 401. A relay off this machine must be `wss://`.
- Ports: worker `4319` (`NOVUS_PORT`), desktop Vite `5273`, guest Vite `5274`. All
  loopback-only.
- **Relay publishing is opt-in and outbound.** `pnpm --filter
  @novus/session-service start` runs the relay and prints the two commands you
  need — it mints a publish token and a watch token and shows the guest URL. Set
  `NOVUS_RELAY_URL` and `NOVUS_RELAY_TOKEN` on the worker and it shares the
  *first* session it opens; a second session stays local and says so, because one
  token authorises one session. Set neither and Novus is the single-machine
  harness it was. Nothing ever dials in to the worker.
- **Do not set `NOVUS_RELAY_SESSION` on the worker.** A session id is a runtime
  UUID, so it cannot be known before the session exists; the publisher attaches
  when one is created instead. The variable on the *relay* side names its own
  key and is unrelated.
- Other env: `NOVUS_REPO`, `NOVUS_SESSION`, `NOVUS_TOKEN`, `NOVUS_GUEST_PORT`,
  `NOVUS_DB`, `NOVUS_REDACT_PATTERNS`, `NOVUS_RELAY_URL`, `NOVUS_RELAY_TOKEN`,
  `NOVUS_HOST_NAME`. Relay side: `NOVUS_RELAY_PORT`, `NOVUS_RELAY_HOST`,
  `NOVUS_RELAY_SESSION`, `NOVUS_RELAY_PUBLISH_TOKEN`, `NOVUS_RELAY_WATCH_TOKEN`.
- Ports: relay `4400` (`NOVUS_RELAY_PORT`).

## Sessions come back

Opening a session appends `session.created`, which is what makes it findable
later — the Open screen lists what the log remembers and clicking one resumes
its id, so the old timeline reappears rather than starting an empty stream
beside it. Permissions are deliberately not restored: a session recorded with
writes allowed does not silently regain them, so a resumed session takes the
host's current defaults and the checkboxes still decide.

## Invariants

- Every tool call and result crosses the boundary as a schema in `packages/contracts`.
  That file is the bottleneck — changing it touches worker and renderer together.
- Tool failures return to the model as `tool_result` with `is_error: true`. A failing
  tool must never end a run.
- Repository access is confined to the selected repo: no absolute paths, no `..`
  escapes, no symlink escapes, and `.git` / `.env` are refused.
- Never print, inspect, or commit provider secrets.

## Where the rest of it is written down

Nothing below is loaded automatically. Go read it when the task calls for it.

- `README.md` — the product thesis, the multiplayer model, the roadmap. Read
  before arguing about what Novus is for.
- `V1_README.md` — the V1 scope contract, including what is *explicitly
  excluded*, the security boundary, and the build order. Read before proposing
  work that widens scope.
- `FLEET.md` — how several agents run on this repo at once: worktree per slice,
  the lock on `packages/contracts`, and which slices can run beside each other.
  Read before starting parallel work.

## Process

Each of these is a procedure with decisions in it, not a topic. All are symlinked
into `.claude/skills/` so both harnesses load the same file.

- `novus-build-harness` — how a capability gets built: one vertical slice,
  contract → model schema → runner → tool/policy → event → test.
- `novus-run-app` — launching the app or the worker, and proving it came up.
- `novus-merge-slice` — landing a finished parallel slice back into main.
- `novus-finish-run` — commit and push.
- `novus-agent-quality` — stress-testing the loop for livelocks and for
  confidently wrong conclusions, and what to re-test when it changes.
- `novus-extend-event-contract` — adding a `SessionEvent` type or a new run
  status without leaving the projection, receipt, compare screen, or guest
  timeline silently out of sync; only one of those places is compiler-enforced.
- `novus-ui` — the desktop UI's visual language: planes, alpha borders, radii,
  type, motion, and interaction states, and how to change styling without
  breaking it.
