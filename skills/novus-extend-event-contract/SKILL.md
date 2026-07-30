---
name: novus-extend-event-contract
description: Add a new SessionEvent type, or a new terminal status for a run, without leaving the projection, receipt, compare screen, or guest timeline silently out of sync. Use when a capability needs a new event family (e.g. a decision, a cancellation) or widens what a run/attempt can end as.
---

# Novus Extend Event Contract

Adding an event type to `packages/contracts` touches more of the codebase
than the compiler will tell you. One place is enforced at build time; four
more have to be found and fixed by hand, and each fails silently rather than
with an error if you miss it.

## The one place that is compiler-enforced

`packages/ui/src/event-row.tsx` types its glyph table as
`Record<SessionEvent["type"], string>`. Adding a variant to
`SessionEventSchema`'s discriminated union in `contracts.ts` makes this fail
to typecheck until you add an entry. Treat that error as your checklist
starting gun, not a nuisance to clear quickly — it is the only thing in the
codebase that actually forces you to notice a new event type exists.

Add a render case in the same file's `switch (event.type)` too. Nothing
enforces this half — the switch has no `default: throw` — but an event with a
glyph and no body renders as a blank row, which reads as a bug to whoever
sees it first.

## Four places that are NOT enforced, and fail silently

Everything else that reasons about `event.type` will simply not run its new
branch, with no compile error and no runtime error — the code just keeps
behaving as if the new event never happened.

- **`apps/worker/src/projection.ts`** — `switch (event.type) { ...
  default: break }`. A new event that should change a run's status,
  `filesChanged`, or `controlHeldBy` needs its own `case`. Miss it and the
  projection quietly keeps reporting the old state forever — a cancelled run
  looks "running" indefinitely, for example.
- **`apps/worker/src/receipt.ts`** — finds specific event types by string
  literal (`forRun.find(event => event.type === "run.completed")`, etc.) and
  chains them into a `terminal = a ?? b ?? c` lookup. A new way a run can end
  needs its own `.find()` folded into that chain, or `buildReceipt` returns
  `null` for it — a run that finished, with no receipt, and nothing saying
  why.
- **Every enum that mirrors the same status across a boundary.** V1 has at
  least three separately-declared enums for "how can a run end":
  `RunProjection.status` (a hand-written TS type in `projection.ts`),
  `RunReceiptSchema.status` and `AttemptComparisonSchema.status` (both Zod
  enums in `contracts.ts`/`protocol.ts`). TypeScript will not catch a mismatch
  between them — `compare.ts`'s own `AttemptComparison`/`Comparison` types are
  hand-written, not derived from the Zod schemas, so a value that only one of
  the three enums accepts typechecks locally and fails only when the client
  validates the JSON with `ComparisonSchema.safeParse` and silently refuses to
  render ("Refused rather than rendered" — that refusal is by design, but the
  bug that trips it is not). Widen all three together, in the same change.
- **`apps/guest/src/timeline.ts`** keeps its own terminator list and its own
  `runStatus` ternary, entirely separate from `apps/desktop/src/app.tsx`'s.
  The guest is read-only and imports nothing from the desktop app, so fixing
  `app.tsx` alone leaves a remote teammate's screen wrong — exactly the
  failure Milestone 3's exit condition exists to catch ("understand its
  current state without a verbal recap"), and the desktop test suite will not
  notice because it never touches `apps/guest`.

## Checklist

For a new event type that changes what a run or attempt looks like:

- [ ] `contracts.ts` — add to `SessionEventSchema` and `SessionEventDraftSchema`
- [ ] `protocol.ts` — widen every enum that mirrors a status this event
      changes, together, in the same edit
- [ ] `event-row.tsx` — glyph (compiler-forced) and a render case (not
      forced; do it anyway)
- [ ] `projection.ts` — a `case` if the event changes run/session state;
      widen `RunProjection.status` if it is a new terminal state
- [ ] `receipt.ts` — fold into the terminal lookup and the status enum if
      this is a new way a run can end
- [ ] `apps/guest/src/timeline.ts` — mirror whatever changed in the
      desktop's status logic; the guest keeps its own copy
- [ ] a test that exercises the new status through projection, receipt, and
      guest timeline — not only that the Zod schema parses the new shape

## Writing to a repository outside the model's own tool loop

A related trap: a capability that needs to write files to a repository from
*server-side* logic — not from a model's tool call — is not a reason to
invent a second way to touch a working tree. `apps/worker/src/tools.ts`
exports `ProposePatchTool`, `ApplyPatchTool`, and `resolveInsideRepository`
precisely so this is possible: they are plain classes bound to a
`repositoryPath` at construction, not singletons tied to one session's tool
list. Construct fresh instances against whichever repository you are writing
to, and drive them with synthetic `ToolCall` objects the same shape the model
would have produced. This reuses the exact drift check that already protects
the agent's own writes — `apply_patch` refuses when a file changed since the
proposal was computed — and the same path confinement, for free. See
`apps/worker/src/apply-decision.ts` for a worked example: applying a chosen
fork's diff to the parent's working tree this way, one file at a time, with a
preflight pass so one conflicting file refuses the whole apply rather than
half-writing the rest.
