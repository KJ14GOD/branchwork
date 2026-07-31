# Progress

How far Novus V1 actually is: what is met, what is partial, what is not
started, and the evidence for each claim. [V1_README.md](./V1_README.md)
defines the scope and carries the narrative; this file is the index you read
in two minutes. If the two disagree, one of them is wrong — fix the wrong one
in the same commit you notice it.

Updated 2026-07-30, audited against commit `3dbb664`.

## The rules this file follows

Written down because this project has already shipped two false status
claims, and both had the same shape: the box was ticked, the evidence tested
something adjacent, and nobody could tell from the document.

- V1_README ticked "Isolated child runs" while `POST /sessions/:id/fork` cut
  a worktree, recorded an event, and executed nothing. The isolation tests
  were green the whole time — they exercised the worktree manager directly,
  not the product.
- The same document promised each fork "its own process namespace" —
  vacuously true while forks ran nothing, plainly false the day they ran.

So:

1. **Met** means the behaviour works through the product path — the route,
   the UI, the run loop — not that a subsystem it depends on passes its own
   tests. Evidence must enter through the same door the product uses.
2. Every Met or Partial row names evidence a reader can check in under a
   minute: a test file, a route, or a `file:symbol`. Run any worker test
   file with `node --experimental-strip-types --test src/<name>.test.ts`
   from `apps/worker`, or the whole suite with
   `pnpm --filter @novus/worker test`. A claim without evidence is **Not
   started**, whatever the code looks like.
3. Deterministic proof and live proof are different things and this file
   says which one a row has. "Tested" in this repo almost always means
   "against a scripted model adapter" — see the standing caveat below.
4. The row changes in the same commit that changes the truth. A capability
   landing without its row is documentation drift of exactly the kind this
   file exists to end.

## Standing caveat: live-model exposure

**Nothing that landed after 2026-07-29 has ever been exercised by a live
model call.** The last live provider calls were the three benchmark runs on
2026-07-29 (one pass each: bug fix, small feature, repository reasoning —
see *Benchmark results* in V1_README). Every agent since has deliberately
avoided provider spend after a roughly $40 overnight stress session, so all
of the following are deterministically tested against scripted adapters and
genuinely unproven live:

- the six newest tools (`propose_new_file`, `propose_deletion`, `run_build`,
  `run_diagnostics`, `dev_server`, `git_branches`)
- fork/attempt execution, the compare flow, and decision apply
- the model router, run pricing, and the per-turn model override
- direction, cancel, pause, resume, and handoff folding into a live run
- the model's-own-words-preserved path (text alongside a tool call)

The OpenAI adapter has sent exactly one request that OpenAI's API validated
(no usable key was available); it has never completed a live round-trip.
`apps/worker/src/openai-smoke.ts` exists to run by hand the moment a key is.

Deterministic coverage here is real and adversarial — but it proves the
harness carries a fix, not that a model finds one, and no count of green
gates substitutes for a live run.

## Milestones

Statuses against the exit conditions in V1_README's build order.

| Milestone | Status | Evidence |
| --- | --- | --- |
| 1 — Foundation | **Met** | `apps/worker/src/reconnect.test.ts` drives one store to host and guest over a real SSE socket; SQLite store at `.novus/events.db`, replayed by `replay.test.ts` |
| 2 — Single-agent harness | **Met**, live once per task (2026-07-29) | `benchmarks/{bug-fix,small-feature,repo-reasoning}/` via `./scripts/benchmark.sh`; scorer re-runs suites itself and applies a hidden test. Context assembly is the one Partial inside: goal + prior turns only, no repository context (`buildMessages`, `apps/worker/src/anthropic-model.ts`) |
| 3 — Multiplayer control | **Met**, deterministic only | `pause-resume.test.ts`, `pause-resume-route.test.ts`, `handoff-route.test.ts`, `presence.test.ts`, `cancel-route.test.ts`; the routes table below. Never run against a live model; the shared leg of the evaluation grid is still unrun |
| 4 — Fork and compare | **Met**, deterministic only (2026-07-30) | `fork-run.test.ts` (9 tests, incl. a rendezvous barrier that fails loudly if attempts secretly serialise), `apply-decision.test.ts`, `decision-route.test.ts`, `compare.test.ts`. Gaps 1–2 below are the known liabilities |
| 5 — Hardening | **Partial** | Reconnect, crash recovery, redaction, authorization, replay, multi-client: met (`reconnect.test.ts`, `replay.test.ts`, `session-registry.test.ts`, `redaction.test.ts`, `access.test.ts`). Packaging: **not started** — no builder/notarization/entitlements config exists anywhere. Exit condition (repeatable demo on a clean machine) not attempted |

