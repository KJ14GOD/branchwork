# Progress

How far Novus V1 actually is: what is met, what is partial, what is not
started, and the evidence for each claim. [V1_README.md](./V1_README.md)
defines the scope and carries the narrative; this file is the index you read
in two minutes. If the two disagree, one of them is wrong — fix the wrong one
in the same commit you notice it.

Updated 2026-07-31, audited against commit `6b91b04`.

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
| 4 — Fork and compare | **Met**, deterministic only (2026-07-31) | `fork-run.test.ts` (13 tests, incl. a rendezvous barrier that fails loudly if attempts secretly serialise), `apply-decision.test.ts`, `decision-route.test.ts`, `compare.test.ts`. Gaps 1–2 are now mostly closed — worktrees are reclaimed when a decision resolves them, and an attempt the worker died inside is failed at the next open — with the residue recorded on each |
| 5 — Hardening | **Partial** | Reconnect, crash recovery, redaction, authorization, replay, multi-client: met (`reconnect.test.ts`, `replay.test.ts`, `session-registry.test.ts`, `redaction.test.ts`, `access.test.ts`). Packaging: **met, unsigned** (2026-07-31) — builder config and entitlements exist, `pnpm --filter @novus/desktop dist` produces a launch-verified DMG. Exit condition (repeatable demo on a genuinely clean machine) still not attempted, and the build is unsigned so Gatekeeper warns |

## Steering brief slices

Against the sequence in [STEERING.md](./STEERING.md). Separate from the
milestones above: those track V1's build order, these track the product
direction laid on top of it.

| Slice | Status | Evidence |
| --- | --- | --- |
| 1 — Approach surface | **Met** (2026-07-31) | Baseline derived in `apps/worker/src/compare.ts` from `fork.created.parentRunId` and rendered as "Current work"; human status language; single-prompt fork form with derived label. `compare.test.ts`, `compare-view.render.test.tsx` |
| 2 — First Decision Room | **Met** (2026-07-31) | Three decision kinds (`adopt` / `revision` / `exploration`), required rationale, interventions as evidence above the agent's summary, summary last and labelled "Unverified claim" when nothing was tested. Requesting a revision cuts a new approach from the same checkpoint carrying the feedback, so the revision and what it revises can be compared. Exportable Markdown receipt at `GET /sessions/:id/receipt`. `compare.test.ts`, `replay.test.ts`, `decision-route.test.ts`, `receipt-export.test.ts`, `compare-view.render.test.tsx` |
| 3 — Multiplayer authority | **Met**, deterministic only (2026-07-31) | `control-lifecycle.test.ts` (18 tests): offer/accept/decline/withdraw, superseded offers, disconnect vs departure, cross-session refusal, direction queued vs recorded. UI in `control-panel.tsx`, `control-panel.render.test.tsx` |
| 4 — Reliability before pilot | **Met**, unsigned (2026-07-31) | Worktree reclamation, interrupted-run reconciliation, dev-server reaping, receipt checks, visible cost. Spend now survives a pause: `run.paused` carries a usage snapshot and `execute()` seeds from it (`pause-resume.test.ts`). Packaged and launch-verified — bundled worker under Electron's own Node, database in userData. **Open:** the DMG is unsigned; that needs an Apple Developer certificate |
| 5 — Mission Inbox | **Met** (2026-07-31) | Attention grouping derived in `session-registry.ts:attentionFor`, ordered by urgency not recency; goal leads the row. `mission-inbox.test.ts` |
| 6 — Team pilot surface | **Partial** (2026-07-31) | Exportable receipt: done (`receipt-export.ts`). Installable build: done but unsigned. Durable shared sessions, role-aware invitations, and the usage/cost view came from earlier slices. **Not started, and not partially started:** GitHub connection, PR status and required checks, team grouping, and update delivery. Those are a new external integration, not a refinement of what is here |

### Steering brief: presentation

