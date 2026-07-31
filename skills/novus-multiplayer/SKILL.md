---
name: novus-multiplayer
description: The authority model — who holds control, how a handoff moves it, how a control request stands, and how direction goes from submitted to queued to applied. Use when changing the control or direction routes, adding a role or capability, deciding whether an action needs a capability or an identity check, or debugging a participant who can or cannot do something they should not or should.
---

# Novus Multiplayer Authority

Novus is a decision room, not a shared screen. The difference is entirely in
this file: a shared screen shows everyone the same pixels, and a decision room
can say who is responsible for what happens next, how that responsibility
moves, and who asked for it. Everything below exists to keep that answerable.

## The three rules

Every decision here is downstream of these. When a change makes one of them
untrue, the change is wrong, however convenient.

1. **Control is explicit and visible.** Never ambiguous, never silently
   inherited, never held by someone who has left. The log is what says who
   holds it — not the participant registry, not the UI, not "whoever started
   the worker".
2. **A handoff is a lifecycle, not a toggle.** Offered, accepted, and taken
   effect at a safe boundary are three distinct states. A UI that collapses
   them is wrong even when the collapse is usually invisible, because the case
   where it is visible is a run in flight, which is exactly when it matters.
3. **Standing facts survive a refresh.** A control request is a fact until
   control reaches the requester or they leave. A controller who was not
   looking at the moment it arrived must still learn it exists.

## Two kinds of authority, and picking the wrong one is the bug

There are two questions, they have different answers, and conflating them has
already produced one security hole and one usability hole in this repo.

**"What does this person's rank permit?"** → a **capability**. The table is
`CAPABILITIES` in `apps/worker/src/participants.ts` (owner ⊃ editor ⊃ reviewer
⊃ viewer), checked by `roleCan`, and applied by the `required` table in
`event-server.ts` beside the routing. Routes do not name roles; they name
capabilities, so adding a role later is one table edit rather than an audit of
every handler.

**"Is this the specific person the log says may act right now?"** → an
**identity check**, at the route. `refuseControlOffer` and
`refuseHandoffAnswer` in `participants.ts` are these. They take the projection
and the caller's id and return `{ status, error }` or null.

The rule for choosing: if the answer would change when the same person is
handed a different role, it is a capability. If the answer would change when a
different person with the *same* role asks, it is an identity check.

**The hole this closed.** Accepting a handoff cannot be a capability. Control
is offered to people who do not hold it — that is what a baton is for — so the
recipient of an offer is routinely a viewer, and gating acceptance on
`transfer` or `steer` means the only participants who can take control are the
ones who already have it. `/handoff/{accept,decline,withdraw}` therefore ask
only for `watch`, which is the floor (you must be a participant of this
session), and the identity check does the real work.

**The hole before that, which will come back if you are not careful.** The
capability check once asked *what role* without asking *which session*, so a
viewer invited to one repository could act on another by knowing its id. The
fix is the session-scope check at the top of `refusedFor` in `event-server.ts`.
It is load-bearing for every `/sessions/:id/...` route, not just the ones added
with it, and the host's own participant is exempt on purpose — the worker
outlives any one session and its owner is the person running it.

> **Testing a scope check is harder than it looks.** A cross-session test that
> asserts only a 403 will pass against a worker with the check deleted, because
> the identity check underneath refuses for a *different reason* with the same
> status. `control-lifecycle.test.ts`'s cross-session test asserts on the log —
> that no `control.requested` landed in the session the token was never invited
> to — and picks `/control/request` deliberately, because it needs only `watch`
> and so has no identity check to mask the missing scope check. Copy that shape.

## The handoff lifecycle

Six steps, from STEERING §10. Each is an event because each is a fact somebody
acted on; an offer nobody answered has to stay visible as exactly that, never
silently promoted into a transfer.