## Capabilities

### Harness core

| Capability | Status | Evidence |
| --- | --- | --- |
| Typed tool loop, budget-bounded (tokens, wall clock, cost, identical-read livelock check) | Met | `apps/worker/src/agent-runner.ts`, `agent-runner.test.ts`, `budget.test.ts` |
| Tool failure returns as `is_error`, never ends a run | Met | `model-response.test.ts` (malformed calls, truncation), `tools.test.ts` |
| Context assembly | Partial | Goal + prior turns + tool exchanges with elision budgets (`context-size.test.ts`). No repository-derived context: the model discovers the repo through its own tools |
| Run receipts | Partial | `receipt.test.ts`. Counts `run_tests` only (gap 12); a resumed run's usage and budget clock restart (gap 4); `rates` are computed but stripped from the emitted receipt |

### Native tools — sixteen

`read_file`, `search_repository`, `list_directory`, `git_status`, `git_diff`,
`git_branches`, `list_provider_models`, `propose_patch`, `propose_new_file`,
`propose_deletion`, `apply_patch`, `run_command`, `run_tests`, `run_build`,
`run_diagnostics`, `dev_server`.

| Claim | Status | Evidence |
| --- | --- | --- |
| Contract, descriptions, registration, and approval allow-list agree | Met | `tool-coverage.test.ts` pins all four, bidirectionally |
| Path confinement survives absolute paths, `..`, symlinks, `.git`/`.env` | Met | `tools.test.ts` probes each escape rather than reading the resolver |
| Creation and deletion go through propose-then-apply; `apply_patch` stays the only write-class tool | Met | `patch-tools.test.ts`; `buildApprovalGate` in `session-registry.ts` |
| Dev servers outlive a call, are killed with the worker | Met | `dev-server.test.ts` — but see gap 3 for the session-close hole |
| Any of the six newest tools used by a live model | **Not started** | Deterministic tests only; same standing the original nine had before their benchmark run |

### Multiplayer

| Capability | Status | Evidence |
| --- | --- | --- |
| Token-gated HTTP+SSE worker, loopback-only, role capabilities per route | Met | `access.test.ts`, `event-server.test.ts`; routes in `apps/worker/src/event-server.ts` |
| Invite links minting role-scoped tokens | Met | `POST /sessions/:id/invite`; reachable from the desktop UI |
| Live presence distinct from membership | Met | `presence.test.ts` over a real socket |
| Direction folded in at turn boundaries | Met (deterministic) | `POST /sessions/:id/direction`; `agent-runner.test.ts` |
| Cancel / pause / resume / handoff | Met (deterministic) | `cancel-route.test.ts`, `pause-resume-route.test.ts`, `handoff-route.test.ts` |
| Off-machine viewing through the relay | Met | `apps/session-service/src/*.test.ts`, guest `relay-client.test.ts` |
| Requesting control from the guest | **Not started** | The route exists (`POST /sessions/:id/control/request`); no UI calls it (gap 10) |

### Fork and compare

| Capability | Status | Evidence |
| --- | --- | --- |
| A fork genuinely executes: child `AgentRunner` in the fork's worktree, preassigned run id, events in the parent log | Met (deterministic, 2026-07-30) | `startForkRun` / `buildForkRunner` in `session-registry.ts`; `fork-run.test.ts` |
| Two attempts run concurrently without touching each other | Met | `fork-run.test.ts` — rendezvous barrier fails rather than hangs if serialised |
| Fork gate = parent session's live permissions ∩ checkpoint's recorded policy | Met | `fork-run.test.ts` ("inherits the parent session's permissions, not the host defaults") |
| Forks survive worker restart; decision still applies | Met | `WorktreeManager.adopt`; `fork-run.test.ts` |
| Decision recorded and applied, conflicts refuse the whole apply | Met | `decision-route.test.ts`, `apply-decision.test.ts` |
| Compare surfaces (rail, view switcher, screen) | Met | `apps/desktop/src/components/compare-screen.tsx`, `packages/ui/src/compare-view.tsx` |
| Fork worktree teardown | **Not started** | `removeFork` exists with zero production callers (gap 1) |

