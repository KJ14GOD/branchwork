# Novus Product Steering

The product decision this repository is built around. Read before proposing
work; it outranks feature enthusiasm, including your own.

`README.md` says what Novus is for. `V1_README.md` scopes V1. `PROGRESS.md`
says what is actually true today. This file says **what we are becoming and
what we refuse to become**, and it is the tiebreaker when those pull apart.

## The decision

Novus is the **collaborative verification and decision layer for coding
agents**.

- **Category:** multiplayer AI for software engineering
- **Product:** a shared mission room for humans and coding agents
- **Wedge:** branch, compare, prove, and decide on consequential changes
- **Moat:** the complete record of authority, direction, execution, evidence,
  alternatives, and decisions

> Branch the work. Prove the result. Decide together.

Multiplayer is *how* Novus works. Decision quality is *why* a team needs it.
Multiplayer alone is a category, not an advantage — shared workspaces, links,
and presence are already arriving everywhere.

## What Novus is not

Not an IDE. Not a Kanban board. Not a terminal manager. Not a model picker.
Not a Conductor clone. Not a dashboard for watching many private agent chats.

**Conductor coordinates workspaces. Novus coordinates decisions.** Conductor
is the benchmark for polish, density, and workspace legibility — borrow that
freely. Do not compete on panel count, provider count, or workspace count.
Build one level above it.

## The shared object is the mission

Not the chat, the agent, the repository, or the terminal. A mission holds the
goal, success criteria, repository state, participants and authority,
executions, human directions, checkpoints, competing approaches, changes,
verification evidence, decisions, and the receipt. Every participant sees the
same authoritative mission state.

Multiplayer must be **operational, not decorative**. Presence dots and a
shared transcript are insufficient. A participant must be able to join a live
mission, understand its state immediately, see who holds control, contribute
direction, see whether that direction is queued or active, request or receive
control, branch an approach, review evidence, record a decision, and
reconstruct who did what afterward.

## Vocabulary

Customer-facing language. Internal contracts migrate deliberately, only when
the contract itself must change — renaming for its own sake is migration risk.

| Internal | Customer-facing |
| --- | --- |
| Session | Mission |
| Run | Execution |
| Attempt | Approach |
| Fork an attempt | Try another approach |
| Timeline | Activity |
| Compare | Decision |
| Files changed | Changes / Evidence |
| Receipt | Decision receipt |
| Owner | Controller / "In control" |
| Guest | Viewer or Participant, by capability |

### Status language

**Never show "Idle" as a primary state.** Idle describes a process, not a
situation. Every major state answers three questions: what is happening, does
someone need to act, and what is the next action.

Ready for instructions · Running · Needs approval · Needs direction ·
Direction queued · Pausing · Paused · Ready to compare · Decision required ·
Decision recorded · Verification incomplete · Applying selected approach ·
Application conflicted · Failed · Cancelled

## Principles

1. **Mission over machinery.** Lead with the engineering goal. Repository
   paths, model names, event counts, and tool totals are supporting detail.
2. **Multiplayer by default.** Participants, authority, and shared state stay
   legible. Multiplayer is not hidden behind an Invite button.
3. **Evidence over confidence.** Tests, builds, diagnostics, diffs, and
   receipts outrank agent prose.
4. **Human authority is explicit.** Show who may direct, approve, hand off,
   select, apply, or merge.
5. **Completion is not verification.** An agent finishing does not mean the
   work is correct, safe, or ready.
6. **Alternatives begin from shared context.** A competing approach visibly
   originates from the same checkpoint.
7. **Decisions survive the interface.** A selection persists across refreshes,
   devices, and participants.
8. **Technical truth stays inspectable.** Simplify the default without
   discarding the event log or raw evidence.
9. **Progressive disclosure.** Show the next decision first; keep depth one
   deliberate interaction away.
10. **Calm seriousness.** Reliable and focused, never theatrical or cyberpunk.

## Principles already encoded in the fork/compare protocol

These are existing product decisions. **Do not weaken them in any redesign.**

- Approaches originate from a recorded checkpoint.
- Alternatives execute in isolated Git worktrees.
- Fork permissions are constrained by the parent mission *and* the checkpoint
  policy — an approach can never hold authority its parent lacks.
- Evidence is shown without automatic ranking.
- "No tests run" is never presented as success.
- Failed approaches remain evidence.
- The final selection belongs to an authorized human.
- The decision is recorded even when applying it hits a conflict.
- Read-only participants do not gain authority through presentation-only
  checks — the server is the authority.
