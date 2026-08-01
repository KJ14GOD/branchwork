Purpose: Defines what Novus is as a product: principles, customer, domain concepts, workflows, multiplayer behavior, states, scope, and how success is measured. This is where every product term gets its single canonical meaning.
Authoritative for: product principles, customer, problems, use cases, positioning, the harness boundary, the domain model (conceptual), roles and capabilities (policy), the direction and control lifecycles (states and meanings), the mission state model (states and meanings), the complete workflow, scope, non-goals, extension points, roadmap, success metrics.
Not authoritative for: data representation, wire protocol, and enforcement mechanics (ARCHITECTURE.md); visual presentation of any state (DESIGN.md); the Golden V0 workflow narrative (README.md); current status (PROGRESS.md).
Update when: a domain object, lifecycle state, capability, scope line, or metric is added, renamed, or removed. DESIGN.md and ARCHITECTURE.md must be updated in the same change when their derived sections are affected.
Last reviewed: 2026-08-01

# Product

## Principles

1. **The mission is the product.** Not the agent, not the model, not the dashboard. Everything in Novus exists to help several people be responsible for one consequential change.
2. **Multiplayer is operational authority, not decoration.** Presence dots are not multiplayer. Multiplayer is a named controller, server-enforced capabilities, attributed direction, and control that transfers through an explicit, visible handshake.
3. **Evidence over claims.** Novus never says "done" or "verified" on its own authority. It shows what ran, where it ran, what it reported, and who accepted it. A runner's test results are evidence claims attributed to that runner and environment — not ground truth.
4. **The harness is a partner, not a component to rebuild.** Novus operates Claude Code and Codex; it does not reimplement their loops, and it does not promise behavior a harness cannot deliver (see [The harness boundary](#the-harness-boundary)).
5. **Cloud is the default; location is not the identity.** A mission looks and behaves the same whether its execution runs in a Novus-managed cloud workspace or elsewhere. Cloud-first is a priority order, not an architecture constraint (see [Scope](#scope-and-non-goals)).
6. **The record outlives the run.** Every mission produces a receipt that reconstructs who did what, what ran, what changed, and what remains uncertain — durable enough to be reopened months later.
7. **Calm by default.** The product asks for attention only when a human decision is actually needed. It never manufactures urgency, decisions, or comparisons that do not exist.

## Customer

Software teams — initially 2 to 20 engineers — that already use coding agents and want to point them at work that matters, not just disposable fixes. The buyer's problem is not "I need more agents"; it is "I cannot let an agent touch our auth system unless my team can see it, steer it, stop it, and account for it afterward."

Novus is deliberately built for teams that do **not** yet fully trust agents with consequential work. It is the instrument for earning that trust: attributed direction, revocable control, inspectable evidence, durable receipts. Teams that already trust agents completely need less of Novus; teams that will never trust them need none of it.

### The solo mission is still a Novus mission

Most missions will start — and many will end — with one participant. The product must be worth using solo, or the multiplayer promise is a demo. Solo value: cloud execution that survives a closed laptop, the mission state model that always answers "what is happening and what do I do next," verification evidence in one fixed format, and a receipt that lets the author hand the *record* to teammates even when no teammate joined the room. A second participant deepens the product; their absence does not hollow it.

## Problems

1. **Agent work on consequential code is single-player today.** One person runs the harness on their machine; teammates see only the PR at the end. Direction, dead ends, and verification context are lost in a terminal scrollback.
2. **Screenshare-and-Slack collaboration does not scale or survive.** During an incident at 2 a.m., the person with the agent session is a single point of failure. Nobody else can take over; afterward, nobody can reconstruct what was told to the agent and why.
3. **Control is all-or-nothing.** Either you own the terminal or you are a spectator. There is no way to hand a running piece of agent work to a colleague with its full context intact.
4. **Verification is scattered and asserted, not shown.** "Tests pass" lives in a chat message. There is no shared, durable, attributed record of what was checked, where, and what the team accepted despite remaining uncertainty.
5. **Accountability has no substrate.** When agent-produced code breaks, "who directed it, under what instruction, and who accepted the evidence" is unanswerable.

## Use cases

The wedge (see [README.md](README.md#the-wedge)): one consequential coding mission operated together.

- **Incident remediation** — the strongest case. An on-call engineer starts a mission against the affected repo; a teammate in another timezone joins mid-run, reads the same activity and evidence, requests control, and finishes the remediation. The receipt becomes the postmortem's factual backbone.
- **Authentication and authorization changes** — work where a second responsible human is often mandatory policy.
- **Migrations and infrastructure changes** — long-running, verification-heavy, painful to babysit from a laptop; cloud execution plus supervision from anywhere.
- **Risky dependency upgrades and large refactors** — broad diffs where review is the bulk of the work and the review needs the run's context.
- **Cross-functional changes** — implementer and reviewer inhabit the same room from the start instead of meeting at the PR.

Explicitly not the wedge: dozens of parallel agents, generic task boards, disposable one-line fixes. Those flows exist in competitors and are healthy markets; they are not this product's opening claim.

## Positioning

**Novus is the multiplayer control plane for cloud coding agents.**
Emotional promise: *Enter the same mission. Operate the work together.*

The word doing the work is **responsible**. Conductor (conductor.build) is parallel agents for one person, with workspace sharing arriving via its cloud tier. Factory/Droid (factory.ai) is enterprise agent delegation — one user's session continuous across surfaces, with an org-clamped autonomy model, and no documented model for multiple humans steering one session. Hoplite (hoplite.sh) is a keyboard-driven cloud harness with team workspaces but no simultaneous-control model. (Observed as of 2026-08-01; these are facts about their public surfaces, not claims about their roadmaps.) None of them makes *several people responsible for the same agent-driven change* the center of the product. Novus does.

Language rules for all Novus copy and documentation: never "seamless," "single pane of glass," "AI-powered," "supercharge," "orchestrate your agents," or "full visibility." Say the mechanism instead: a controller, a lease, a visible handoff; an attributed event log you can replay; a receipt.

## The harness boundary

The coding harness owns: internal reasoning, context management, model interaction, its native tools, its internal subagents, its implementation loop.

Novus owns: identity, organizations, repositories, missions, participants, roles, cloud workspaces, harness selection, workstreams, executions, presence, direction, control, handoffs, events, changes, verification **evidence and status** (the harness or CI executes verification; Novus owns the durable, attributed record of it), review, pull-request state, receipts, and collaborative history.

Consequences Novus accepts:
- Novus never promises mid-turn control transfer or uniform pause semantics; those depend on what each harness exposes. The product promise is transfer *at a safe execution boundary*, with a defined degraded path when the harness cannot provide one (see [Control](#control)).
- Harness-specific surfaces (permission prompts, plan modes) pass through with attribution rather than being flattened away. The protocol contract is in [ARCHITECTURE.md](ARCHITECTURE.md#harness-protocol).

## Domain model

Conceptual definitions. Each term has exactly one meaning, defined here; data representation lives in [ARCHITECTURE.md](ARCHITECTURE.md#data-model). Objects marked **(V0)** are load-bearing for the Golden V0 workflow; objects marked **(schema-only in V0)** exist in the data model as extension points but get no dedicated UI.

- **User** (V0) — an authenticated person. Agents are never Users; they act within Executions and are attributed as harness actors.
- **Organization** (V0) — the ownership boundary for repositories, missions, members, and policy.
- **OrganizationMember** (V0) — a User's membership in an Organization, with an org-level role (owner, member).
- **Repository** (V0) — a connected GitHub repository, authorized through a GitHub App installation owned by the Organization.
- **Mission** (V0) — the shared objective and collaboration boundary: a goal, success criteria, a repository, participants, control policy, an event history, and at completion a receipt. Missions are the unit of attention, invitation, and record.
- **Participant** (V0) — a (User, Mission) pair with a Role. In V0, participants must be members of the mission's organization; cross-org guests are an extension point.
- **Invitation** (V0) — a mission-scoped, expiring, single-use grant that makes a User a Participant with a stated Role.
- **Role** (V0) — a named bundle of capabilities: Owner, Operator, Contributor, Viewer (see [Roles and capabilities](#roles-and-capabilities)). Fixed archetypes in V0; no custom roles.
- **Capability** (V0) — a single verb a participant may perform, enforced by the server on every mutating command. The interface renders from capabilities; it never grants them.
- **Workstream** (V0) — a named lane of responsibility inside a mission. A workstream owns its control lease, direction queue, and workspace. Every mission has at least one; most have exactly one. A workstream may carry the **approach flag**, marking it as a deliberately created competing implementation for comparison. *Approach is a workstream attribute, not a separate object.* A new execution in the same workstream is a continuation — a retry, follow-up, or harness switch — never an approach. Approaches exist only when a participant explicitly creates one.
- **Execution** (V0) — one harness working a workstream, from start to a terminal state. At most one active execution per workstream. An execution owns its turns, events, and changes.
- **Run / turn** — a lower-level unit inside an execution (a harness turn or tool run), surfaced in the activity feed for legibility. Not addressable by users in V0.
- **Harness** (V0) — a supported coding agent product (Claude Code, Codex in V0) operated through the adapter contract in [ARCHITECTURE.md](ARCHITECTURE.md#harness-protocol).
- **Runner** (V0) — the machine-side program that supervises executions and speaks the runner protocol: a Novus-managed cloud runner in V0; local, enterprise, and third-party runners are conformance targets ([ARCHITECTURE.md](ARCHITECTURE.md#runner-plane)).
- **Workspace** (V0) — a provisioned working environment (repository checkout, dependencies, scoped credentials) on a runner. One workspace per workstream, reused across that workstream's executions so its changes accumulate in one place.
- **Direction** (V0) — an attributed instruction submitted to a workstream and consumed by an execution, with the lifecycle in [Direction](#direction).
- **ControlLease** (V0) — the server-issued grant that makes exactly one participant the controller of a workstream (see [Control](#control)).
- **ControlRequest** (V0) — a participant's standing, visible request to become controller.
- **HandoffOffer** (V0) — the controller's explicit offer of control to a named participant, requiring acceptance.
- **Event** (V0) — one attributed, durable entry in the mission's append-only history. Every state change in this document is an event. Representation in [ARCHITECTURE.md](ARCHITECTURE.md#event-model).
- **FileChange** (V0) — repository diff content produced by an execution, presented per file.
- **VerificationCheck** (V0) — one named check (test run, typecheck, build, lint, manual confirmation) with an outcome, attributed to the environment that ran it.
- **Artifact** (V0) — a non-repository output attached to the mission: logs, screenshots, preview URLs, exported reports.
- **Evidence** (V0) — the collective term for a mission's FileChanges, VerificationChecks, and Artifacts: attributed records of what happened and where, never bare assertions.
- **Review** (V0) — a participant's recorded judgment on the current result: comments, concerns, a revision request, or acceptance.
- **PullRequest** (V0) — the mission's GitHub pull request, created or adopted by Novus and tracked as mission state.
- **Receipt** (V0) — the mission's durable record: a deterministic projection of the event history answering who did what, what ran, what changed, what was verified, and what remains uncertain. One receipt per mission, snapshotted at completion and reconstructible from events at any time.

## Roles and capabilities

Capabilities are the enforcement unit. A participant's effective capabilities are **role capabilities ∪ lease-granted capabilities**: holding a workstream's control lease temporarily grants the steering verbs for that workstream, whatever the holder's role. This formula is the crux of server-enforced multiplayer; enforcement mechanics are in [ARCHITECTURE.md](ARCHITECTURE.md#authorization).

| Capability | Owner | Operator | Contributor | Viewer | Lease holder |
| --- | :-: | :-: | :-: | :-: | :-: |
| `mission.view`, `receipt.view` | ✓ | ✓ | ✓ | ✓ | — |
| `mission.create`, `mission.invite`, `mission.close` | ✓ | — | — | — | — |
| `direction.submit` | ✓ | ✓ | ✓ | — | — |
| `direction.apply` (steer, pause, resume) | — | — | — | — | ✓ |
| `approval.respond` (approve or deny a harness approval request) | — | — | — | — | ✓ |
| `execution.start` | ✓ | ✓ | — | — | — |
| `execution.stop` | ✓ | ✓ | ✓ | — | ✓ |
| `control.request` | ✓ | ✓ | ✓ | — | — |
| `control.offer` (and withdraw) | — | — | — | — | ✓ |
| `control.accept` | ✓ | ✓ | ✓ | — | — |
| `control.revoke` | ✓ | — | — | — | — |
| `review.comment` | ✓ | ✓ | ✓ | — | — |
| `review.approve` (accept result, request revision) | ✓ | ✓ | — | — | — |
| `pr.manage` | ✓ | ✓ | — | — | — |

Deliberate choices:
- **Stopping is broad, steering is narrow.** Any non-viewer participant may stop a running execution (`execution.stop`); a wrong or dangerous direction must not be able to run until a handoff completes. Only the lease holder steers.
- **Non-controllers are not spectators.** Contributor verbs — submit direction to the queue, request control, comment on evidence, stop the work — are real, server-enforced operations, not chat.
- Direction submitted by a non-controller queues automatically; only the controller applies, supersedes, or rejects it. Submission is never silently dropped.

## Multiplayer behavior

Multiplayer requirements, all server-enforced and all durable except presence: durable participants, live presence, named identities, explicit roles, visible controller, requests for control, handoff offers with acceptance or decline, transfer at a safe execution boundary, a direction lifecycle, connection state and reconnection, shared evidence, durable attribution.

The interface must always answer: Who is here? Who is in control? What is the agent doing? Which direction is it following? What requires attention? What changed? What was verified? What happens next? Presentation is [DESIGN.md](DESIGN.md)'s responsibility; the answers come from the state defined here.

### Control

Control is modeled as three cooperating machines, not one. Mixing them was a source of contradictions in the prototype.

**ControlLease** — one per workstream; exactly one holder at a time; the holder is "the controller." Mission-level "controller" is a derived display defined for the single-workstream case; a room with several workstreams answers "who is in control?" per lane.
States: `held` → `releasing` (transfer accepted, waiting for a safe boundary) → `transferred` (new lease issued to the recipient) or `released` (no recipient; workstream has no controller until claimed). Also: `expired` (holder's heartbeat lapsed past the lease TTL) and `revoked` (Owner force-take; always available, always logged, never silent).

**ControlRequest** — a non-controller asks for control.
States: `open` → `fulfilled` (a transfer to the requester completed) | `declined` (controller said no) | `withdrawn` (requester cancelled) | `expired` (TTL) | `superseded` (control transferred to someone else; all other open requests close with this reason).

**HandoffOffer** — the controller offers control to a named participant. An offer may exist without a prior request; a request never auto-creates an offer. A **handoff** is the completed transfer of control that a HandoffOffer initiates.
States: `open` → `accepted` → `waiting_for_boundary` → `completed`. Also: `declined` (recipient), `withdrawn` (controller, before acceptance), `expired` (TTL), `failed` (the execution errored or stopped before a boundary was reached; the lease stays with the original holder and the failure is visible).

**Safe execution boundary** — a point where the harness is awaiting input: turn complete, permission prompt pending, paused, or execution terminal. The runner, not the control plane, declares boundaries, because only the runner knows harness state. A paused execution and an idle workstream are always at a boundary, so those transfers complete immediately. If no boundary arrives within the transfer timeout, both parties see the stall and the controller (or Owner) may force-interrupt — an explicit, logged action that ends the current turn. Transfer is never silent and never mid-tool-call.

Rules that prevent deadlock and races:
- The server validates every lease transition against current durable state (mechanics in [ARCHITECTURE.md](ARCHITECTURE.md#authorization)); two clients can never both believe they hold control.
- The lease is a durable grant, not a connection. A disconnected controller still holds the lease until TTL expiry. On expiry the workstream has no controller: the execution pauses at its next boundary, every participant sees "no controller," and any participant with `control.request` may claim the lease: a claim is a ControlRequest made against an unheld lease, which the server fulfills immediately — first accepted wins. The Owner may revoke and reassign at any time.
- An accepted offer survives the recipient's disconnection; control is granted at the boundary regardless, because the grant is durable.
- Simultaneous requests both stay open and visible; the controller chooses. A completed transfer closes all other open requests as `superseded`.

### Direction

Direction is the attributed instruction stream. Lifecycle:

- **Drafted** — client-local only; never persisted or synced.
- **Submitted** — durably recorded, attributed, visible to all participants.
- **Queued** — accepted into the workstream's queue, ordered, waiting for the execution to reach a point where it can consume direction.
- **Applied** — delivered to the harness *and acknowledged by it* at a boundary it supports (start of next turn, or mid-turn steer where the harness allows it). Applied is marked on harness acknowledgment, never on send — "which direction is it following?" must never lie.
- **Superseded** — replaced by a later direction before application. Only Submitted or Queued direction can be superseded; Applied direction is history and can only be followed, never rewritten.
- **Rejected** — declined by the controller (or by mission policy), with the reason recorded.
- **Cancelled** — withdrawn by its author before application.

Transitions: queueing is automatic — Submitted becomes Queued on acceptance of the write; what is gated is application. The controller's own direction applies at the next receptive point without further action; a non-controller's direction applies only when the lease holder applies it. The author may cancel while Submitted/Queued; the lease holder applies, supersedes, or rejects; the system moves Queued → Applied on harness acknowledgment. Every transition is an event.

### Presence and connection

Presence (who is in the room, focus, typing) is ephemeral and never appears in receipts. Connection state is per-participant and visible: connected, reconnecting, offline. Reconnection restores the room from durable state; nothing a participant is entitled to see depends on having been online when it happened. Rendering rules are in [DESIGN.md](DESIGN.md#component-behavior).

## The mission state model

The states below are the canonical vocabulary; [DESIGN.md](DESIGN.md#state-presentation) defines the presentation of each and may not add, rename, or merge states. A mission has one **primary state**; the conditions marked *(overlay)* can coexist with a primary state and demand attention without replacing it. In a mission with several workstreams, the primary state is a projection over workstream and execution states with fixed precedence: attention-demanding states, then running, then waiting — mirroring how "the controller" is derived for the single-workstream case.

| State | Meaning — entered when / leaves when |
| --- | --- |
| New mission | Created; no workspace yet. Leaves on provisioning start. |
| Provisioning workspace | Execution provider is preparing the workspace. Leaves on ready or failure. |
| Workspace failed | Provisioning or the workspace itself failed; provider error attached. Retry provisions a new workspace — never silent reuse. |
| Ready for instruction | Workspace ready, no active execution. Leaves when an execution starts. |
| Agent starting | Execution accepted, harness booting. |
| Agent running | Harness actively working; activity streaming. |
| Needs direction | Harness is waiting for input at a boundary and the queue is empty. |
| Needs approval | Harness surfaced a permission/approval request that mission policy routes to the controller. |
| Direction queued *(overlay)* | Direction is waiting to be applied at the next receptive point. |
| Control requested *(overlay)* | An open ControlRequest exists. |
| Handoff offered *(overlay)* | An open HandoffOffer awaits the recipient. |
| Handoff waiting for boundary *(overlay)* | An accepted transfer awaits a safe boundary. |
| Paused | Controller paused the execution; always a safe boundary. For a harness that cannot resume, Paused is realized as stopped-at-boundary and Resume starts a continuation execution in the same workstream. |
| Verification running | Checks are executing in the workspace or CI. |
| Verification failed | One or more checks reported failure; evidence attached. |
| Work completed but unverified | Execution finished; no or incomplete verification evidence. An honest, uncomfortable state — never dressed up as done. |
| Ready for review | Changes and verification evidence complete; awaiting review. |
| Revision requested | A reviewer requested changes; the request is the next direction's context. |
| Pull request open | PR created/adopted; tracking checks, reviews, mergeability. |
| Completed | Result accepted, PR resolved, receipt snapshotted. Terminal. |
| Cancelled | Deliberately ended without acceptance; receipt records what happened and what was abandoned. Terminal. |
| Reconnecting *(overlay)* | This client lost its connection; room is stale until restored. |
| Runner offline *(overlay)* | The runner's connection dropped; execution state is last-known; events will backfill on reconnect. |

Every state presents at most one primary action — never two — defined per state in [DESIGN.md](DESIGN.md#state-presentation); states of unattended progress deliberately present none, and their next action arrives with the next state. Reopening a mission in a terminal state opens its history and receipt; terminal states never resume.

## The complete workflow

The canonical 20-step narrative lives in [README.md](README.md#the-golden-v0-workflow). Elaboration by phase:

1. **Open** (steps 1–4): Kartik authenticates, connects a repository through the org's GitHub App installation, creates a mission with a goal and success criteria, picks a harness. Mission: *New mission*. Kartik is Owner and holds the first workstream's lease by default.
2. **Provision** (steps 5–6): the execution provider prepares a workspace (*Provisioning workspace* → *Ready for instruction*); Kartik's initial direction starts the first execution (*Agent starting* → *Agent running*).
3. **Join** (steps 7–9): Maya redeems a mission invitation as Contributor. She sees the identical room state, reads the activity, and submits direction — which queues, visibly, attributed to her.
4. **Handoff** (steps 10–13): Maya opens a ControlRequest; Kartik responds with a HandoffOffer; Maya accepts; the transfer completes at the next safe boundary. The room shows every step of that handshake.
5. **Operate** (step 14): the controller steers, pauses, resumes, or stops. Every action is an attributed event.
6. **Evidence** (steps 15–16): the harness changes the repository and runs verification; both participants inspect the same diff and the same check ledger.
7. **Resolve** (steps 17–18): review yields revision requests (back to phase 5) or acceptance; Novus creates or adopts the pull request and tracks it to resolution. Merging happens on GitHub, by humans, in V0 — Novus tracks the merge and never performs it.
8. **Record** (steps 19–20): the mission completes; the receipt is snapshotted; reopening the mission reconstructs the entire collaboration from the event history.

## Scope and non-goals

### V0 scope

- One organization type, fixed roles, GitHub only.
- Two harnesses: Claude Code and Codex. The adapter contract is written for N harnesses; V0 ships two.
- Cloud execution via one Novus-managed execution provider is the default and the demo. The runner protocol is the conformance target that keeps local and enterprise runners possible; V0 does not ship them.
- One workstream per mission created by default; additional workstreams and the approach flag exist in the data model, and creating them is possible but plain — the UI never pushes parallelism.
- Three surfaces: Missions, Mission Room, Review ([DESIGN.md](DESIGN.md#information-architecture)).
- Desktop and browser clients sharing one client architecture.

### Non-goals (hard lines, not priorities)

A full IDE; a generic Kanban board; a model marketplace; automatic approach ranking or synthesis of competing implementations; dozens-of-agents fleet views; multi-repository missions; organization analytics; billing complexity; SSO/SCIM; mobile-native applications; a visual workflow builder; agent personas; building a foundation model; replacing GitHub; rebuilding Claude Code or Codex; an integration catalog. The architecture may keep honest extension points for some of these; the UI must never expose fictional future capabilities.

### Extension points (schema or protocol exists; no V0 UI)

Additional harnesses (Droid, OpenCode); local, enterprise, and third-party execution providers; cross-org mission guests; org-definable policy (autonomy ceilings, retention); API-driven mission creation and automation; approach comparison workflows; org-level audit export.

## Roadmap

1. **M0 — Foundation** (this repository state): canonical documentation, contracts, decisions. No application capability.
2. **M1 — Golden V0**: the twenty steps executed by two real clients against a real control plane, one cloud execution provider, two harnesses. This milestone is the definition of "the product exists."
3. **M2 — Trust hardening**: lease expiry/revocation ergonomics, receipt export, verification evidence from CI, review depth, reconnection polish.
4. **M3 — Second surface of value**: chosen from evidence (candidates: local runner conformance, approach comparison, API/automation) — recorded in [DECISIONS.md](DECISIONS.md) when chosen, not presumed here.

## Success metrics

Wedge-fit metrics, not vanity metrics:

- **Active-multiplayer share**: missions with ≥2 participants who *acted* (submitted direction, held control, or recorded review) / all missions.
- **Baton reality**: completed control transfers per multi-participant mission.
- **Contribution reality**: non-controller directions that reached Applied.
- **Record audience**: % of completed missions whose receipt was opened by someone other than the creator.
- **Loop tightness**: median time from *Verification failed* to next Applied direction.
- **Return rate**: teams running a second consequential mission within 30 days.
- **Anti-metric watched honestly**: solo-mission share. If >90% of missions stay solo after M2, the positioning — not merely the product — is wrong, and that finding goes in DECISIONS.md.