### Models, routing, and cost

| Capability | Status | Evidence |
| --- | --- | --- |
| Two provider adapters (Anthropic, OpenAI), selected at boot | Met / unproven live for OpenAI | `openai-model.test.ts`; `openai-smoke.ts` awaits a key |
| Signal-based router across three Anthropic tiers (fast `claude-sonnet-5`, deep `claude-opus-5`, max `claude-fable-5`) | Met (deterministic) | `SignalModelRouter` in `model-router.ts`; `model-router.test.ts` (13 tests). Signals: goal shape, context size, failure escalation, cost-budget step-down. Each decision is logged with its reason as `run.progress` |
| Per-turn model override beats the router; unknown model is a 400 before the run starts | Met (deterministic) | `POST /sessions/:id/turns` with `model`; `turn-model-route.test.ts` |
| Per-run cost and model time, cache-aware | Met (deterministic) | `pricing.test.ts` proves the full-price-equivalent identity; `budget.test.ts` enforces the cost ceiling. Unpriced models read as unknown, never zero (`ratesFor` returns null) |
| Cost visible to a person | **Not started** | `costUsd` is computed, budgeted, and rendered nowhere (gap 6) |
| Learned routing (historical success, eval results) | Not started, deliberately | Marked extension points in `model-router.ts`; excluded from V1 scope |

### Desktop app

All hand-tested via CDP against scripted adapters; **zero renderer tests
exist** (gap 8).

| Capability | Status | Evidence |
| --- | --- | --- |
| Multi-session tabs; background tabs stay mounted with live streams | Met (hand-tested) | `apps/desktop/src/app.tsx`, `use-session.ts` (catalog) + `use-session-actions.ts` (per tab) |
| Embedded terminal (node-pty + xterm), repo cwd, human-side only | Met (hand-tested) | `apps/desktop/electron/main.ts`, `src/components/terminal-panel.tsx` |
| Read-only file browser, host-side confinement | Met | `electron/fs-browser.ts` with `fs-browser.test.ts` — the one desktop area with tests |
| Persistent composer with model picker, wired end-to-end to the turns route | Met (hand-tested) | `composer.tsx` → `use-session-actions.ts` → `POST /sessions/:id/turns`; worker side pinned by `turn-model-route.test.ts` |
| Spacing/type design system (`--space-1..8`, `--text-*`, radii, control heights) | Met | `apps/desktop/src/styles.css` token block; `skills/novus-ui/SKILL.md` documents it |
| Light/dark theme | Met (hand-tested) | `styles.css` `[data-theme="light"]` |

### Guest app

| Capability | Status | Evidence |
| --- | --- | --- |
| Live timeline, presence, run stats, reconnect-with-resume | Met | `apps/guest/src/*.test.ts` (endpoint, relay-client, timeline) |
| Reads via relay or worker, token-gated either way | Met | `relay-client.test.ts`; CLAUDE.md's guest facts |
| Desktop's design system | **Not started** | Guest stylesheet shares zero tokens with the desktop's (gap 9) |
| Compare/attempts surface | Not started | The guest renders the timeline only; it never imports `CompareView` |

### Persistence, security, evaluation

| Capability | Status | Evidence |
| --- | --- | --- |
| SQLite event log as source of truth; projections rebuilt from it | Met | `replay.test.ts`, `session-registry.test.ts` (mid-write failure) |
| Sessions resumable across restarts, permissions deliberately not restored | Met | `session-registry.test.ts`; CLAUDE.md "Sessions come back" |
| Secret redaction before events leave the worker | Met | `redaction.test.ts` |
| Benchmarks: three tasks, hidden regression tests, cheat-detection | Met, live once each (2026-07-29) | `benchmarks/*/`, `benchmark.test.ts`; scorer catches a test-neutering agent |
| Evaluation grid (3 tasks × 3 configurations) | 3 of 9 cells | Private leg only. The shared and forked legs are no longer blocked on missing capability — they are blocked on nobody having run them, which is live spend |

