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

The word doing the work is **responsible** — not "together." Observed as of 2026-08-01 (facts about public surfaces, not claims about roadmaps): Conductor (conductor.build) has made cloud agent workspaces collaborative — shareable workspace links, presence, following other participants, prompting agents together in real time. Factory/Droid (factory.ai) is enterprise agent delegation: one user's session continuous across surfaces, an org-clamped autonomy model, no documented model for multiple humans steering one session. Hoplite (hoplite.sh) is a keyboard-driven cloud harness with team workspaces but no simultaneous-control model.

So the differentiation is **not** "they are single-player; Novus is multiplayer." It is: others make shared *access* to agent workspaces; Novus specializes in explicit team *authority* — attributed direction, a control lease with transfer at safe boundaries, verification evidence in one durable format, and reconstructable responsibility for consequential changes. A narrower wedge, and a defensible one: none of them makes authority, evidence, and responsibility the product.

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
- **Repository** (V0) — a connected code repository: either a GitHub repository authorized through a GitHub App installation owned by the Organization, or a folder on a user's own machine registered as a local repository (D-032). Local git operations run in the desktop application; the control plane records identity and revisions and never touches the folder.
- **Mission** (V0) — the shared objective and collaboration boundary: a goal, success criteria, a repository, participants, control policy, an event history, and at completion a receipt. Missions are the unit of attention, invitation, and record.
- **Participant** (V0) — a (User, Mission) pair with a Role. In V0, participants must be members of the mission's organization; cross-org guests are an extension point.
- **Invitation** (V0) — a mission-scoped, expiring, single-use grant that makes a User a Participant with a stated Role.
- **Role** (V0) — a named bundle of capabilities within one authority scope. Organization roles: org owner, org member. Mission roles: Mission Admin, Operator, Contributor, Viewer (see [Roles and capabilities](#roles-and-capabilities)). Fixed archetypes in V0; no custom roles. "Controller" is not a role — it names whoever currently holds a workstream's ControlLease.
- **Capability** (V0) — a single verb a participant may perform, enforced by the server on every mutating command. The interface renders from capabilities; it never grants them.
- **Workstream** (V0) — a named lane of responsibility inside a mission. A workstream owns its dedicated mission branch, recorded base commit, control lease, direction queue, and workspace, and holds one or more **Sessions** — parallel conversations that share all of it (D-083). Every mission has at least one; most have exactly one. A workstream carries a **permission profile** (D-115) — the lane's standing answer policy for its harness's permission questions, `manual` by default, chosen by a person with `policy.set`, event-recorded, and pinned into each turn at dispatch so a change speaks from the next turn, never into a running one. A workstream also carries its **enabled skills** (D-118), **enabled slash commands** (D-187), and **enabled MCP servers** (D-119) — the project's own declarations a person switched on for this lane, each pinned to the exact content that was reviewed; none by default, and a fork starts with none, like the profile. A workstream may carry the **approach flag**, marking it as a deliberately created competing implementation for comparison. *Approach is a workstream attribute, not a separate object.* A new execution in the same workstream is a continuation — a retry, follow-up, or harness switch — never an approach. Approaches exist only when a participant explicitly creates one, and creating one requires a stated **intent**: one sentence saying how this attempt is meant to differ from the one it forks. An approach records the **origin revision** it forked from — the last checkpoint the workstream it was created beside *shares* with that workstream's own origin lineage: the latest checkpoint of the mission's first lane, and an approach's own recorded origin rather than its later work — so two approaches are comparable because they started from the same place, and work that exists only in one lane never silently seeds another (D-079). The person creating an approach is shown that exact checkpoint before creating; if no shared checkpoint exists, creation is refused with the reason rather than forked from a guess.
- **Session** (V0) — a durable, titled conversation with the harness inside one Workstream. Sessions let several threads of work — implement, add tests, review — share one approach's branch, workspace, files, and control lease without sharing a transcript: each session keeps its own direction thread, its own executions, and its own harness conversation continuity. Every workstream has at least one, created with it. A further session is created words-first, like a mission (D-077, D-083): the first direction typed into a new session creates it and titles it, and abandoning the empty surface creates nothing — so there is no `session.create` capability, because creating a session *is* `direction.submit`. A new session may **continue from** one or more of its lane's existing sessions (D-173): each chosen chat's feed is projected to a markdown transcript — a deterministic rendering of its record, never a model's summary — stored as a `transcript` Artifact whose sessionId names the *source* chat, and carried on the new session's first direction through the ordinary attachment road. The word is *continue*, never *handoff*: handoff already names the control baton's transfer between people. Continuation stays inside one lane — sessions already share everything but the transcript, so the transcript is the one honest thing left to carry — and never crosses approaches, whose deliberate clean start (profile, skills, MCP all reset at fork) exists precisely so competing attempts stay uncontaminated. A session has no branch, worktree, workspace, or lease of its own. A session may carry a **scope** — a declared set of file patterns it owns, granted and revoked by the baton holder (D-097): inside its scope its write turns act without asking, outside it they are refused, and its checkpoints commit only its own paths. Sessions **take turns for the files they share**: an unscoped session's turn takes the whole workspace exclusively, exactly as before scopes existed; sessions whose scopes are provably disjoint run write turns simultaneously in the one checkout, because their files are not shared; overlapping or unprovable scopes wait, visibly, with the running session named — never two agents writing one file (D-083, D-097). A read-only turn runs alongside any of it (D-095). When a lane's parallel turns drain, the declared checks run once against the settled result; unattributed leftover changes block that pass by name until a person settles them.
- **Decision** (V0) — a participant's recorded choice of one workstream's result, naming the workstream, the exact checkpoint chosen, a **rationale in their own words**, the risks they accepted, and the verification that was still outstanding when they chose. A decision is a judgment, never a computation: Novus scores nothing, ranks nothing, and declares no winner. **Choosing is not applying.** A decision says what a team decided; publishing that result is a separate act that can be prepared, refused, or fail, and the mission says which of the two has happened. A later decision supersedes an earlier one and never erases it. **A merge fulfils a decision, not the mission** (D-207): once the published request has merged and the workstream checkpoints again, that decision is the mission's history — the work reads as work again, and the next checkpoint is decided and published anew on the same branch.
- **Execution** (V0) — one harness working a workstream, from start to a terminal state. Each execution belongs to exactly one Session and carries an **access**: `write`, the ordinary turn, or `read`, a turn that may look and speak but never change the workstream (D-095). At most one active *write* execution per workstream — the worktree has one honest writer — and at most one active execution per Session, whatever its access, because a Session's turns share one harness transcript. A read execution runs alongside the write turn: the baton holder starts it instead of queueing, it is denied every privileged act, records no checkpoint, and is never a safe transfer boundary. An execution owns its turns, events, and changes.
- **Run / turn** — a lower-level unit inside an execution (a harness turn or tool run), surfaced in the activity feed for legibility. Not addressable by users in V0.
- **Harness** (V0) — a supported coding agent product (Claude Code, Codex in V0) operated through the adapter contract in [ARCHITECTURE.md](ARCHITECTURE.md#harness-protocol).
- **Runner** (V0) — the machine-side program that supervises executions and speaks the runner protocol. The first shipped runner is the host desktop itself, registered per workstream and authenticated with its own scoped credential (D-035); the Novus-managed cloud runner and enterprise and third-party runners speak the same protocol ([ARCHITECTURE.md](ARCHITECTURE.md#runner-plane)).
- **Workspace** (V0) — a provisioned working environment (the workstream branch's working tree, dependencies, scoped credentials) on a runner. A workspace is **runnable** only once its project has said how: a setup command, named run commands, and named verification commands, declared in the repository and layered with machine-local values (D-040). Until then it is honestly *not ready*, because a fresh worktree holds tracked files and nothing else. The runner publishes what the project declares so every participant sees the same commands, and a command a participant authorizes is pinned to the version they authorized rather than to whatever the file says when it runs (D-043). A run command that declared how it becomes ready is *starting* until that signal answers — a process existing is not a claim that an application is serving (D-045). One active workspace per workstream, reused across that workstream's executions so its changes accumulate in one place. Its location may be cloud, local, or customer-managed; the first shipped workspace is a dedicated git worktree on the host machine (D-032), and the user's own checkout is never touched. The workspace is resumable execution state, not the permanent system of record.
- **Direction** (V0) — an attributed instruction submitted to a Session of a workstream and consumed by an execution, with the lifecycle in [Direction](#direction). A direction may carry **attached files** (D-150, D-151, D-153) — images and PDFs the model reads directly, and any other file, placed in the workspace for the agent to open — Artifacts a person supplied rather than Novus captured, bounded in number and size, handed to the harness with the words.
- **ControlLease** (V0) — the server-issued grant that makes exactly one participant the controller of a workstream (see [Control](#control)).
- **ControlRequest** (V0) — a participant's standing, visible request to become controller.
- **HandoffOffer** (V0) — the controller's explicit offer of control to a named participant, requiring acceptance.
- **Event** (V0) — one attributed, durable entry in the mission's append-only history. Every state change in this document is an event. Representation in [ARCHITECTURE.md](ARCHITECTURE.md#event-model).
- **FileChange** (V0) — repository diff content produced by an execution, presented per file.
- **VerificationCheck** (V0) — one named check (test run, typecheck, build, lint, manual confirmation) with an outcome, attributed to the environment that ran it, to **who caused it**, and to the **exact revision it proves**. Its origin is one of: *harness-observed* (Novus watched the agent run it), *participant-run* (a named person invoked a saved check), *automatic* (Novus ran the project's own declared checks after a checkpoint that changed files — nobody pressed Run, and the record says so; a project declines with `autoVerify = false` — D-082), or *external* (CI). A check proves the checkpoint it ran against and nothing later: once the workspace moves past that revision the result becomes **stale** — still true history, no longer current evidence.
- **Artifact** (V0) — a non-repository output preserved as mission evidence: screenshots and recordings captured from the running application's Preview (D-122), **images and documents a person attached to a direction** (D-150, D-151), **transcripts — deterministic projections of one conversation's record, carried into a sibling chat** (D-173), and later logs and exported reports. An artifact is **immutable once captured** — its content digest is verified before it may read as evidence, and nothing can rewrite the bytes afterwards — and carries its provenance: which lane, which conversation and execution *when honestly attributable* (a person's own capture belongs to no chat and is never assigned to one), which running process and validated origin, the workspace revision at capture with uncommitted changes stated, who or what initiated it, and when. An attached image carries none of that capture provenance and does not pretend to: it is recorded as **supplied**, because Novus photographed nothing and a record that said otherwise would be exactly the fabrication this object exists to prevent. Its lifecycle is `pending → available` (or `interrupted`, a recording whose bytes are real but whose ending was not its own Stop) or `failed`, with a reason; only `available` and `interrupted` are ever presented as evidence. Attaching an artifact beside a check, a decision, or a pull request changes the relationship, never the artifact, and every attachment change is an attributed event. A screenshot proves what the preview displayed at that revision and time; it never proves the application is correct, and no surface may claim otherwise.
- **Evidence** (V0) — the collective term for a mission's FileChanges, VerificationChecks, and Artifacts: attributed records of what happened and where, never bare assertions.
- **Review** (V0) — a participant's recorded judgment on the current result: comments, concerns, a revision request, or acceptance.
- **PullRequest** (V0) — a GitHub pull request the mission opened, created or adopted by Novus and tracked as mission state. A mission opens as many as its work earns (D-207) — one per decision, at most one open at a time per workstream — and keeps every one, merged or closed, as its publication story.
- **Receipt** (V0) — the mission's durable record: a deterministic projection of the event history answering who did what, what ran, what changed, what was verified, and what remains uncertain. One receipt per mission, snapshotted at completion and reconstructible from events at any time.

## Roles and capabilities

Capabilities are the enforcement unit, and they live in two scopes that never mix: **organization capabilities** (held through org roles, exercised before and around missions) and **mission capabilities** (held through mission roles and the lease, exercised inside a mission). This resolves the bootstrap question cleanly: creating a mission is an org act — there are no participants yet — and the creator becomes that mission's Mission Admin.

**Organization capabilities** (org roles: org owner, org member):

| Capability | Org owner | Org member |
| --- | :-: | :-: |
| `org.mission.create` (creator becomes Mission Admin) | ✓ | ✓ |
| `org.repo.connect` | ✓ | — |
| `org.harness.credentials` (configure provider/harness credentials) | ✓ | — |
| `org.members.manage` | ✓ | — |
| `org.policy.configure` (execution policy, retention) | ✓ | — |

**Mission capabilities.** A participant's effective mission capabilities are **role capabilities ∪ lease-granted capabilities**: holding a workstream's control lease temporarily grants the operating verbs for that workstream, whatever the holder's role. This formula is the crux of server-enforced multiplayer; enforcement mechanics are in [ARCHITECTURE.md](ARCHITECTURE.md#authorization). Each capability is one separately enforceable verb — steering, pausing, and resuming are distinct actions with distinct server routes, never bundled.

| Capability | Mission Admin | Operator | Contributor | Viewer | Lease holder |
| --- | :-: | :-: | :-: | :-: | :-: |
| `mission.view`, `receipt.view` | ✓ | ✓ | ✓ | ✓ | — |
| `mission.invite` | ✓ | — | — | — | — |
| `mission.archive` (file a mission away, and restore it) | ✓ | — | — | — | — |
| `mission.close` (end a mission's work — D-121: complete it, gated on a standing decision and a resolved pull request, or cancel it; the receipt is snapshotted, and archival remains a different act) | ✓ | — | — | — | — |
| `direction.submit` | ✓ | ✓ | ✓ | — | — |
| `direction.apply` (apply, supersede, or reject queued direction) | — | — | — | — | ✓ |
| `execution.start` | ✓ | ✓ | — | — | ✓ |
| `approach.create` (start a competing approach beside this one) | ✓ | ✓ | — | — | — |
| `execution.pause`, `execution.resume` | — | — | — | — | ✓ |
| `workspace.sync` (apply a visible remote update at a safe boundary) | — | — | — | — | ✓ |
| `base.sync` (follow a moved base: merge its new tip into every lane and move the pin — D-144) | ✓ | ✓ | — | — | — |
| `execution.stop` | ✓ | ✓ | ✓ | — | ✓ |
| `force_interrupt` (declare a turn dead after its stop went unanswered; refused while the ordinary stop still has a claim to work) | ✓ | — | — | — | ✓ |
| `workspace.command` (invoke a command the project declared: setup, run, verification) | ✓ | ✓ | — | — | ✓ |
| `artifact.capture` (capture a screenshot or recording from the lane's live Preview — D-122) | ✓ | ✓ | — | — | ✓ |
| `artifact.attach` (attach or detach an artifact as evidence beside a check or pull request — D-122) | ✓ | ✓ | — | — | — |
| `approval.respond` (approve or deny a harness approval request) | — | — | — | — | ✓ |
| `policy.set` (set a lane's permission profile — D-115; `dont_ask` is Mission Admin's alone, and every set of it is acknowledged and recorded) | ✓ | ✓ | — | — | — |
| `skills.set` (organize a lane's extensions — D-195; the team's own label vocabulary and what each extension wears. It gated skill enablement until D-193 removed enablement altogether) | ✓ | ✓ | — | — | — |
| `mcp.set` (enable a project's MCP servers on a lane — D-119; new tool surface, so Mission Admin's alone) | ✓ | — | — | — | — |
| `control.request` | ✓ | ✓ | ✓ | — | — |
| `control.offer` (and withdraw) | — | — | — | — | ✓ |
| `control.accept` | ✓ | ✓ | ✓ | — | — |
| `control.revoke` | ✓ | — | — | — | — |
| `review.comment` | ✓ | ✓ | ✓ | — | — |
| `review.approve` (record a decision, request revision) | ✓ | ✓ | — | — | — |
| `pr.manage` | ✓ | ✓ | — | — | — |

Deliberate choices:
- **Stopping is broad, operating is narrow.** Any non-viewer participant may stop a running execution (`execution.stop`); a wrong or dangerous direction must not be able to run until a handoff completes. Only the lease holder steers, pauses, resumes, and answers approvals.
- **Forking the work is a mission act, not an operating one.** `approach.create` makes a *sibling* workstream with its own branch, workspace, and lease — it does not steer the workstream it forks — so it is held by role and never granted by the baton. `review.approve` covers both halves of resolving the work: recording a decision, and asking for a revision instead.
- **The lease starts the work it authorizes.** An applied direction with no active execution has to be able to run, so the lease grants `execution.start` for its workstream whatever the holder's role (D-034). Starting an execution as a role capability remains an Operator-and-above act for anyone who is not the controller.
- **Controlling a mission is not owning the host machine** (D-042). `workspace.command` invokes commands *the project itself declared* and nothing else, pinned to the version the participant authorized (D-043). An interactive shell on a workspace that lives on someone's laptop is never granted by the lease, by a role, or by anything the interface can offer; it belongs to the person whose machine it is. So does supplying a secret value: it is an act at the machine that has the value, with no route through the control plane (D-044).
- **What gets asked is policy; who answers is the baton.** A lane's **permission profile** (D-115) is Novus's standing answer policy for the harness's permission questions — `plan`, `manual` (the default), `accept_edits`, `auto`, or `dont_ask` — applied by Novus at the runner, on the record, act by act. The harness always asks over the pinned channel (D-062); a profile only changes who answers, so there is deliberately no `bypass` and no profile weakens any capability in this table. Setting one is `policy.set`, role-held and never lease-granted, like `approach.create`; `dont_ask` — which answers shell commands too — is Mission Admin's alone and is set only with its stated warning acknowledged, which is recorded verbatim.
- **A skill is instructions, never authority** (D-118, D-193). A project's own skills — procedures its team wrote into the repository — and the runner machine's own are **carried into every turn**, and each turn's record names what it carried and the exact content that ran. Carrying one grants nothing: every tool call still asks under the lane's permission profile, and the channels that could grant (hooks, MCP servers, settings) stay outside the boundary (D-062, D-072). A project's **slash commands** ride the same road and appear in the composer's / menu beside its skills and the harness's own commands. What a turn was handed is a fact on the record rather than a permission asked in advance — the trade D-193 states, and the one place it does not apply is an **MCP server**, which is new tool surface rather than instructions and keeps its Mission Admin enablement (D-119). Collectively these are the lane's **extensions** (D-189): everything the harness is handed beyond the repository, presented as one surface, each group saying where it came from (D-190). An extension's **origin** is its collection — repository or machine, intrinsic and uneditable — while a **label** is the organization's own word for it (D-195): many per extension, named and coloured by people, shared across the team, and organizational only. No label changes what reaches a turn.
- **An MCP server is new tool surface, and its tools are always a person's question** (D-119). A project may declare MCP servers; only what a Mission Admin enabled — reviewed field for field, at a pinned digest — exists to the harness, carried as a strict configuration Novus authors. An enabled server's tools act through effects their requests do not declare — a shell command's problem exactly — so every call still asks a person under every permission profile short of `dont_ask`. A remote server must be reachable only over https away from this machine, with no credentials in its address, or it cannot be published at all. This is project-declared harness tooling under the room's governance, not an integration catalog — the non-goal stands. The runner **machine's own** user-level servers join under one more key (D-198): published as redacted summaries — env variable names, never values — and enabled only by a caller who is both the machine's owner and holds `mcp.set`, with the consequence acknowledged in a recorded sentence, because a machine server acts as its owner and, once on, answers any participant's direction. Secret values never leave the machine: the digest pins the full local declaration, and the composed config is written where the values already live. The harness's claude.ai account connectors live in no file a runner can read and are therefore stated as uncarryable rather than half-trusted.
- **Capturing is an operating act; presenting evidence is a review act** (D-122). `artifact.capture` is tiered exactly as `workspace.command`: the lane's live preview exists only on the machine holding its workspace, and capturing what it displays is part of operating that workspace, so the lease grants it. `artifact.attach` changes what the record presents as evidence — the `review.approve` kind of act — so it is role-held and never lease-granted. An **agent-requested capture** is never a hidden capability (D-123): the request rides the same approval machinery every tool call rides, a person answers it under the lane's permission profile, and the server enforces every condition a person's own capture faces — no live validated preview, no capture, whoever asked. Dangerous or unattended profiles grant no additional capture authority beyond answering that question on the record. An **agent-requested push** works identically (D-140): the agent may ask to push the lane's latest checkpoint to its own branch, a person answers on the record, and the push that follows is the same governed one publishing uses — mission branch only, never forced, per-operation credential. Sharing the branch is what the agent may request; opening a pull request remains a person's own act, because a pull request asks humans for review under a stated rationale.
- Direction submitted by a non-controller queues automatically; only the controller applies, supersedes, or rejects it. Submission is never silently dropped.

## Multiplayer behavior

Multiplayer requirements, all server-enforced and all durable except presence: durable participants, live presence, named identities, explicit roles, visible controller, requests for control, handoff offers with acceptance or decline, transfer at a safe execution boundary, a direction lifecycle, connection state and reconnection, shared evidence, durable attribution.

The interface must always answer: Who is here? Who is in control? What is the agent doing? Which direction is it following? What requires attention? What changed? What was verified? What happens next? Presentation is [DESIGN.md](DESIGN.md)'s responsibility; the answers come from the state defined here.

### Control

Control is modeled as three cooperating machines, not one. Mixing them was a source of contradictions in the prototype.

**ControlLease** — one per workstream; exactly one holder at a time; the holder is "the controller." Mission-level "controller" is a derived display defined for the single-workstream case; a room with several workstreams answers "who is in control?" per lane.
States: `held` → `releasing` (transfer accepted, waiting for a safe boundary) → `transferred` (new lease issued to the recipient) or `released` (no recipient; workstream has no controller until claimed). Also: `expired` (holder's heartbeat lapsed past the lease TTL) and `revoked` (Mission Admin force-take; always available, always logged, never silent).

**ControlRequest** — a non-controller asks for control.
States: `open` → `fulfilled` (a transfer to the requester completed) | `declined` (controller said no) | `withdrawn` (requester cancelled) | `expired` (TTL) | `superseded` (control transferred to someone else; all other open requests close with this reason).

**HandoffOffer** — the controller offers control to a named participant. An offer may exist without a prior request; a request never auto-creates an offer. A **handoff** is the completed transfer of control that a HandoffOffer initiates.
States: `open` → `accepted` → `waiting_for_boundary` → `completed`. Also: `declined` (recipient), `withdrawn` (controller, before acceptance), `expired` (TTL), `failed` (the execution errored or stopped before a boundary was reached; the lease stays with the original holder and the failure is visible).

**Safe execution boundary** — a point where the harness is awaiting input: turn complete, permission prompt pending, paused, or execution terminal. The runner, not the control plane, declares boundaries, because only the runner knows harness state. A paused execution and an idle workstream are always at a boundary, so those transfers complete immediately. If no boundary arrives within the transfer timeout, both parties see the stall and the controller (or Mission Admin) may force-interrupt — an explicit, logged action that ends the current turn. Transfer is never silent and never mid-tool-call.

Rules that prevent deadlock and races:
- The server validates every lease transition against current durable state (mechanics in [ARCHITECTURE.md](ARCHITECTURE.md#authorization)); two clients can never both believe they hold control.
- The lease is a durable grant, not a connection. A disconnected controller still holds the lease until TTL expiry. On expiry the workstream has no controller: the execution pauses at its next boundary, every participant sees "no controller," and any participant with `control.request` may claim the lease: a claim is a ControlRequest made against an unheld lease, which the server fulfills immediately — first accepted wins. The Mission Admin may revoke and reassign at any time.
- An accepted offer survives the recipient's disconnection; control is granted at the boundary regardless, because the grant is durable.
- Simultaneous requests both stay open and visible; the controller chooses. A completed transfer closes all other open requests as `superseded`.

**Control authority and execution lifetime are separate** (D-034). Novus imposes no universal wall-clock or turn-count limit: an authorized execution continues until the harness completes, requires human direction or approval, encounters a real failure, reaches an explicitly configured policy boundary, or receives an authorized pause, stop, or interrupt command. A participant disconnecting does not end an execution that was already authorized. An expired or transferred lease removes that person's ability to issue privileged commands from that moment on; it never retroactively revokes work already authorized. A local execution does depend on its host machine: quitting the host desktop ends the execution as an explicit *Execution interrupted* outcome, never as a silent stall and never as an orphaned process. Cloud execution will continue independently of the laptop that started it, and a rotated provider workspace preserves the mission through checkpoints and reconstruction. Vendor quota, organization policy, or an explicit user budget may stop an execution; Novus itself imposes no duration or turn ceiling.

### Direction

Direction is the attributed instruction stream. Lifecycle:

- **Drafted** — client-local only; never persisted or synced.
- **Submitted** — durably recorded, attributed, visible to all participants.
- **Queued** — accepted into the workstream's queue, ordered, waiting for the execution to reach a point where it can consume direction.
- **Applied** — delivered to the harness *and acknowledged by it* at a boundary it supports (start of next turn, or mid-turn steer where the harness allows it). Applied is marked on harness acknowledgment, never on send — "which direction is it following?" must never lie.
- **Superseded** — replaced by a later direction before application. Only Submitted or Queued direction can be superseded; Applied direction is history and can only be followed, never rewritten.
- **Rejected** — declined by the controller (or by mission policy), with the reason recorded.
- **Cancelled** — withdrawn by its author before application.

A direction may **carry images and PDFs** (D-150, D-151). A person attaching a screenshot is illustrating what they mean, so the act is gated by `direction.submit` and nothing further: whoever may direct may attach, and whoever may not, may not. An attached image is an Artifact like any other — stored, digest-verified, and viewable under the same mission authorization — with one honest difference from every other Artifact: Novus did not capture it, and the record says it was supplied rather than inventing a producer for it. What may be attached is decided by what the harness was **observed to read**, never by what a format claims: images the agent can see, PDFs it can read, and formats it cannot — a Mac's own HEIC photos, TIFFs — converted to something it can before they are sent, with the conversion stated. A format that would make the agent answer confidently about something it could not decode is refused rather than sent hopefully. **A file the model cannot read at all — audio, video, a spreadsheet, an archive — is not refused either: it is placed in the workspace and the agent opens it with its own tools**, which is the only honest way for such a file to be answerable. A staged file is never part of the mission's work: it is ignored by the repository and refused by the checkpoint, so a person's own file cannot reach a mission branch or a pull request. The files are fixed to the direction the moment it is submitted, travel with it to the machine running the turn, and are handed to the harness with the words. A direction is never held open waiting for bytes: an image that has not finished uploading refuses the submission in words instead of quietly arriving as something the turn never saw.

Transitions: queueing is automatic — Submitted becomes Queued on acceptance of the write; what is gated is application. The controller's own direction applies at the next receptive point without further action; a non-controller's direction applies only when the lease holder applies it. The author may cancel while Submitted/Queued; the lease holder applies, supersedes, or rejects; the system moves Queued → Applied on harness acknowledgment. Every transition is an event.

### Presence and connection

Presence (who is in the room, focus, typing) is ephemeral and never appears in receipts. Connection state is per-participant and visible: connected, reconnecting, offline. Reconnection restores the room from durable state; nothing a participant is entitled to see depends on having been online when it happened. Rendering rules are in [DESIGN.md](DESIGN.md#component-behavior).

### Repository continuity

Every workstream is anchored to one dedicated mission branch created from an exact recorded base commit. The active workspace has its own filesystem, whether it runs in Novus cloud, on a developer's machine, or later in customer infrastructure. Those filesystems are never described as automatically identical.

Product rules:

- The room always exposes the execution location, mission branch, base commit, workspace revision, and synchronization state one level below the mission's primary state. A prompt applies to the displayed workspace revision.
- GitHub is V0's exchange boundary. Committed work enters or leaves a cloud workspace through the mission branch; uncommitted files in another checkout are invisible until the user deliberately commits and pushes them.
- If the remote mission branch or its base advances, Novus records **Repository update available**. It does not silently pull, merge, rebase, overwrite, or restart the harness. The controller may inspect the commits and invoke `workspace.sync`; application waits for a safe execution boundary.
- A clean fast-forward is still visible and attributed. A non-fast-forward update, force-push, dirty-worktree collision, or merge conflict becomes **Repository sync error** with the conflicting refs preserved. Resolving it is directed work, not background magic.
- At safe boundaries, Novus checkpoints the workspace's Git diff and revision outside the sandbox so a destroyed provider workspace can be reconstructed. Provider persistence accelerates resume; it is never the only copy of mission work.
- A future local mirror may make opening and editing a cloud workstream convenient, but it remains an explicit checkout of the mission branch. Invisible bidirectional filesystem mirroring is not part of the product contract.

Representation and checkpoint mechanics live in [ARCHITECTURE.md](ARCHITECTURE.md#repository-and-workspace-synchronization); presentation lives in [DESIGN.md](DESIGN.md#component-behavior).

## The mission state model

The states below are the canonical vocabulary; [DESIGN.md](DESIGN.md#state-presentation) defines the presentation of each and may not add, rename, or merge states. A mission has one **primary state**; the conditions marked *(overlay)* can coexist with a primary state and demand attention without replacing it. In a mission with several workstreams, the primary state is a projection over workstream and execution states with fixed precedence: attention-demanding states, then running, then decided — a standing decision or an open pull request, which the list projection reaches exactly as the room's own always has (D-120) — then waiting, mirroring how "the controller" is derived for the single-workstream case. Home groups every active mission by that projection's class — needs you, running, waiting, decided, and complete once the work has ended (D-121) — computed and never hand-assigned: a mission changes groups because reality changed, and nothing on that surface starts, stops, or ranks anything (D-120). A closed mission's primary state is its stored outcome — the one stored word the projection reads, because a terminal state is a person's own fact — and terminal states never resume.

| State | Meaning — entered when / leaves when |
| --- | --- |
| New mission | Created; no workspace yet. Leaves on provisioning start. |
| Workspace needs setup | The worktree exists but the project has not said how to install or run it, or a required machine-local file is missing. Leaves when the workspace is configured and prepared. |
| Provisioning workspace | The workspace is being prepared: dependencies installing, the project's setup command running. Leaves on ready or failure. |
| Workspace failed | Provisioning or the workspace itself failed; provider error attached. Retry provisions a new workspace — never silent reuse. |
| Ready for instruction | Workspace ready, no active execution. Leaves when an execution starts. |
| Agent starting | Execution accepted, harness booting. |
| Agent running | Harness actively working; activity streaming. |
| Agent stopping | A participant asked the harness to stop and it has not finished stopping. Transient, like *Agent starting*: it exists so the room does not go on saying *Running* — and offering a Stop that has already been pressed — while the interrupt is in flight. It always resolves to a terminal outcome. |
| Needs direction | Harness is waiting for input at a boundary and the queue is empty. |
| Needs approval | Harness surfaced a permission request the lane's permission profile left to a person (D-115) — under the default profile, every request. Routed to the lease holder, who answers it once, for that act: a card's answer never becomes policy and no harness-suggested grant is ever taken (D-062). The only standing answers are a person's own recorded choices — the lane's profile, a chat's scope (D-097) — each answered by Novus on the record, act by act, and those acts never enter this state because nothing waits. Everyone else sees the question and who can answer it. A pending request is a *safe execution boundary*, so control may transfer while the harness waits, and the new holder answers. |
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
| Decision recorded | A participant chose one workstream's result, with a rationale, the risks they accepted, and the verification still outstanding. **Nothing has been published**: the choice is made and the applying of it has not happened, which is a different fact and is said as one. Leaves when a pull request is opened, when a revision is requested, or when a later decision supersedes it. |
| Pull request open | PR created/adopted; tracking checks, reviews, mergeability. |
| Completed | Result accepted, PR resolved, receipt snapshotted. Terminal. |
| Cancelled | Deliberately ended without acceptance; receipt records what happened and what was abandoned. Terminal. |

Ending a mission also **gives its workspaces back** (D-155): each lane's machine stops what is running there and removes the checkout. It is the ending that does this, never archival — filing a record away is not finishing with the work. A workspace still holding uncommitted work is **kept**, with the reason said in words: tidying up is never a reason to delete somebody's work, and the room would rather leave a directory behind than lose one. The mission branch is never removed — it carries every checkpoint, the receipt names it, and a pull request may point at it.
| Execution interrupted | The runner or harness died mid-execution; last events preserved. Resume-or-restart is a human choice — a new execution in the same workstream continues the work. |
| Execution stalled *(overlay)* | Watchdog timeout: the harness has made no progress and reached no boundary. The recovery path is Stop; a stop that then goes unanswered may be force-interrupted — an explicit, logged act (D-111). |
| Repository sync error *(overlay)* | The workspace cannot sync with GitHub — token expiry or revocation, force-push, or branch conflict with base. Human-visible remediation; never silent retries. |
| Reconnecting *(overlay)* | This client lost its connection; room is stale until restored. |
| Runner offline *(overlay)* | The runner's connection dropped; execution state is last-known; events will backfill on reconnect. |
| App running *(overlay)* | A run command the project declared is alive in the workspace, and — where the project declared a readiness signal — that signal has answered. Until it does the overlay says *starting*, and if its deadline passes it says the application is not answering rather than claiming it is up (D-045). Independent of any harness turn: an agent finishing does not stop the app, and the app running does not block direction. |
| Verification stale *(overlay)* | The workspace moved past the revision the current checks proved. The results remain as history; they are no longer evidence for what is there now. |
| Repository update available *(overlay)* | The remote mission branch or base moved beyond the workspace's recorded revision. No files move automatically; the controller may inspect and sync at a safe boundary. |

A harness that fails to start is not a separate state: it surfaces inside *Agent starting* as that state's error recovery.

Every state presents at most one primary action — never two — defined per state in [DESIGN.md](DESIGN.md#state-presentation); states of unattended progress deliberately present none, and their next action arrives with the next state. Reopening a mission in a terminal state opens its history and receipt; terminal states never resume.

## The complete workflow

The canonical 20-step narrative lives in [README.md](README.md#the-golden-v0-workflow). Elaboration by phase:

1. **Open** (steps 1–4): Kartik authenticates, connects a repository through the org's GitHub App installation (`org.repo.connect`), creates a mission with a goal and success criteria (`org.mission.create`), picks a harness. Mission: *New mission*. Kartik becomes the Mission Admin and holds the first workstream's lease by default. Creation is form-free (D-032): the goal derives from the first direction and stays renamable; success criteria may be stated then or attached in the room — the mission always *has* both, but neither gates starting.
2. **Provision** (steps 5–6): Novus records the selected base commit, creates the workstream's dedicated mission branch, and the execution provider prepares its workspace (*Provisioning workspace* → *Ready for instruction*); Kartik's initial direction starts the first execution (*Agent starting* → *Agent running*).
3. **Join** (steps 7–9): Maya redeems a mission invitation as Contributor. She sees the identical room state, reads the activity, and submits direction — which queues, visibly, attributed to her.
4. **Handoff** (steps 10–13): Maya opens a ControlRequest; Kartik responds with a HandoffOffer; Maya accepts; the transfer completes at the next safe boundary. The room shows every step of that handshake.
5. **Operate** (step 14): the controller steers, pauses, resumes, stops, or deliberately synchronizes a visible repository update at a safe boundary. Every action is an attributed event.
6. **Evidence** (steps 15–16): the harness changes the repository and runs verification; both participants inspect the same diff and the same check ledger. Where the lane's application is running in the Preview, a participant with `artifact.capture` — or the agent, through its governed, person-approved request — preserves screenshots and recordings as Artifacts (D-122, D-123), each bound to its revision and process and never presented as proof of correctness.
7. **Resolve** (steps 17–18): review yields a revision request (back to phase 5) or a **decision** — one workstream's result chosen, with a rationale, accepted risks, and the checks still outstanding, all recorded. Where competing approaches exist the team compares them on their own evidence and decides between them; Novus never ranks them. Novus then prepares the pull request and, when it is opened, operates it to resolution from inside the room: readiness — the host's checks, reviews, conflicts, and branch state beside Novus's own verification and accepted risks — review comments and their resolution, and completion. **Completion is a named person's explicit act, performed through GitHub** (D-100, reversing D-099's structural absence on the owner's direction): a person with `pr.manage` merges with one of the repository's own allowed methods, updates the branch, or closes without merging, each against the stated readiness, and GitHub performs the act and remains the source of truth for its result. Novus never merges silently, automatically, or as a side effect of anything — a merge with stated blockers outstanding names them at the confirmation and records that they were accepted, and a merge the host itself refuses (conflicts, failing required checks) is refused in words.
8. **Record** (steps 19–20): the mission completes; the receipt is snapshotted; reopening the mission reconstructs the entire collaboration from the event history.

## Scope and non-goals

### V0 scope

- One organization type, fixed roles. Repositories are GitHub (via the GitHub App) **or local folders on the user's machine** (D-032) — local git operations run in the desktop app, never the control plane.
- Two harnesses: Claude Code and Codex. The adapter contract is written for N harnesses; V0 ships two.
- Execution ships **local-first** (D-032): the desktop app runs harnesses against local repositories as the first real execution surface. Cloud execution on the Novus-managed provider remains the architecture's spine and the multiplayer default; the runner protocol keeps both honest.
- One dedicated GitHub branch per workstream, pinned to an exact base commit; explicit commit/checkpoint/push and sync operations; no automatic bidirectional filesystem mirroring. The base branch is chosen at mission creation — any branch of the repository, the default unless a person picks otherwise (D-139) — and a mission's pull request targets the branch it was based on. Novus reports where a pinned base stands against its branch — current, moved ahead, rewritten, or gone — as words on the record, and never silently rebases, merges, or follows; synchronizing a moved base is a person's explicit act, `base.sync` (D-144): the machine holding the worktrees merges the base's new tip into every lane — a merge, never a rebase, so every recorded checkpoint stays true — all lanes together or none, refused while any turn runs, on uncommitted work, and on conflict with the colliding files named; only then does the pin move. A rewritten or vanished base offers no sync — that is a rethink, not a merge.
- One workstream per mission created by default. A second is created only by an explicit `approach.create` with a stated intent, gets its own branch, workspace, and lease, and forks from the last checkpoint shared with the workstream it is created beside (D-079). On the machine that holds the checkout, the fork's workspace inherits its sibling's preparation rather than starting bare (D-081): the project's saved setup runs automatically as an ordinary authorized command attributed to the person who forked, and the Git-ignored files this person already consented to for the repository are copied again — every per-file validation re-run, never a new consent invented. Comparison and the decision that follows are V0 surfaces — deliberately reached, never pushed: a room with one workstream shows no comparison chrome at all, and no ranking, score, or recommendation exists anywhere in the product.
- Three surfaces: Missions, Mission Room, Review ([DESIGN.md](DESIGN.md#information-architecture)).
- One client: a downloadable desktop application — an Electron shell over a single web-architecture client — like the tools teams already run agents in. Browser access is a later delivery of the same client, not a second codebase (D-018). "Two real clients" in the Golden V0 workflow means two people's desktop apps.

### Non-goals (hard lines, not priorities)

A full IDE; a generic Kanban board; a model marketplace; automatic approach ranking or synthesis of competing implementations; dozens-of-agents fleet views; multi-repository missions; organization analytics; billing complexity; SSO/SCIM; mobile-native applications; a visual workflow builder; agent personas; building a foundation model; replacing GitHub; rebuilding Claude Code or Codex; an integration catalog. The architecture may keep honest extension points for some of these; the UI must never expose fictional future capabilities.

### Extension points (schema or protocol exists; no V0 UI)

Additional harnesses (Droid, OpenCode); local, enterprise, and third-party execution providers; a local mirror that explicitly checks out a cloud workstream's branch; cross-org mission guests; org-definable policy (autonomy ceilings, retention); API-driven mission creation and automation; org-level audit export.

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
