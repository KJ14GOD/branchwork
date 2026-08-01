# Progress

How far Novus V1 actually is: what is met, what is partial, what is not
started, and the evidence for each claim. [V1_README.md](./V1_README.md)
defines the scope and carries the narrative; this file is the index you read
in two minutes. If the two disagree, one of them is wrong — fix the wrong one
in the same commit you notice it.

Updated 2026-08-01, audited against commit `a83dff9`.

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
- everything this batch added (2026-08-01): the offer/accept control
  lifecycle, the joined window's authority surface, the baseline as a
  decision target, and route-level rationale enforcement

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
| 3 — Multiplayer control | **Met**, deterministic only, same machine only | `pause-resume.test.ts`, `pause-resume-route.test.ts`, `handoff-route.test.ts`, `control-lifecycle.test.ts`, `presence.test.ts`, `cancel-route.test.ts`; the routes table below. Never run against a live model; the shared leg of the evaluation grid is still unrun. The exit condition names a *remote* teammate: what is proven is same-machine joining over real processes, since a relay join is watch-only and no `wss://` relay has been stood up (gap 10) |
| 4 — Fork and compare | **Met**, deterministic only (2026-08-01) | `fork-run.test.ts` (14 tests, incl. a rendezvous barrier that fails loudly if attempts secretly serialise), `apply-decision.test.ts`, `decision-route.test.ts` (13 tests), `compare.test.ts`. Gaps 1–2 are now mostly closed — worktrees are reclaimed when a decision resolves them, and an attempt the worker died inside is failed at the next open — with the residue recorded on each |
| 5 — Hardening | **Partial** | Reconnect, crash recovery, redaction, authorization, replay, multi-client: met (`reconnect.test.ts`, `replay.test.ts`, `session-registry.test.ts`, `redaction.test.ts`, `access.test.ts`). Packaging: **partial, unsigned** (2026-07-31) — `apps/desktop/package.json`'s `build` block configures `electron-builder` and `scripts/build-worker.mjs` bundles the worker, and a DMG was produced and launch-verified on the machine that built it; but the `build/entitlements.mac.plist` that block points at is not in the repository and `.gitignore`'s `build/` rule excludes it, so a fresh clone cannot reproduce that build (gap 16). Exit condition (repeatable demo on a genuinely clean machine) not attempted |

## Steering brief slices

Against the sequence in [STEERING.md](./STEERING.md). Separate from the
milestones above: those track V1's build order, these track the product
direction laid on top of it.