## Known gaps

The single register. Each entry says what breaks and where the detail lives.
Numbered so other documents can point at them.

1. **Fork worktrees are never torn down.** `WorktreeManager.removeFork` /
   `removeAll` exist and are called only by tests; nothing removes a
   worktree when an attempt ends or a decision lands, so every fork
   accumulates a full checkout on disk until someone deletes it by hand.
2. **An attempt interrupted by a worker exit stays `running` forever.**
   Every `run.failed` append site requires the in-process promise to
   reject; session restore adopts recorded forks but never scans for a
   `run.started` with no terminator. The compare screen, attempts rail, and
   tab dot all report a dead attempt as live, indefinitely.
3. **Dev servers are reaped on worker shutdown, not session close.** There
   is no session-close path at all (no `DELETE /sessions/:id`, no registry
   `close()`), so a server started by a session holds its port until the
   worker process exits.
4. **A resumed run's token usage and budget clock restart at zero.** Usage
   is never logged per call, so there is nothing to rebuild it from; the
   receipt reports only the segment since the last resume. Disclosed in
   `agent-runner.ts`'s comments, invisible in the timeline.
5. **`claude-sonnet-5` is priced at its sticker rate** ($3/$15 per MTok)
   while an introductory rate ($2/$10) runs through 2026-08-31, so the fast
   tier's cost reads roughly 1.5x high until then. Deliberate — the default
   errs toward overstating and outlives the promotion; set
   `NOVUS_MODEL_PRICING` to reflect the intro rate meanwhile. Reasoning in
   `pricing.ts` beside the table.
6. **Cost is computed and shown to nobody.** `costUsd` and `modelTimeMs`
   accumulate per run, bound the budget, ride the receipt — and no desktop,
   guest, or shared-UI component renders either. The receipt also strips
   the `rates` that would let a reader judge the figure. A stale comment in
   `contracts.ts` still claims cost is "deliberately absent" two lines
   above the field that carries it.
7. **Nothing after 2026-07-29 has seen a live model call.** The standing
   caveat above; the single largest unknown in the project.
8. **The renderer has no tests.** Zero test files under `apps/desktop/src`
   and none covering React anywhere; the desktop test glob only reaches
   `electron/*.test.ts`. This is how the token-less Open-screen fetch
   shipped broken. `packages/contracts` also has **no test script at all**
   — `pnpm -r --if-present test` silently skips the one package everything
   trusts.
9. **The guest has none of the desktop's design system.** 747 lines of
   hand-picked literals, dark-only, zero shared tokens — and its header
   comment still claims "same tokens, same spacing" as the desktop, which
   stopped being true when the desktop moved to scales.
10. **Requesting control has no UI trigger.** The route exists and renders
    in the timeline; no button calls it. The natural caller (the guest) is
    structurally read-only.
11. **Handoff is atomic, not a two-step accept** — the protocol section in
    V1_README describes recipient acceptance; what is built transfers
    ownership on the owner's click.
12. **Receipts and projections count `run_tests` only.** A run that
    verifies through `run_build` or `run_diagnostics` produces a receipt
    with `tests: []` and prints "tests not run".
13. **Stale in-code doc claims** (owners notified rather than fixed here,
    since those files belong to active slices): `use-turn-model.ts`'s seam
    comment says the turns route "does not exist yet" — it exists and is
    tested; the guest stylesheet header (gap 9); the `contracts.ts` cost
    comment (gap 6).
14. **`search_repository` silently skips files over ripgrep's 1M cap**, and
    the event log stores oversized tool results whole — the model boundary
    elides them, renderers and the relay still carry the full payload.
15. **StrictMode hydration still issues N+1 resume POSTs** per dev-mode
    launch (harmless duplicate `session.created` rows; the timeline hides
    them since `3dbb664`, the log keeps them).
16. **No packaging.** No signed build, no notarization, no entitlements —
    Milestone 5's "clean machine" exit is unreachable until this exists.
