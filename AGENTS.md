# Novus

A multiplayer coding harness for humans and AI agents. pnpm workspace: `apps/worker`
(agent loop, tools, event server), `apps/desktop` (React + Electron), `packages/contracts`
(the Zod boundary both sides share).

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
- Ports: worker `4319` (`NOVUS_PORT`), Vite `5273`. Both loopback-only.
- Other env: `NOVUS_REPO`, `NOVUS_SESSION`.

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

## Process

Each of these is a procedure with decisions in it, not a topic. All are symlinked
into `.claude/skills/` so both harnesses load the same file.

- `novus-build-harness` — how a capability gets built: one vertical slice,
  contract → model schema → runner → tool/policy → event → test.
- `novus-run-app` — launching the app or the worker, and proving it came up.
- `novus-merge-slice` — landing a finished parallel slice back into main.
- `novus-finish-run` — commit and push.