| Item | Status | Evidence |
| --- | --- | --- |
| Mission Room — decision spine | **Met** (2026-07-31) | `mission-phase.ts` derives Brief → Execution → Approaches → Decision → Receipt from the log and the comparison; `decision-spine.tsx` draws it. `mission-phase.test.ts` |
| Mission Room — evidence inspector | **Met** (2026-07-31) | Verification above changed files, contested files beside it, absent when there is nothing to say. `file-changes-panel.tsx`, `timeline-summary.test.tsx` |
| Mission Room — active canvas | **Met** (2026-07-31) | The centre column switches between timeline, approaches and browse, and the branching picture is drawn above the approach cards: one shared checkpoint, the branches, and the decision they converge into. `branch-diagram.tsx`, `compare-view.render.test.tsx` |
| Activity as milestones | **Met** (2026-07-31) | Collapsed groups read "Read 2 files · Ran the tests" rather than `read_file ×2`; machinery and the call total sit under Technical details. `timeline-summary.test.tsx` |
| Vocabulary | **Met** (2026-07-31) | Attempt → Approach and Session → Mission in customer-facing text; event types and URL parameters deliberately keep the contract's spelling |
| Guest parity | **Met** (2026-07-31) | Shared tokens in `packages/ui/src/tokens.css`, imported by both apps; guest literals snapped onto the scale; labels capitalised; header leads with the goal |

## Capabilities

### Harness core

| Capability | Status | Evidence |
| --- | --- | --- |
| Typed tool loop, budget-bounded (tokens, wall clock, cost, identical-read livelock check) | Met | `apps/worker/src/agent-runner.ts`, `agent-runner.test.ts`, `budget.test.ts` |
| Tool failure returns as `is_error`, never ends a run | Met | `model-response.test.ts` (malformed calls, truncation), `tools.test.ts` |
| Context assembly | Partial | Goal + prior turns + tool exchanges with elision budgets (`context-size.test.ts`). No repository-derived context: the model discovers the repo through its own tools |
| Run receipts | Partial | `receipt.test.ts` (16 tests). Now records every check — tests, build, typecheck, lint — and carries `verification`, so a run that finished having checked nothing reads as `unverified` rather than as a pass (gap 12). A resumed *run's* budget clock still restarts (gap 4); `rates` are computed but stripped from the emitted receipt (gap 6) |

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
| Fork worktree teardown | **Mostly met** (2026-07-31) | `reclaimResolvedForks` sweeps at session open when an applied decision resolves an attempt; `collectableForks` is the policy, `assertUnderForkRoot` the deletion boundary. `fork-run.test.ts` test 11, `worktree-manager.test.ts` (policy, crafted paths, unowned forks). Undecided sessions still accumulate (gap 1) |

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

1. **Fork worktrees are torn down when a decision resolves them — and only
   then.** *Mostly closed (2026-07-31.)* `SessionRegistry.reclaimResolvedForks`
   sweeps at session open, using `collectableForks`: an attempt is collectable
   when an applied `decision.recorded` follows it in the log and its run is
   not paused or running. `pruneRecords` clears Git registrations whose
   directories are already gone. `fork-run.test.ts` test 11 drives it through
   the real routes; `worktree-manager.test.ts` covers the policy and the
   deletion boundary (crafted paths, and a fork the manager does not own).
   **Still open:** a session nobody ever decides in accumulates attempts
   forever — the sweep has no trigger other than an applied decision, and
   there is still no session-close path to hang one on (see gap 3). Deleting
   an undecided attempt would destroy the only copy of its work, so the
   conservative behaviour is deliberate, not an oversight.
2. **An attempt interrupted by a worker exit is failed at the next session
   open.** *Mostly closed (2026-07-31.)*
   `SessionRegistry.reconcileInterruptedRuns` reads the projection at open and
   appends `run.failed` for any run still `running`, with a reason naming the
   interruption. Paused runs are untouched. `fork-run.test.ts` test 10 asserts
   both directions in one log. **Still open:** liveness is only knowable
   in-process. Two workers sharing one `NOVUS_DB` and one session id would let
   one end a run the other is driving — guarded against for a session this
   process already has open, and not otherwise. Proving it across processes
   needs a heartbeat. Also: reconciliation runs at session *open*, so a
   session nobody reopens keeps its stale `running` in the log.
3. **Dev servers are reaped on every worker exit path, and before a worktree
   is deleted — but there is still no session close.** *Partially closed
   (2026-07-31.)* `process.on("exit")` now runs `killRunningCommands` and
   `stopAllDevServers`, so an uncaught exception or a bare `process.exit` no
   longer leaves detached servers holding ports; previously only SIGINT and
   SIGTERM did. `stopDevServersUnder` takes down servers inside an attempt's
   worktree before reclamation deletes it. **Still open:** there is no
   session-close path at all (no `DELETE /sessions/:id`, no registry
   `close()`), so a server a *session* started still holds its port until the
   worker exits.