- Selection and application are related but **distinct facts**.

## Scope rule

Every proposed feature must strengthen at least one verb:

**Frame · Branch · Prove · Decide**

If it strengthens none, do not build it now. Allocation for this cycle:
70% sharpening the core decision loop, 20% team-pilot foundations,
10% enterprise research.

## Information architecture

### Mission Inbox (home)

Organized by attention, not by repository: needs your decision · needs your
direction · needs approval · running · waiting on someone · recently
completed. A row shows the mission goal, repository (secondary), phase,
controller, participants, approach count, evidence state, last meaningful
activity, and a clear next action.

Repository tabs must not become the dominant organizational model. One
repository holds many missions; one person joins missions across repositories.

### Mission Room

Four regions, plus a persistent context-aware direction composer:

```
┌──────────────────────────────────────────────────────────────────┐
│ Mission goal            Needs decision    Alex in control    ••• │
├───────────────┬──────────────────────────────┬───────────────────┤
│ DECISION      │                              │ EVIDENCE          │
│ SPINE         │       ACTIVE CANVAS          │                   │
│ ✓ Brief       │    Shared checkpoint         │ Verification      │
│ ✓ Execution   │           │                  │  ✓ Tests          │
│ ● Approaches  │      ┌────┴────┐             │  ✓ Build          │
│ ○ Decision    │   Baseline  Alternative      │  ! Diagnostics    │
│ ○ Receipt     │      └────┬────┘             │ Changed files     │
│               │    Decision required         │ Contested files   │
│ PEOPLE        │                              │ Remaining risks   │
├───────────────┼──────────────────────────────┼───────────────────┤
│               │ Give direction…              │                   │
└───────────────┴──────────────────────────────┴───────────────────┘
```

**Header order:** mission goal (strongest text on screen) → state and next
action → controller and participants → repository and branch → model and
permissions → utilities. Never lead with a filesystem path. Do not fill the
header with pills; permissions and model detail belong in a popover.

**Decision spine:** Brief → Execution → Approaches → Decision → Receipt, each
with one status (complete, active, blocked, needs attention, not started).
Show visually that approaches share a checkpoint and converge into one
decision. This should become a recognizable signature of the product. No
passive tool-call counts in the prime part of this rail.

**Active canvas:** depends on mission state — brief before execution, grouped
activity during, branching view after a fork, Decision Room when approaches
finish, receipt after selection. Never send someone to an empty dedicated
page. Always show what exists, what is happening, and what to do next.

**Evidence inspector:** adapts to the current selection, quieter than the
canvas. The canvas explains the decision; the inspector supplies the proof.
Do not repeat the same information in both.

## Signature workflow: Approaches

The current execution is **always the baseline** and does not disappear
because no alternative exists yet.

Before an alternative: show the current approach, its goal, state, changed
areas, verification state, open concerns, and a short note on when another
approach helps. Exactly **one** primary action — *Try another approach* — not
duplicated in rail and canvas.

**Fork form:** one required prompt — *What should this approach do
differently?* (preserve backward compatibility; minimize the change surface;
avoid a new dependency; optimize for migration safety…). Generate the label
automatically; allow editing later. Before launch show the checkpoint it
starts from, the mission goal, the differentiating instruction, the
permissions it inherits, and what evidence will be compared.

**Approach card:** name, baseline-or-alternative identity, differentiating
intent, state, changed areas, verification state, open concerns, human
interventions, time and cost (secondary), and a view-evidence action. An
approach is not a line count and a tool-call total — tool calls are
implementation telemetry, not a decision criterion.

Approaches converge into a **human decision**, never an automatic synthesis.

## Signature workflow: Decision Room

The strongest screen in the product. Evidence order:

1. Behavioral differences
2. Verification outcomes
3. Unverified claims
4. Contested files and constraints
5. Human interventions
6. The result that will be applied
7. Agent-generated summaries — **last, because they are claims, not proof**

**Never rank automatically.** No score, no recommended winner, no glowing
preferred card, no default selection, no model verdict presented as objective
truth. The system summarizes evidence; the authorized human decides.

**Actions:** choose this approach · request revision · keep exploring ·
inspect contested change · record decision.

Selecting requires a short **rationale** — why it was selected, what evidence
mattered, what risk is accepted, what was left unresolved. It is stored in the
event log, the comparison projection, the receipt, joined-participant views,
and replay, and it must survive refresh and reconnection.

**Outcome language keeps selection and application distinct:** decision
recorded and applied · decision recorded, application blocked by conflicts ·
decision recorded, awaiting authorized application · revision requested ·
further exploration requested. **An application conflict is not a failed
decision.**

