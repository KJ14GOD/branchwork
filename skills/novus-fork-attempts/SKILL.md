---
name: novus-fork-attempts
description: Work on fork and attempt execution — the child runner in a worktree, its permission intersection, runner caching, restart adoption, and the isolation limits — without recreating the bugs that shipped when forks first ran nothing and later ran wrong. Use when changing startForkRun, buildForkRunner, WorktreeManager, checkpoint policy, resume paths, or the compare/decision flow, or when closing the fork lifecycle gaps.
---

# Novus Fork Attempts

An attempt is an in-process `AgentRunner` running in the fork's own worktree
under a **preassigned run id**, its events landing in the parent session's
log where the timeline, `/compare`, and `/files` already look. It is not a
process: it shares the worker's process, environment, and lifetime, so the
worker exiting takes every running attempt with it. This section of the
system carried the project's worst documentation lie — "Isolated child runs"
ticked for a route that ran nothing — so changes here get held to the
evidence bar below.

## The rules that are load-bearing

**The permission gate is an intersection, never the host defaults.**
`buildForkRunner` (`apps/worker/src/session-registry.ts`) builds the gate as

```ts
buildApprovalGate(
  session.allowWrites && recorded.allowWrites,
  session.allowCommands && recorded.allowCommands,
)
```

where `recorded` is the tool policy the checkpoint recorded
(`checkpointToolPolicy`, defaulting to *deny both* when the checkpoint is
silent). Consequences you must preserve: an attempt can never hold authority
its parent session currently lacks; a session opened with writes off and
resumed with writes on still cannot widen a fork it already cut; a fork
resumed after a restart is clamped by what the resumed session allows now —
the "permissions are deliberately not restored" rule extends to fork
continuations.

**One runner per attempt, cached for the session's life.** Runners live in
`session.forkRunners`. This is not an optimisation: patch proposals live in
`ProposePatchTool`'s memory, not in the log. A fresh runner per resume meant
a paused attempt could not apply the patch it proposed before pausing —
`apply_patch` said "No patch proposal exists", the run completed, and the
compare screen showed a finished attempt with zero files changed, which is
the worst possible place for a silent wrong answer. The model, meanwhile,
saw its own proposal fine (`rebuildToolExchanges` replays the log), which is
what made it hard to spot. If you rebuild runners, you must migrate proposal
state or re-derive it from the log first.

**Fork runs bypass the session's turn queue, on purpose.** Concurrent
attempts are the point. Each fork gets a per-fork chain so one attempt
cannot double-start, and attempts never drain session direction —
`drainDirection` is single-consumer, so concurrent consumers would race the
parent for who swallows it. An attempt's goal is frozen at its checkpoint.

**Resume must route to the fork's runner.** `resumeTurn` looks up the run id
against recorded forks; before it did, resuming a paused fork executed its
remaining turns in the *parent's* working tree with the *parent's* gate.
Any new path that continues a run must make the same lookup.

**Durability comes from the log, not memory.** Forks are derived from
`fork.created` at session open — an in-memory fork map was rebuilt empty on
every resume, which is why forks used to vanish from `/compare` on restart.
`WorktreeManager.adopt` re-attaches recorded forks to their on-disk
checkouts, re-verifying path containment and repository identity and
re-reserving dev ports. A fork whose checkout was deleted keeps its evidence
on the compare screen and refuses the apply. A fork that fails before
`run.started` (no adapter, vanished worktree) is attributed as `run.failed`
under its preassigned id — unlike the parent path, the id exists before the
run does, so nothing is ever silently dropped.

## What worktree isolation does not give you

A `git worktree` shares one repository: object database, every ref, the
stash, and the hooks directory are common to the parent and every fork. An
attempt with `run_command` can move the parent's branch, delete a live
sibling, or plant a hook — all demonstrated in the 2026-07-29 audit.
Tolerable only because `run_command` is dangerous-class, denied by default,
and the fork gate intersects; the moment forks run with commands enabled by
default, the fix is a clone per attempt, paid in disk and checkout time.
V1_README's *Forking* section is the authoritative statement — keep it true.

## The evidence bar

`apps/worker/src/fork-run.test.ts` — nine tests, scripted adapters, real
scratch repositories, driven over the real HTTP surface, zero live calls.
The ones that exist to kill specific regressions:

- concurrency is proven by a **rendezvous barrier** that fails loudly if
  attempts are secretly serialised — never by timing;
- restart survival runs a **second `SessionRegistry` over the same store**
  and applies the decision from it;
- the permission tests assert against the *host defaults* being inherited,
  which is the direction the bug actually points;
- pause/resume asserts the work landed in the fork's tree and that the
  pre-pause proposal still applies.

A change here that cannot say which of the nine covers it needs a tenth.
Isolation tests that exercise `WorktreeManager` directly are necessary and
insufficient — that is precisely how "Isolated child runs" stayed falsely
ticked. At least one test must enter through `POST /sessions/:id/fork`.

## The open gaps, if you are here to close them

Both are recorded as gaps 1 and 2 in PROGRESS.md; update those rows in the
same commit.

- **Teardown.** `WorktreeManager.removeFork` and `removeAll` exist and are
  called only by tests; every fork accumulates a full checkout forever. The
  decision to make is *when* removal is safe: applying a decision does not
  end the other attempts, sessions have no close path, and a removed
  worktree must not strand a paused attempt or break `adopt` on the next
  open. Whatever policy you pick, the deleted-worktree behaviour (evidence
  kept, apply refused) must survive — test 8 pins it.
- **Reconciliation.** An attempt interrupted by a worker exit stays
  `running` forever; every `run.failed` append site needs a live promise.
  The natural seam is session open, which already re-derives forks: a
  `run.started` under a fork's run id with no terminator and no live runner
  is reconcilable there. If that grows a new event type or terminal status,
  read `novus-extend-event-contract` first — projection, receipt, compare,
  and the guest each keep their own copy of "how a run can end".