```
POST /sessions/:id/handoff              → control.offered
POST /sessions/:id/handoff/accept       → control.accepted [→ control.transferred]
POST /sessions/:id/handoff/decline      → control.declined
POST /sessions/:id/handoff/withdraw     → control.withdrawn
                    (a run ends)        → control.transferred
```

- **Offer.** Needs `transfer`, plus: you hold control, there is no offer
  already in flight, and the target is not you. The one hole in "you hold
  control" is deliberate — when `controlHeldBy` is null nobody can satisfy it,
  so an unheld baton falls back to the capability table alone. Without that a
  session whose controller left could never name a new one.
- **Accept.** The recipient only, and the offer id must match the one in
  flight. Accepting twice is refused rather than being idempotent: the first
  acceptance may still be waiting on a run, and a second 202 would read as "it
  went through this time".
- **Decline / withdraw.** Decline is the recipient's, withdraw the offerer's.
  Both are allowed on an already-accepted offer — either side may back out
  before it lands.
- **Transfer.** `settleAcceptedHandoff` in `event-server.ts`. Runs from the
  acceptance itself and from a `store.subscribe` on every terminal run event
  (`run.completed`/`failed`/`cancelled`/`paused` — a paused run is a boundary,
  the loop has genuinely stopped). Nothing executing → it moves now. Something
  executing → it waits, and that wait is the state the UI must show.

**The offer id is pinned on every answer.** An answer arrives from a client
that rendered some state, and that state can be stale — the offer it is
answering may have been withdrawn and another made in its place. Without the
pin, a stale click settles an offer its sender never saw.

**`transferOwnership` can fail at settlement time** (the offerer was removed,
or control moved elsewhere while the offer sat accepted). It emits
`control.withdrawn` rather than leaving the offer pending, because an offer
that can never be honoured must stop being displayed as one — the alternative
is a session showing "control transfers at the next safe boundary" forever
while every boundary passes.

## The direction lifecycle

`submitted → queued → applied`, and the middle one is not decoration.

- **`direction.submitted`** — `POST /sessions/:id/direction`, capability
  `direct` (an editor, not a reviewer: direction is free text appended to the
  goal, so anyone who can submit it can tell the agent to do something else,
  and the reviewer role is defined as approving *without* executing).
- **`direction.queued`** — emitted by the same route, immediately, **only when
  a live non-fork run exists**. That is when the commitment is real: the runner
  drains direction at every turn boundary, so a live run will pick it up.
- **`direction.applied`** — emitted by `AgentRunner.drainDirection`, at the
  boundary, as the direction is folded into the goal.

**Why queued is written at submission and not at the boundary.** By the time
the runner drains, queued and applied happen in the same instant; an event
emitted there would describe a state that never lasted long enough for anyone
to see. The visible gap is between typing and the next boundary, and that gap
is what the submitter needs named — "the running execution will read this"
versus "this is recorded and waits for whatever runs next, which may be never".

**Forks are excluded on purpose.** A forked attempt's goal is frozen at its
checkpoint and `AgentRunner` refuses to drain direction inside one, so queueing
against a fork would promise something that will not happen. `directionTargetRun`
filters run ids appearing in `fork.created`.

## Where the state lives

**`projectSession` is the only fold.** `controlHeldBy`, `controlOffer`,
`controlRequests`, `pendingDirection`. Do not add a second — a renderer that
folds control itself will disagree with the worker eventually, and when a
timeline and a baton disagree it is the baton that is wrong and the person
acting on it who pays.

`GET /sessions/:id/authority` serves that slice, plus `you` (which participant
the caller is) and `executingRunIds` (what a waiting transfer is waiting on).
`apps/desktop/src/use-authority.ts` polls it every 3s, the same judgement
`usePresence` makes and for the same reason: this is an overlay on a session
that works without it, so a failure sets it empty rather than raising an error
over the run.

Two folded rules worth knowing before you touch them:

- **A disconnect is not a departure.** `participant.left` with reason
  `disconnected` keeps standing requests and any offer in flight; `left` and
  `removed` void them. The controller's own baton is dropped on *any* of the
  three, which is why nothing writes a `disconnected` one.
- **Requests are latest-per-participant.** Asking twice sharpens one request
  rather than stacking two in front of the controller.

## Things that are not true yet

Say these plainly rather than discovering them.

- **`reason: "disconnected"` is unreachable.** Nothing emits it. A dropped SSE
  stream flips the registry's `connected` flag and writes nothing to the log —
  deliberately, because the fold clears `controlHeldBy` on any
  `participant.left`, so writing one per closed EventSource would mean a
  refresh drops the baton. The reason exists for a future explicit
  disconnect-tracking change; the fold is ready for it and the projection test
  in `control-lifecycle.test.ts` pins the behaviour.
- **Control does not survive a worker restart.** The host's participant id is
  minted per process, so a resumed session's `controlHeldBy` names an id
  nobody holds. It renders as "Someone who has left", which is honest but is
  not a story for reclaiming control.
- **There is no remove-participant route.** `ParticipantRegistry.remove` exists
  and nothing calls it, so reason `removed` is unreachable too.
- **The joined window has none of this.** `apps/desktop/src/join/` and
  `apps/guest` do not call `/authority`. A joined tab still learns its role
  from `/me` and follows handoffs that way, so it is not *wrong* — it simply
  cannot show or answer an offer, which means control cannot be handed to
  somebody who joined from another machine through the UI.
- **A live fork blocks a transfer.** `settleAcceptedHandoff` counts any running
  run, forks included. Defensible (handing somebody an execution mid-flight
  makes them accountable for something they never watched start) but it means a
  long attempt stalls a handoff, and nothing tells the user which run is
  holding it up beyond `executingRunIds`.

## Changing any of this

1. **Check the contract first.** The control and direction events are all
   already in `packages/contracts/src/contracts.ts`, and the request shapes
   (`ControlRequestSchema`, `HandoffRequestSchema`, `HandoffAnswerSchema`,
   `AuthorityResponseSchema`) in `protocol.ts`. Take the lock
   (`./scripts/contract-lock.sh acquire`) before touching either, and read
   `skills/novus-extend-event-contract` if you are adding an event.
2. **Put the decision in `participants.ts`, not in the route.** Routes read
   bodies and write events. "May this person do this" belongs beside `roleCan`
   where the whole authority model is one file to read.
3. **Add the capability-table entry.** A new `/sessions/:id/...` route with no
   entry falls through to the default `steer`, which is silently wrong in both
   directions — a viewer who should be able to answer an offer cannot, and an
   action that should need `transfer` only needs `steer`.
4. **Write the acceptance test, then revert your fix and watch it fail.** This
   repo has shipped a passing test that also passed against broken code. The
   mutation list that guards this slice is: scope check deleted, handoff
   transfers atomically, recipient identity check deleted, withdraw ownership
   check deleted, safe boundary ignored, boundary subscription removed,
   `direction.queued` never emitted, direction queued while idle, host never
   joins its own session, leave records a disconnect, disconnect voids
   requests, a leaver keeps control, requests stack, a transfer leaves the
   request standing, an offer no longer blocks a second offer, stale offer ids
   accepted. All sixteen fail the suite. Keep it that way.
5. **Render an action only for whoever may take it.** Not disabled — absent.
   A greyed-out "Offer control" still tells a viewer this screen offers
   control and they are being denied it. The worker refuses independently; the
   absent button is the interface agreeing with the boundary, not enforcing it.

## Test with a scripted adapter, never a live one

`control-lifecycle.test.ts`'s `noopAdapter` has a `complete` that never
settles. A turn submitted through it starts a real run that stays running until
the test ends, which is what makes "accepted while something is executing" a
state a test can hold still and inspect. Nothing reaches a provider. Pin
`ANTHROPIC_API_KEY` to a placeholder anyway — `--env-file` does not override an
already-set variable.