| Slice | Status | Evidence |
| --- | --- | --- |
| 1 — Approach surface | **Met** (2026-07-31) | Baseline derived in `apps/worker/src/compare.ts` from `fork.created.parentRunId` and rendered as "Current work"; human status language; single-prompt fork form with derived label. `compare.test.ts`, `compare-view.render.test.tsx` |
| 2 — First Decision Room | **Met** (2026-08-01) | Three decision kinds (`adopt` / `revision` / `exploration`), interventions as evidence above the agent's summary, summary last and labelled "Unverified claim" when nothing was tested. Requesting a revision cuts a new approach from the same checkpoint carrying the feedback. Exportable Markdown receipt at `GET /sessions/:id/receipt`. **Since 2026-08-01** the baseline is a decision target: keeping the current work records a real `decision.recorded` with its rationale, applies nothing, and is reported as *not needed* rather than as applied or blocked. Rationale is enforced at the route rather than only in React. `compare.test.ts`, `replay.test.ts`, `decision-route.test.ts`, `decision-authority.test.ts`, `receipt-export.test.ts`, `compare-view.render.test.tsx` |
| 3 — Multiplayer authority | **Met**, deterministic only (2026-08-01) | `control-lifecycle.test.ts` (18 tests): offer/accept/decline/withdraw, superseded offers, disconnect vs departure, cross-session refusal, direction queued vs recorded. UI in `control-panel.tsx`, `control-panel.render.test.tsx`. The *joined* window now uses the same protocol rather than only the hosting one: authority state, requesting control, and answering a handoff, in `join/joined-surface.tsx` and `join/joined-api.ts` — `joined-surface.render.test.tsx` (16 tests) for who may see which control, `joined-api.test.ts` (11 tests) for what those calls do against a real event server. A relay join stays watch-only and says so |
| 4 — Reliability before pilot | **Partial** (2026-07-31) | Worktree reclamation, interrupted-run reconciliation, dev-server reaping, receipt checks, visible cost: met. Spend survives a pause — `run.paused.usage` carries a snapshot and `AgentRunner`'s `execute()` seeds tokens, calls, cost and model time from it (`pause-resume.test.ts`, "a resumed run continues its spend rather than restarting it"). Packaged and launch-verified on the build machine — bundled worker under Electron's own Node, database in userData. **Open:** the DMG is unsigned (needs an Apple Developer certificate), the entitlements file the builder config names is not committed (gap 16), and the run's *wall-clock* budget still restarts on resume (gap 4) |
| 5 — Mission Inbox | **Met** (2026-08-01) | Attention grouping derived in `session-registry.ts:attentionFor`, ordered by urgency not recency; goal leads the row. Now its own surface (`mission-inbox.tsx`) rather than a list appended under the open-a-repository form — the window's first screen, and an overlay from the titlebar's Missions once tabs exist; opening a repository is a separate bounded modal. `mission-inbox.test.ts` (worker), `mission-inbox.test.tsx` (renderer: grouping, no empty headings, resume keeps the id, permissions come from the host's current defaults) |
| 6 — Team pilot surface | **Partial** (2026-07-31) | Exportable receipt (`receipt-export.ts`, `GET /sessions/:id/receipt`), installable build (unsigned, and not reproducible from a clone — gap 16), and GitHub connection with PR status and required checks (`github.ts`, `github.test.ts` — eleven tests, one against the real `gh`) all done. Durable shared sessions, role-aware invitations and the usage/cost view came from earlier slices. **Not started:** team grouping and update delivery. **Blocked on a credential, not on code:** code signing needs an Apple Developer ID certificate. **Not blocked on a credential:** committing the entitlements file |

### Steering brief: presentation

| Item | Status | Evidence |
| --- | --- | --- |
| Mission Room — decision spine | **Met** (2026-07-31) | `mission-phase.ts` derives Brief → Execution → Approaches → Decision → Receipt from the log and the comparison; `decision-spine.tsx` draws it. `mission-phase.test.ts` |
| Mission Room — evidence inspector | **Met** (2026-07-31) | Verification above changed files, contested files beside it, absent when there is nothing to say. `file-changes-panel.tsx`, `timeline-summary.test.tsx` |
| Mission Room — active canvas | **Met** (2026-08-01) | The centre column switches between timeline, approaches and browse, and the branching picture is drawn above the approach cards: one shared checkpoint, the branches, and the decision they converge into. Which surfaces each view shows, and when the Decision Room opens itself, are pure functions the screen renders from rather than inline effects: `decision-room.ts`, `decision-room.test.ts` (once per arrival, browse never interrupted, a later decision re-opens, composer and evidence inspector stay). `branch-diagram.tsx`, `compare-view.render.test.tsx` |
| Activity as milestones | **Met** (2026-07-31) | Collapsed groups read "Read 2 files · Ran the tests" rather than `read_file ×2`; machinery and the call total sit under Technical details. `timeline-summary.test.tsx` |
| Vocabulary | **Met** (2026-07-31) | Attempt → Approach and Session → Mission in customer-facing text; event types and URL parameters deliberately keep the contract's spelling |
| Guest parity | **Partial** (2026-07-31) | Shared tokens in `packages/ui/src/tokens.css`, imported by both apps (`apps/guest/src/styles.css:13`); guest literals snapped onto the scale; labels capitalised; header leads with the goal. **Open:** the guest never stamps `data-theme`, so it is dark-only against the desktop's two themes (gap 9) |

## Capabilities

### Harness core

| Capability | Status | Evidence |
| --- | --- | --- |
| Typed tool loop, budget-bounded (tokens, wall clock, cost, identical-read livelock check) | Met | `apps/worker/src/agent-runner.ts`, `agent-runner.test.ts`, `budget.test.ts` |
| Tool failure returns as `is_error`, never ends a run | Met | `model-response.test.ts` (malformed calls, truncation), `tools.test.ts` |
| Context assembly | Partial | Goal + prior turns + tool exchanges with elision budgets (`context-size.test.ts`). No repository-derived context: the model discovers the repo through its own tools |
| Run receipts | Partial | `receipt.test.ts` (16 tests). Now records every check — tests, build, typecheck, lint — and carries `verification`, so a run that finished having checked nothing reads as `unverified` rather than as a pass (gap 12). A resumed run's *token and cost* counters now carry across the pause; its *wall-clock* budget still restarts (gap 4). `rates` are computed in `receipt.ts:ReceiptUsage` but absent from `RunUsageSchema`, so they are stripped from the emitted receipt (gap 6) |

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
| Handoff is offer → accept, not a one-click transfer | Met (deterministic, 2026-08-01) | `POST /sessions/:id/handoff` offers; `POST /sessions/:id/handoff/(accept\|decline\|withdraw)` answers it. Events `control.offered` / `control.accepted` / `control.declined` / `control.withdrawn` / `control.transferred` in `packages/contracts`. `control-lifecycle.test.ts` (18 tests) covers superseded offers, an offer only its named recipient may answer, a viewer accepting (authority is the offer, not the rank), and acceptance during a live run waiting for the boundary before control moves |
| Off-machine viewing through the relay | Met, watch-only | `apps/session-service/src/*.test.ts`, `packages/session-client/src/relay-client.test.ts`. Watch-only in both directions: the transport carries the log outbound and nothing back, and nobody has stood up a `wss://` relay, so cross-machine multiplayer is **not** proven (gap 10) |
| Requesting control from a joined window | Met (deterministic) | `join/joined-surface.render.test.tsx` (16 tests), `join/joined-api.test.ts` (11 tests). The hosting window has the same trigger in `components/control-panel.tsx`. **Still not the browser guest**, which is structurally read-only (gap 10) |

### Fork and compare

| Capability | Status | Evidence |
| --- | --- | --- |
| A fork genuinely executes: child `AgentRunner` in the fork's worktree, preassigned run id, events in the parent log | Met (deterministic, 2026-07-30) | `startForkRun` / `buildForkRunner` in `session-registry.ts`; `fork-run.test.ts` |
| Two attempts run concurrently without touching each other | Met | `fork-run.test.ts` — rendezvous barrier fails rather than hangs if serialised |
| Fork gate = parent session's live permissions ∩ checkpoint's recorded policy | Met | `fork-run.test.ts` ("inherits the parent session's permissions, not the host defaults") |
| Forks survive worker restart; decision still applies | Met | `WorktreeManager.adopt`; `fork-run.test.ts` |
| Decision recorded and applied, conflicts refuse the whole apply | Met | `decision-route.test.ts`, `apply-decision.test.ts` |
| Compare surfaces (rail, view switcher, screen) | Met | `apps/desktop/src/components/compare-screen.tsx`, `packages/ui/src/compare-view.tsx` |
| Fork worktree teardown | **Mostly met** (2026-07-31) | `SessionRegistry.reclaimResolvedForks` sweeps at session open when an applied decision resolves an attempt; `worktree-manager.ts:collectableForks` is the policy, `assertUnderForkRoot` the deletion boundary. `fork-run.test.ts` "attempts a decision resolved are reclaimed at the next open; undecided and paused ones are not", `worktree-manager.test.ts` (policy, crafted paths, unowned forks). Undecided sessions still accumulate (gap 1) |
| The baseline is a decision target, not an absence of one | Met (deterministic, 2026-08-01) | Keeping the current work records a real `decision.recorded` with its rationale, writes no files, and is reported as *not needed* rather than applied or blocked. `decision-route.test.ts` — "the baseline can be selected", "selecting the baseline writes no files, and is not reported as a failed application", "rejected alternatives stay in the event history after the baseline is chosen". A rationale under 12 characters is refused by the route, not only by React (`event-server.ts`, and the last two tests in `decision-route.test.ts`) |

### Models, routing, and cost

| Capability | Status | Evidence |
| --- | --- | --- |
| Two provider adapters (Anthropic, OpenAI), selected at boot | Met / unproven live for OpenAI | `openai-model.test.ts`; `openai-smoke.ts` awaits a key |
| Signal-based router across three Anthropic tiers (fast `claude-sonnet-5`, deep `claude-opus-5`, max `claude-fable-5`) | Met (deterministic) | `SignalModelRouter` in `model-router.ts`; `model-router.test.ts` (13 tests). Signals: goal shape, context size, failure escalation, cost-budget step-down. Each decision is logged with its reason as `run.progress` |
| Per-turn model override beats the router; unknown model is a 400 before the run starts | Met (deterministic) | `POST /sessions/:id/turns` with `model`; `turn-model-route.test.ts` |
| Per-run cost and model time, cache-aware | Met (deterministic) | `pricing.test.ts` proves the full-price-equivalent identity; `budget.test.ts` enforces the cost ceiling. Unpriced models read as unknown, never zero (`ratesFor` returns null) |
| Cost visible to a person | **Mostly met** | The receipt row renders spend and the rail meter shows the session total from `GET /sessions/:id/usage`; null reads as "Cost not counted", never `$0.00`. `packages/ui/src/receipt-summary.ts` with `receipt-summary.test.ts` (7 tests). **Open:** `rates` and `modelTimeMs` reach no screen, and the compare screen does not draw per-attempt spend (gap 6). This row said "Not started" while gap 6 said "mostly closed"; the gap was right |
| Learned routing (historical success, eval results) | Not started, deliberately | Marked extension points in `model-router.ts`; excluded from V1 scope |

### Desktop app

The renderer is no longer untested. `scripts/tsx-hook.ts` registers an esbuild
transform so `node --test` can load `.tsx` at all, and `apps/desktop`'s test
script globs `src/**/*.test.ts(x)` alongside `electron/*.test.ts`: 104 tests
across ten files under `src/`, 37 more across three under `electron/`. What is
covered is components rendered to static markup and pure decision modules; what
is not covered is every `use-*.ts` hook, `app.tsx` itself, and the whole of
`apps/guest/src` — the narrowed version of gap 8.

Rows below marked *hand-tested* were driven via CDP against scripted adapters,
not by any test. Visual verification was done at 1280×800 and 1440×900 and at
no other size: this display clamps to 1470 logical points, so nothing wider has
ever been looked at, and no document should say otherwise. (Page zoom does not
substitute — it scales the layout uniformly rather than granting more CSS
pixels, so the three-column grid at 1728 remains unlooked-at.)

| Capability | Status | Evidence |
| --- | --- | --- |
| Multi-session tabs; background tabs stay mounted with live streams | Met (hand-tested) | `apps/desktop/src/app.tsx`, `use-session.ts` (catalog) + `use-session-actions.ts` (per tab). None of the three has a test |
| Embedded terminal (node-pty + xterm), repo cwd, human-side only | Met (hand-tested) | `apps/desktop/electron/main.ts`, `src/components/terminal-panel.tsx` |
| Read-only file browser, host-side confinement | Met | `electron/fs-browser.ts` with `fs-browser.test.ts` (11 tests: absolute paths, `..`, symlinks, `.git`/`.env`, binary, oversize) |
| Hosting-vs-joining launch, and the renderer's own asset boundary | Met | `electron/launch.test.ts` (10 tests), `electron/renderer-host.test.ts` (16 tests: `resolveAsset` climbs, loopback host check) |
| Persistent composer with model picker, wired end-to-end to the turns route | Met (hand-tested) | `composer.tsx` → `use-session-actions.ts` → `POST /sessions/:id/turns`; worker side pinned by `turn-model-route.test.ts`, renderer side untested |
| Open-a-repository modal, separate from the Mission Inbox | Met | `components/open-repository.tsx` with `open-repository.render.test.tsx` (7 tests); `components/modal.tsx` with `modal.test.tsx` (11 tests) |
| Spacing/type design system (`--space-1..8`, `--text-*`, radii, control heights) | Met | `packages/ui/src/tokens.css`, imported by `apps/desktop/src/styles.css`; `styles.test.ts` (6 tests) pins it; `skills/novus-ui/SKILL.md` documents it |
| **Workroom shell: composition derived from mission state** | Met (2026-08-01) | `mission-state.ts` with `mission-state.test.ts` (11 tests) derives seven states and which regions each mounts; `components/workroom/*` renders them; `workroom.render.test.tsx` (14 tests) asserts what each state must *not* contain. Styling split out of `styles.css` into `styles/workroom.css` |
| **Start canvas — a repository opened with nothing asked** | Met (2026-08-01, hand-tested at 1280 and 1440) | `components/workroom/empty-mission.tsx`. One question, one composer, one primary action; no rail, no evidence, no lifecycle. Replaces a screen that rendered every region the app has against no data |
| **Workstream rail — agents and people as the primary objects** | Met (2026-08-01) | `workstreams.ts` with `workstreams.test.ts` (8 tests). A workstream is an approach (baseline + forks), read from `/compare` with a log-only fallback that never overstates liveness. Identity colours are provenance only and none of them is green. **The multi-workstream rail is proven in tests, not on screen** — a session with two approaches routes to the Decision Room instead (gap 19) |
| **Activity as attributed milestones rather than an event list** | Met (2026-08-01) | `components/workroom/activity-feed.tsx` with `activity-feed.test.tsx` (6 tests). Consecutive reads fold into one line counted by file; a person's direction is attributed to the person; `run.completed` is never told as verified |
| **Evidence inspector mounted only when it has something to say** | Met (2026-08-01) | `components/workroom/evidence-inspector.tsx`. `verified: null` renders "Nothing has verified these changes", muted — never green, never red |
| Light/dark theme | Met (hand-tested) | `packages/ui/src/tokens.css` `:root[data-theme="light"]`, stamped before first paint by `main.tsx` from `use-theme.ts:initialTheme` |

### Guest app

| Capability | Status | Evidence |
| --- | --- | --- |
| Live timeline, presence, run stats, reconnect-with-resume | Met, below the React layer | `packages/session-client/src/*.test.ts` (41 tests: endpoint, invite, relay-client, roles, timeline) — the shared client the guest and the desktop's joined tab both use. The guest's own React is untested (gap 8) |
| Reads via relay or worker, token-gated either way | Met | `packages/session-client/src/relay-client.test.ts`, `endpoint.test.ts`; CLAUDE.md's guest facts |
| Desktop's design system | **Partial** | `apps/guest/src/styles.css` imports `@novus/ui/tokens.css` and draws on it in 176 places, so the scales and palette are genuinely shared. Still missing: the guest never stamps `data-theme`, so it takes the `:root` default and is dark-only while the desktop has both (gap 9) |
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
Numbered so other documents can point at them, which is why a closed gap keeps
its number and is marked *Closed* instead of being deleted and the rest
renumbered. Checked 2026-08-01: 1–18, contiguous, no duplicates, and every
cross-reference in this file and in V1_README resolves to a number that
exists.

1. **Fork worktrees are torn down when a decision resolves them — and only
   then.** *Mostly closed (2026-07-31.)* `SessionRegistry.reclaimResolvedForks`
   sweeps at session open, using `collectableForks`: an attempt is collectable
   when an applied `decision.recorded` follows it in the log and its run is
   not paused or running. `pruneRecords` clears Git registrations whose
   directories are already gone. `fork-run.test.ts` — "attempts a decision
   resolved are reclaimed at the next open; undecided and paused ones are not"
   — drives it through the real routes; `worktree-manager.test.ts` covers the
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
   interruption. Paused runs are untouched. `fork-run.test.ts` — "an attempt
   the worker died inside is failed at session open, while a paused one
   survives" — asserts both directions in one log. **Still open:** liveness is
   only knowable
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
4. **A resumed run's wall clock restarts; its tokens and cost no longer do.**
   *Mostly closed (2026-07-31.)* Two of its three parts are shut. A
   *session's* spend: `projectSession` folds `receipt.created` into a total,
   served by `GET /sessions/:id/usage` and shown in the rail, so a resumed
   session reports what it has actually spent instead of zero (`fork-run.test.ts`,
   "a session's spend is read from the log, so a restart does not reset it",
   across a real restart). A *run's* spend: `run.paused` now carries a
   `usage` snapshot, and `AgentRunner`'s `execute()` seeds `inputTokens`,
   `outputTokens`, `modelCalls`, `callsMissingUsage`, `modelTimeMs` and
   `costUsd` from the newest pause for that run before the first model call —
   so the token, call and cost ceilings in `budget.ts` are checked against the
   whole run, not the leg since the last resume. An unpriced leg makes the
   whole run unpriced rather than resuming at zero. `pause-resume.test.ts`
   covers both the carry ("a resumed run continues its spend rather than
   restarting it") and the back-compatible case, where a pause recorded before
   the snapshot existed resumes from zero. **Still open:** `execute()` sets
   `startedAt = this.now()` unconditionally, so `budget.wallClockMs` (30
   minutes by default) restarts on every resume — neither the pause itself nor
   the turns before it count against the continuation's clock. That is the one
   bound a long pause can still evade, and closing it needs the paused-at
   elapsed time on the event too.

   The `resume()` docstring in `agent-runner.ts` still says token usage is
   deliberately not carried forward "because it is only ever reported per model
   call and never logged". That was true when written and is now contradicted
   by `execute()`, which `resume()` delegates to with `continuing = true` and
   which does the seeding — see gap 13.
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
8. **The renderer is tested where it is a component and untested where it is
   a hook — and the guest's React is untested entirely.** *Mostly closed
   (2026-08-01.)* `scripts/tsx-hook.ts` registers a synchronous esbuild
   transform so `node --test` can parse `.tsx` at all, and `apps/desktop`'s
   test script globs `src/**/*.test.ts` and `src/**/*.test.tsx` beside
   `electron/*.test.ts`. What exists now: 104 tests over ten files under
   `apps/desktop/src` (`control-panel.render`, `mission-inbox`, `modal`,
   `open-repository.render`, `timeline-summary`, `join/joined-surface.render`
   rendered to static markup; `decision-room`, `mission-phase`,
   `join/joined-api`, `styles` as logic), 37 over three under
   `apps/desktop/electron`, 66 in `packages/ui`, and 41 in
   `packages/session-client`. That last package is what actually closed the
   guest's transport coverage — `endpoint`, `invite`, `relay-client`, `roles`
   and `timeline` moved there and are shared with the desktop's joined tab.

   **Still open, and this is what "narrow" means here:** every `use-*.ts` hook
   under `apps/desktop/src` is untested (`use-session`, `use-session-actions`,
   `use-session-events`, `use-presence`, `use-comparison`, `use-file-changes`,
   `use-file-tree`, `use-github`, `use-theme`, `use-turn-model`,
   `use-session-usage`, and the three under `join/`), as is `app.tsx` itself —
   which is where the token-less Open-screen fetch lived, so the exact class of
   bug this gap was opened for is still uncovered. `apps/guest/src` has no test
   files **and no `test` script**, so `pnpm -r --if-present test` skips it in
   silence; `packages/contracts` has no `test` script either, which silently
   skips the one package everything trusts.
9. **The guest shares the desktop's tokens but not its theme.** *Mostly
   closed.* `apps/guest/src/styles.css` imports `@novus/ui/tokens.css` and
   reads from it in 176 places, so the scales and palette really are the
   desktop's, and the header comment's "same tokens, same spacing" is true
   again. **Still open:** the guest's `main.tsx` never stamps `data-theme`, so
   it always takes the `:root` (dark) branch of the shared tokens while the
   desktop stamps light or dark before first paint. A guest cannot be in light
   mode, and nothing on screen says why.
10. **Requesting control has a UI trigger everywhere except the browser
    guest.** *Mostly closed (2026-08-01.)* The hosting window has had one for
    a while — `components/control-panel.tsx`'s "Request control" calls
    `use-session-actions.ts:requestControl`, which POSTs
    `/sessions/:id/control/request`.
    A joined desktop window now reads `/authority` with its invite token and
    renders the whole lifecycle — who holds control, standing requests,
    an offer it can accept or decline, an accepted transfer waiting on the
    run that is holding it, and direction queued versus merely recorded —
    with every action absent rather than disabled where the role does not
    carry it. `join/joined-api.test.ts` (11 tests) drives those calls through a
    real event server; `join/joined-surface.render.test.tsx` (16 tests) pins
    who sees what.
    **Still open:** the browser guest, which remains structurally read-only and
    has never issued a POST, and a relay join, which is watch-only in both
    directions because the transport carries the log outbound and nothing back
    — `joined-surface.tsx` says so on screen ("this connection cannot send
    anything back") rather than hiding it. Nobody has stood up a `wss://`
    relay, so remote operational multiplayer is unproven, not merely
    unpolished.
11. **Handoff is an offer the recipient accepts.** *Closed (2026-08-01.)*
    This entry used to say the opposite, and V1_README's protocol section was
    right all along. `POST /sessions/:id/handoff` offers control and records
    `control.offered`; `POST /sessions/:id/handoff/(accept|decline|withdraw)`
    answers it with `control.accepted` / `control.declined` /
    `control.withdrawn`, and only an acceptance produces `control.transferred`.
    A second offer is refused while one is in flight, an answer naming a
    superseded offer is refused, only the participant an offer names may
    answer it — and because authority is the offer rather than the rank, a
    viewer may accept. Acceptance during a live run waits for the run's next
    safe boundary before control actually moves. `control-lifecycle.test.ts`
    (18 tests) covers each of those, plus what a departure versus a mere
    disconnect does to a standing request or an open offer.
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
    since those files belong to active slices, and this slice is documentation
    only): `use-turn-model.ts:10`'s seam comment says the turns route "does not
    exist yet" — it exists, is routed, and is pinned by
    `turn-model-route.test.ts`; `agent-runner.ts`'s `resume()` docstring says
    token usage is deliberately not carried across a resume "because it is only
    ever reported per model call and never logged", which the `execute()` it
    delegates to now contradicts (gap 4); the `contracts.ts` cost comment (gap
    6). The guest stylesheet header, previously listed here, is accurate again
    (gap 9).
14. **`search_repository` silently skips files over ripgrep's 1M cap**
    (`tools.ts`, `--max-filesize 1M`), and the event log stores oversized tool
    results whole — the model boundary elides them to a stub that names what it
    dropped (`context-size.test.ts`), renderers and the relay still carry the
    full payload.
15. **StrictMode hydration still issues N+1 resume POSTs** per dev-mode
    launch: `app.tsx`'s hydration effect checks its `cancelled` flag before
    each resume, so a double-invoked pass breaks out after the first — but the
    first `open()` is called before any await, so one spurious `POST /sessions`
    per launch survives. Harmless duplicate `session.created` rows; the
    timeline hides them since `3dbb664`, the log keeps them.
16. **Packaging is configured; the entitlements are not committed and
    nothing is signed.** *Partially closed (2026-07-31.)*
    `apps/desktop/package.json`'s `build` block sets the appId, the DMG target,
    `hardenedRuntime`, and `asarUnpack` for the bundled worker and node-pty;
    `scripts/build-worker.mjs` esbuilds the worker to plain JS so the packaged
    app runs it under Electron's own Node with no system Node at all. `pnpm
    --filter @novus/desktop dist` produced a DMG on the machine that built it,
    and that app was launched and verified to start its bundled worker, answer
    `/health`, and write its database to userData rather than inside its own
    bundle. **Still open, and the first of these is new:** the
    `build/entitlements.mac.plist` that `build.mac.entitlements` and
    `entitlementsInherit` both point at is not tracked by Git, is matched by
    `.gitignore`'s blanket `build/` rule, and no commit has ever touched
    `apps/desktop/build` — so the verified build is not reproducible from a
    clone, and `dist` on a fresh checkout will not find the file it names.
    Beyond that the build is unsigned and un-notarized, so Gatekeeper warns on
    another machine; that part needs an Apple Developer certificate. Milestone
    5's "clean machine" exit has not been run on a genuinely clean machine.
17. **Deciding is the controller's alone, deliberately.** *Open by choice
    (2026-08-01.)* `decide` is its own capability rather than a shade of
    `steer`, so an editor can direct a run and cannot settle a comparison, and
    a reviewer cannot apply code indirectly through the combined
    decide-and-apply route. That is narrower than the roles table implies a
    reviewer should get. It is narrow on purpose: selection and application are
    one permissioned operation today, so granting a reviewer the power to
    select would grant them the power to write. **The condition for widening
    it:** split `POST /sessions/:id/decision` so that recording a decision and
    applying its files are separately permissioned. Until then, not before.
    `apps/worker/src/participants.ts:CAPABILITIES` is the authoritative table
    (`decide` on owner only), mirrored client-side in
    `packages/session-client/src/roles.ts` so a joined window hides what would
    403 rather than offering a control that fails on click; if the two
    disagree the worker wins. `decision-authority.test.ts` (5 tests) pins every
    refusal — editor, reviewer, viewer, and an owner of one session acting on
    another.
18. **The flaky `/authority` test was a race, not contention.** *Closed
    (2026-08-01.)* It was never about load. The run loop drains pending
    direction at the top of each iteration, and the top of the *first*
    iteration is a boundary like any other — so a direction posted between
    `run.started` and the first model call was folded in immediately and
    correctly, leaving `pendingDirection` empty, which is not the state a test
    of "queued but not yet applied" is trying to observe. `startRun` returned
    as soon as the run was executing, which is inside that window. Load only
    widened it, which is why it read as contention for so long.

    The test's own adapter now signals when the loop is parked inside the
    model call, and its `startRun` helper waits for that rather than for
    `run.started` — `control-lifecycle.test.ts`, the `noopAdapter` /
    `entered` block at the top of the file, with the reasoning written beside
    it. Verified ten
    consecutive times, four of them against three concurrent full suites. No
    product behaviour changed: folding a direction in at the first boundary is
    correct, and the test was asserting against a window the product never
    promised.
19. **A multi-approach session cannot reach the Workroom, so its rail has
    never been seen.** *Open (2026-08-01.)* `decideDecisionRoom` opens the
    Decision Room automatically when a mission has approaches awaiting a
    decision — correct behaviour, and the point of an earlier slice. The
    consequence is that the one session shape that would show two workstreams
    side by side in the new rail routes somewhere else entirely, so the
    multi-workstream composition is proven only by
    `workroom.render.test.tsx` and `workstreams.test.ts` and has not been
    looked at on screen. Closing this needs either a fixture with two
    approaches and a recorded decision, or a way to reach the Workroom from
    the Decision Room without dismissing the decision.