4. **A single run's budget clock restarts on resume; a session's spend no
   longer does.** *Partially closed (2026-07-31.)* `projectSession` folds
   `receipt.created` into a session total, served by `GET /sessions/:id/usage`
   and shown in the rail, so a resumed session reports what it has actually
   spent instead of zero (`fork-run.test.ts` test 13 asserts this across a
   real restart). **Still open, and this is the honest limit:** the per-*run*
   budget that actually stops a runaway is still in-memory and still restarts
   at zero on resume. No receipt is written at pause and per-call usage never
   enters the log, so a paused-and-resumed run has nothing to rebuild its
   counter from and can spend up to the full ceiling again per resume. Closing
   it needs usage in the log at pause — an event-payload change, so read
   `novus-extend-event-contract` first.
5. **`claude-sonnet-5` is priced at its sticker rate** ($3/$15 per MTok)
   while an introductory rate ($2/$10) runs through 2026-08-31, so the fast
   tier's cost reads roughly 1.5x high until then. Deliberate — the default
   errs toward overstating and outlives the promotion; set
   `NOVUS_MODEL_PRICING` to reflect the intro rate meanwhile. Reasoning in
   `pricing.ts` beside the table.
6. **Cost is on screen per run and per session.** *Mostly closed
   (2026-07-31.)* The receipt row renders spend (`summariseReceipt` /
   `formatSpend` in `packages/ui`, covered by `receipt-summary.test.ts`), and
   the rail meter shows the session total from `GET /sessions/:id/usage`.
   Null renders as "Cost not counted", never `$0.00` — a run reported as free
   because nobody priced its model is a worse answer than one that admits it
   does not know. **Still open:** the receipt still strips the `rates` that
   would let a reader re-derive the figure (`ReceiptUsage` carries them,
   `RunReceiptSchema.usage` does not); `modelTimeMs` is carried and rendered
   nowhere; per-attempt spend is served by the route and named there, but the
   compare screen does not yet draw it (that file belongs to another slice).
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
12. **Receipts record every check, and separate finishing from being
    verified.** *Closed (2026-07-31.)* `RunReceiptSchema` gained `checks`
    (tests, build, typecheck, lint, with the structured problem count where a
    checker reports one) and `verification` — `verified` / `failing` /
    `unverified`. A run that checked nothing is `unverified` however cleanly
    it finished; checks that ran before the final change are `unverified`
    too, because a suite that passed against a tree that no longer exists
    cannot vouch for this diff; a failing check outranks a missing one.
    `receipt.test.ts` covers each branch, including a checker that fails with
    output the parser did not recognise, which must not read as clean.
    **Still open:** the *projection* half of the original claim —
    `RunProjection.tests` and therefore `AttemptComparison.green` still see
    `run_tests` only, so the compare screen's per-attempt verdict does not yet
    reflect a build or a typecheck. `compare.ts` belongs to another slice.
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
16. **Packaging exists; signing does not.** *Mostly closed (2026-07-31.)*
    `electron-builder` config, entitlements, and a hardened-runtime setup are
    in `apps/desktop/package.json` and `apps/desktop/build/`. `pnpm --filter
    @novus/desktop dist` produces a DMG; the built app was launched and
    verified to start its bundled worker, answer `/health`, and write its
    database to userData rather than inside its own bundle. **Still open:**
    the build is unsigned and un-notarized, so Gatekeeper warns on another
    machine — that needs an Apple Developer certificate. Milestone 5's "clean
    machine" exit is reachable but has not been run on a genuinely clean
    machine.
17. **One flaky test under heavy machine contention.** *Open (2026-07-31.)*
    `control-lifecycle.test.ts`, "what /authority sends validates against the
    contract", failed twice in three full-suite runs while a second agent's
    test suite was saturating the CPU: `pendingDirection` came back empty when
    the direction had just been posted against a run `startRun` had already
    confirmed was executing. It has not reproduced in nine runs since that load
    went away, and 12 isolated runs of the test alone are clean — so the cause
    is not established and the test is instrumented rather than fixed. Its
    assertion message now prints the `pendingDirection` and `executingRunIds`
    it actually saw, so the next occurrence says what happened instead of only
    `undefined`. **Do not treat a green suite as evidence this is gone.** It is
    a test-level flake with no matching product symptom found so far; if it
    turns out `direction.submitted` can be read back missing right after its
    POST returns, that is a real bug and this entry is wrong about its scope.
    **Narrowed (2026-07-31.)** The test discarded the status of three POSTs, so
    a request that was *refused* was indistinguishable from a projection that
    came back empty — which is exactly the symptom seen. Those statuses are
    asserted now and carry the response body in the failure message. That does
    not prove the cause; it means the next occurrence names it instead of
    reporting `undefined`. Still not reproducible: roughly 25 attempts,
    including eight runs against six concurrent full suites.