## Activity and provenance

Group events into human-readable milestones by default ("Identified three
affected modules", "Sarah submitted direction", "Direction queued for the next
safe boundary", "Required checks passed"). Keep tool calls, arguments,
results, event envelopes, sequence numbers, raw JSON, routing decisions, and
token accounting under **Technical details**. The default tells the mission
story; the technical view preserves auditability.

## Multiplayer authority

Presence is not enough. Show who is present, who is connected, who may direct,
who holds control, who may approve, pending control requests, pending handoff
offers, queued directions, when each direction became active, and who recorded
the decision.

**Control baton.** Authority is visible and movable: "Alex in control" · "Maya
requested control" · "Control offered to Maya" · "Waiting for Maya to accept" ·
"Control transfers at the next safe boundary" · "Maya now in control". Avoid
ownership language implying control can never move.

**Handoff lifecycle** replaces atomic transfer: offer → recipient receives →
accepts or declines → execution reaches a safe boundary → control transfers →
transfer recorded. Immediate after acceptance when nothing is executing.

**Direction lifecycle** is a stateful object: submitted → queued → applied
(→ superseded, rejected, or cancelled). A participant must be able to tell
apart something typed, a proposed direction, and the direction the execution
is now following.

**Roles are structural, not cosmetic.** Do not render privileged actions and
rely on a disabled attribute. Viewer (observe, inspect evidence, view
approaches and receipts) · Contributor (+ submit direction, comment, request
control) · Controller (+ pause/resume, approve, create approaches) · Mission
administrator (+ manage participants and roles, end the mission). Final
selection may require a distinct decision permission.

## Visual direction

Conductor's composure, Linear's precision, Figma's multiplayer clarity —
arranged like a quiet engineering control room. Calm, precise, shared,
serious, inspectable, trustworthy. Dense without feeling cramped. Not a
cyberpunk terminal, not a telemetry wall, not an admin dashboard.

**Foundation is deep graphite, not pure black.** Suggested dark tokens —
adjust to existing tokens but preserve the hierarchy:

| Role | Value |
| --- | --- |
| App background | `#0B0D10` |
| Primary plane | `#111419` |
| Elevated plane | `#171B21` |
| Hover | `#1B2028` |
| Selected | `#202633` |
| Border | `rgba(255,255,255,0.08)` |
| Strong border | `rgba(255,255,255,0.14)` |
| Primary text | `#F2F4F7` |
| Secondary text | `#A3A9B3` |
| Muted text | `#6F7682` |

**Semantic accents, used sparingly:** blue `#6E86FF` active execution,
selection, control · violet `#9A7BFF` alternative-approach identity · green
`#45C486` verified evidence or recorded outcome · amber `#E7B15A` unverified,
incomplete, needs attention · red `#E06C75` failed, blocked, denied · gray
completed but not independently verified.

**Never use green merely because an agent completed** — completion and
verification are different states. Accents belong in status dots, thin
borders, branch lines, small badges, verification marks, selected controls,
and critical text. Large colored panels should be rare.

**Layout weight** at a common desktop width: header 52–56px · spine 220–240px ·
canvas fluid and dominant · inspector 300–340px · composer 64–88px. The canvas
must feel like the product; side panels support it. Avoid columns of equal
visual weight. Canvas margins ≈24px, ≈16px between cards, ≈8px inside compact
groups. Constrain narrative width; let comparison structures expand.

**Typography** is a clean interface sans (system, Inter, Geist, SF Pro).
Mission goal 20–24px semibold · screen title 17–20px semibold · card title
14–15px medium · body 13–14px · metadata 11–12px · technical mono 12–13px.
**Monospace only for** paths, commands, branches, model ids, diffs, receipt
ids, event details, and numeric execution evidence. Never ordinary interface
language.

**Borders, depth, motion:** 1px alpha borders, radii 8–10px, minimal shadow,
depth from plane contrast. No thick borders, glow, glass, or neon. Motion
120–180ms, restrained; meaningful on direction queued→applied, control
transfer, fork, approach completion, decision→receipt, evidence state change.
Never continuous pulsing.

**Icons** are simple geometry: circle not started · filled dot active · check
verified · amber diamond needs attention · bar paused · X failed · branch line
divergence · converging line human decision. No robot faces, lightning bolts,
or sparkles — this is engineering authority, not AI theater.

**Empty states never show a giant canvas with centered gray text.** Show the
baseline, the goal, what is available, why the next action matters, and one
primary action. **Loading preserves layout** with skeletons, never a
full-screen spinner. **Errors** explain what failed, what remains safe,
whether work was preserved, and what to do next.

**Light mode** keeps the same semantic hierarchy — warm or neutral off-white
planes, not an inverted afterthought. Dark remains the taste reference.

## Own, borrow, refuse

**Own:** the shared mission as collaboration object · the Decision Spine ·
shared-checkpoint visualization · competing approaches from one execution
state · the evidence-first Decision Room · the submitted→applied direction
lifecycle · the explicit authority baton · accepted handoff · recorded
selection rationale · chosen and rejected approach history · the decision
receipt · replay of human and agent activity · the difference between
completion, verification, decision, and application.

**Borrow:** calm density · clear workspace status · progressive disclosure ·
keyboard navigation · diff-centered review · inline comments returned to the
agent · checks and merge-readiness framing · compact presence · strong empty
and loading states · good command palette · separation of primary work from
utilities.

**Refuse for now:** full code editor · generic Kanban · agent avatar theater ·
model marketplace · generic fleet dashboard · automatic winner scoring · issue
tracker · multi-repository missions · visual workflow builder · analytics
without a decision use case · cloud platform breadth before the loop is
proven · SSO/SCIM · agent persona system.

## Implementation sequence

Do not implement the redesign in one broad change. Before each slice: inspect
the source and contracts, state what existing data already supports, identify
contract additions separately, list every affected surface (desktop, guest,
shared UI, worker, projection, receipt, tests), implement **one vertical
slice**, run the gate, and report what changed, what remains, and what was
deferred. **Never widen the event contract from a renderer component** — see
`skills/novus-extend-event-contract`.

**Slice 1 — Approach surface, existing data only.** Show the baseline. Rename
Attempts→Approaches in customer-facing text. Replace the two-field fork form
with the differentiating-intent flow and an auto-generated label. Remove
duplicated fork explanations and CTAs. Eliminate the empty comparison canvas.
Meaningful approach states. Show the shared checkpoint. Keep choose/apply
behavior and read-only guest construction.

**Slice 2 — First Decision Room.** Behavioral intent, verification, unverified
claims, contested files, unique files, failure evidence, human interventions,
request revision, keep exploring, decision rationale, receipt presentation.

**Slice 3 — Multiplayer authority.** Controller identity, request-control UI,
handoff offer and acceptance, safe-boundary transfer, direction queue with
submitted/queued/applied states, role-aware actions, decision authority.

**Slice 4 — Reliability before pilot.** Fork cleanup, orphaned-approach
recovery, dev-process cleanup, resume-safe usage and budget totals, build/lint/
test/diagnostics receipt coverage, visible cost, renderer test coverage,
signed distributable.

**Slice 5 — Mission Inbox.** Attention-based home; repository secondary.

**Slice 6 — Team pilot surface.** Durable shared sessions, role-aware
invitations, GitHub connection, PR status and required checks, exportable
receipt, team grouping, usage and cost view, stable onboarding and updates.

## Known readiness gaps

Product trust gaps, not cleanup: fork worktrees never cleaned up · interrupted
approaches stuck "running" · dev processes without session-close lifecycle ·
usage and budget resetting after resume · cost calculated but invisible ·
receipts undercounting build and diagnostic verification · missing renderer
test coverage · incomplete clean-machine packaging · incomplete live
multiplayer and forked evaluation runs · atomic handoff without recipient
acceptance · request-control without complete UI · **worktrees are workflow
isolation, not a security boundary** — no process, network, secret, or
resource isolation, and shared Git metadata is reachable.

## Proof

**Reviewer test:** *Can you explain why the selected approach won, what
evidence supported it, who authorized it, and what risk remained?* If they
must read the whole transcript, the Decision Room has failed.

**Participant test:** *Can you tell who is in control, what direction the
agent is following, what needs your attention, and what happens next?* If not,
multiplayer exists technically but not as a product.

Track: time from completion to trusted decision · decisions made without
reading the full transcript · missions with complete verification evidence ·
time from direction submitted to applied · compare-to-selection conversion ·
alternatives per consequential mission · rework after selection · human
attention minutes per accepted change · cost per accepted change · handoffs
successfully accepted · missions with more than one active human.

## The working rule

For any proposed feature: does it help **frame** the mission, make
**multiplayer** operational, help **branch** an approach, help **prove** the
result, help an authorized human **decide**, or make the decision
**reconstructable**? If none, not now.

> Enter the same mission. Direct the work. Branch the approach. Prove the
> result. Decide together.
