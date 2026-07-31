# Novus Product Steering Brief

## Objective

Move Novus from a technically credible multiplayer coding harness into the multiplayer decision room for agent-built software.

The category is:

**Multiplayer AI for software engineering.**

The product positioning is:

**Novus is the collaborative verification and decision layer for coding agents.**

The primary product line is:

**Branch the work. Prove the result. Decide together.**

An expanded description:

**Work with agents and teammates in the same live mission. Redirect execution, branch competing approaches, compare the evidence, and decide what ships.**

Do not turn Novus into:

- A generic IDE
- A generic Kanban board
- A terminal manager
- A model picker
- A clone of Conductor
- A dashboard for watching many private agent chats

Conductor is the benchmark for polish, information density, workspace legibility, and reliable agent-workspace management. Novus must own a different job: helping a team work inside the same live agent mission, exercise authority, compare competing approaches, understand the evidence, and record a defensible human decision.

---

## 1. Strategic framing

### Multiplayer remains the central product idea

Do not move multiplayer into the background.

YC’s Fall 2026 Requests for Startups includes an explicit request for **Multiplayer AI**. YC describes a future where teammates can enter the same live agent session, observe the work, redirect it, and hand it off instead of exchanging private chats or read-only transcripts.

Reference:

[YC Requests for Startups — Multiplayer AI](https://www.ycombinator.com/rfs#multiplayer-ai)

That framing closely matches Novus’s underlying thesis.

However, “multiplayer” by itself is a category, not yet a durable product advantage. Conductor and other platforms are already adding shared workspaces, links, cloud sessions, and team presence.

Therefore, use this strategic hierarchy:

- **Category:** Multiplayer AI for software engineering
- **Product:** A shared mission room for humans and coding agents
- **Initial wedge:** Branch, compare, prove, and decide on consequential changes
- **Long-term moat:** The complete record of authority, direction, execution, evidence, alternatives, and decisions

Multiplayer is how Novus works.

Decision quality is why engineering teams need it.

### The important difference

A normal shared agent product says:

> We can both see and prompt the same agent.

Novus should say:

> We can work inside the same live engineering mission, see who holds authority, redirect the execution safely, branch alternative approaches from the same checkpoint, compare the resulting evidence, and record why one result was authorized.

The multiplayer experience must be operational, not decorative.

Presence dots and shared transcripts are insufficient.

People must be able to:

- Join the same live mission
- Understand its current state immediately
- See who is in control
- Contribute direction
- See whether direction is queued or active
- Request or receive control
- Fork a competing approach
- Review evidence together
- Record the final decision
- Reconstruct who did what afterward

### The product should feel like a shared object

The mission—not the chat, agent, repository, or terminal—is the shared object.

A mission contains:

- The engineering goal
- Success criteria
- Repository state
- Participants and authority
- Agent executions
- Human directions
- Checkpoints
- Competing approaches
- Changes
- Verification evidence
- Decisions
- The final receipt

Every participant should see the same authoritative mission state.

---

## 2. Competitive position

### What the market is converging on

Products such as Conductor, Vibe Kanban, Braid, Cursor, Devin, GitHub, GitLab, and Factory are filling in combinations of:

- Isolated workspaces
- Git worktrees or remote machines
- Parallel agents
- Agent chats
- Terminals
- File browsers
- Diff review
- Pull requests
- Issue tracking
- Shared links
- Team administration
- Security policies
- Audit logs
- Usage analytics

These capabilities increasingly represent the expected foundation of an agent engineering product.

Novus should not attempt to win by having more panels, more agent providers, or more workspaces.

### Conductor’s job

Conductor primarily answers:

> How can I create and supervise many isolated agent workspaces and move their branches toward pull requests?

Its unit of delegation is the workspace.

Its unit of integration is the branch and pull request.

This is a strong product, and Novus should borrow its clarity and polish.

### Novus’s job

Novus should answer:

> When several humans and agents work on one consequential engineering mission, how do they coordinate authority, compare alternatives, establish what has been proven, and decide what should ship?

Its unit of collaboration is the mission.

Its unit of experimentation is the approach.

Its unit of trust is evidence.

Its unit of authority is the recorded human decision.

### Competitive line

Use this internal distinction:

**Conductor coordinates workspaces. Novus coordinates decisions.**

Do not attack or imitate Conductor. Treat it as proof that the workspace layer is real, then build one level above it.

---

## 3. Current repository state

The current branch was clean and synchronized at the time of this review.

Recent work has:

- Added native teammate join mode.
- Separated hosting capabilities from joined-session capabilities.
- Scoped invitations to individual sessions.
- Closed a cross-session invite authorization issue.
- Removed the flat raw tool-call list from the primary rail.
- Compressed passive run telemetry into the rail footer.
- Made changed-file rows open applied diffs.
- Added file and diff syntax highlighting.
- Added safe whole-file replacement.
- Improved malformed tool-call recovery.
- Used live-agent failures to strengthen the agent/tool boundary.

These improvements strengthened the harness.

The source is also ahead of the older screenshot in some respects: the raw tool-call list has already been removed from the main rail. However, the overall UI still centers:

- Repository tabs
- Repository paths
- Machine run state
- Timeline
- Terminal
- Files
- Tool and patch telemetry
- A separate, often-empty Attempts screen

The product thesis is stronger than the interface.

### Existing principles that must be preserved

The current fork-and-compare protocol contains valuable product decisions:

- Approaches originate from a recorded checkpoint.
- Alternatives execute in isolated Git worktrees.
- Fork permissions are constrained by the parent mission and checkpoint policy.
- Evidence is shown without automatic ranking.
- “No tests run” is not presented as success.
- Failed approaches remain evidence.
- The final selection belongs to an authorized human.
- The decision is recorded even if applying it encounters a conflict.
- Read-only guests do not receive authority through presentation-only checks.
- Selection and application are related but distinct facts.

Do not weaken these principles during the redesign.

### Known readiness gaps

Before a serious team pilot, address:

- Fork worktrees that are never cleaned up
- Interrupted approaches remaining “running”
- Dev processes without a complete session-close lifecycle
- Usage and budget accounting resetting after resume
- Cost being calculated but invisible
- Receipts undercounting build and diagnostic verification
- Missing renderer-level test coverage
- Incomplete clean-machine packaging
- Incomplete live multiplayer and forked evaluation runs
- Atomic control handoff without recipient acceptance
- Request-control capability without complete UI
- Worktrees being workflow isolation rather than a security boundary

These are product trust gaps, not merely engineering cleanup.

---

## 4. Target customer and entry point

### Design first for

- Staff engineers
- Engineering leads
- Platform teams
- Infrastructure teams
- Security engineering teams
- Developer productivity teams
- Teams already using Claude Code, Codex, Cursor, or similar agents

### Target missions

- Migrations
- Authentication and authorization changes
- Incident remediation
- Large refactors
- Architecture changes
- High-risk dependency updates
- Infrastructure changes
- Security-sensitive fixes
- Performance work with competing implementation strategies
- Changes where reviewers need more than a confident agent summary

Do not optimize the first commercial product for every small ticket.

Optimize for work where:

- Several people care about the result
- The change is expensive or risky
- A second approach is valuable
- Verification matters
- The final decision should be reconstructable

### Ideal early design partner

An ideal design partner:

- Already uses coding agents daily
- Runs multiple agent sessions or worktrees
- Has staff engineers reviewing agent-generated changes
- Feels overwhelmed by private transcripts and disconnected branches
- Works on changes where the first plausible answer cannot be accepted blindly
- Has a platform or security leader who cares about auditability
- Can use Novus weekly on real engineering work

---

## 5. Product vocabulary

Use customer-facing language consistently:

- Session → Mission
- Run → Execution
- Attempt → Approach
- Fork an attempt → Try another approach
- Timeline → Activity
- Compare → Decision
- Files changed → Changes or Evidence
- Receipt → Decision receipt
- Owner → Controller or “In control”
- Guest → Viewer or Participant, depending on capability
- Host → Mission host only where technically necessary

Internal contracts do not need immediate renaming if doing so creates migration risk.

Start with presentation language. Migrate internal names deliberately only when the contract itself must change.

### Human-centered status language

Do not show “Idle” as a primary product state.

Idle describes a process. It does not tell the user what is happening or what to do.

Translate machine states into human states:

- Ready for instructions
- Running
- Needs approval
- Needs direction
- Direction queued
- Pausing
- Paused
- Ready to compare
- Decision required
- Decision recorded
- Verification incomplete
- Applying selected approach
- Application conflicted
- Failed
- Cancelled

Every major state should answer:

1. What is happening?
2. Does someone need to act?
3. What is the next action?

---

## 6. Product principles

### 1. Mission over machinery

Lead with the engineering goal.

Repository paths, model names, event counts, and tool totals are supporting information.

### 2. Multiplayer by default

The product should always make participants, authority, and shared state legible.

Multiplayer should not be hidden behind an Invite button.

### 3. Evidence over confidence

Tests, builds, diagnostics, diffs, constraints, and receipts outrank agent prose.

### 4. Human authority is explicit

Show who can direct, approve, hand off, select, apply, or merge.

### 5. Completion is not verification

An agent finishing does not mean the work is safe, correct, or ready.

### 6. Alternatives begin from shared context

A competing approach should visibly originate from the same checkpoint.

### 7. Decisions survive the interface

A selection must persist across refreshes, devices, and participants.

### 8. Technical truth remains inspectable

Simplify the default experience without discarding the event log and raw evidence.

### 9. Progressive disclosure

Show the next decision first. Keep technical depth one deliberate interaction away.

### 10. Calm seriousness

The product should feel reliable and focused, not theatrical or cyberpunk.

---

## 7. Information architecture

### Home: Mission Inbox

Create a mission-centered home organized by attention.

Recommended sections:

1. Needs your decision
2. Needs your direction
3. Needs approval
4. Running
5. Waiting on someone
6. Recently completed

A mission row should show:

- Mission goal
- Repository, secondary
- Current phase
- Controller
- Active participants
- Number of approaches
- Evidence state
- Last meaningful activity
- Clear next action

Example next actions:

- Review two approaches
- Approve command
- Respond to Maya
- Resume execution
- Inspect failed verification
- Record decision
- View completed receipt

Repository tabs must not become the dominant organizational model.

A repository can contain many missions, and one person can participate in missions across several repositories.

### Mission Room

Use one shared workspace with four functional regions:

- Mission header
- Decision spine
- Active canvas
- Evidence inspector

Keep a persistent, context-aware direction composer.

#### Mission header

Order information as:

1. Mission goal
2. State and next action
3. Controller and participants
4. Repository and branch
5. Model and permissions
6. Terminal, invite, and command utilities

Do not lead with a filesystem path.

The mission goal should be the strongest piece of text on the screen.

#### Decision spine

Show the mission progression:

- Brief
- Execution
- Approaches
- Decision
- Receipt

Each stage has one visible status:

- Complete
- Active
- Blocked
- Needs attention
- Not started

Visually communicate that approaches share a checkpoint and converge into one decision.

The spine should become one of Novus’s recognizable visual signatures.

#### Active canvas

The default canvas depends on mission state:

- Before execution: brief and success criteria
- During execution: grouped activity and current work
- After a fork: branching approach view
- When approaches finish: Decision Room
- After selection: decision receipt

Avoid sending users into empty dedicated pages.

The canvas should always show:

- What exists now
- What is happening
- What the user can do next

#### Evidence inspector

Adapt the right panel to the current selection.

During execution:

- Active checks
- Changed files
- Pending approvals
- Verification progress

When an approach is selected:

- Its changes
- Verification
- Open concerns
- Human interventions
- Cost and time

When a contested file is selected:

- Baseline change
- Alternative change
- Behavioral implication
- Verification touching that file

During decision:

- Decisive evidence
- Unverified claims
- Remaining risk
- Application outcome

After decision:

- Immutable receipt details
- Selected approach
- Rationale
- Applied files
- Conflicts
- Participants

Use **Evidence** as the main panel label.

Possible subviews:

- Changes
- Verification
- Risk
- Technical details

---

## 8. Signature workflow: Approaches

The existing execution is always the baseline.

Do not make the baseline disappear simply because no alternative has been created.

### Before an alternative exists

Show:

- Current approach
- Its goal
- Current or final state
- Changed areas
- Verification state
- Open concerns
- A short explanation of when another approach is useful

Offer one primary action:

**Try another approach**

Do not duplicate this action in the rail and canvas.

### Fork form

Use one required prompt:

**What should this approach do differently?**

Examples:

- Preserve backward compatibility
- Minimize the change surface
- Avoid introducing a new dependency
- Use the existing authorization layer
- Optimize for migration safety
- Try a more direct implementation

Generate a useful label automatically.

Allow the label to be edited afterward.

Before launch, show:

- The checkpoint it will start from
- The original mission goal
- The differentiating instruction
- The permissions it inherits
- The evidence that will be compared

### Approach card

Each approach card shows:

- Name
- Baseline or alternative identity
- Differentiating intent
- Current state
- Changed areas
- Verification state
- Open concerns
- Human interventions
- Time and cost, secondary
- View evidence action

Do not create a giant empty comparison canvas.

Do not reduce an approach to line counts and tool-call totals.

Tool calls are implementation telemetry, not a decision criterion by themselves.

### Branch graph

Show the shared origin clearly:

```text
Shared checkpoint
      │
      ├── Current approach
      │
      └── Alternative approach
```

When the team selects one:

```text
Shared checkpoint
      │
      ├── Current approach ─────┐
      │                         ├── Human decision
      └── Alternative approach ─┘
                                      │
                                   Receipt
```

Do not imply that the approaches merged automatically.

They converge into a human decision, not into an automatic synthesis.

---

## 9. Signature workflow: Decision Room

Build the Decision Room as the strongest screen in the product.

This is the clearest opportunity for Novus to exceed generic workspace managers.

### Evidence order

Present information in this order:

1. Behavioral differences
2. Verification outcomes
3. Unverified claims
4. Contested files and constraints
5. Human interventions
6. Result that will be applied
7. Agent-generated summaries

Agent summaries belong last because they are claims, not proof.

### For each approach show

- What it tried
- How it differs
- What changed
- Tests
- Build
- Lint
- Diagnostics
- Failed verification
- Skipped verification
- Changed files
- Contested files
- Unique files
- Permissions exercised
- Human directions
- Time and cost
- Failure evidence
- Open risks
- Final agent summary

### Do not rank automatically

Do not create:

- An overall score
- A recommended winner
- A glowing preferred card
- A default-selected approach
- A model-generated verdict presented as objective truth

The system can summarize evidence, but the authorized human decides.

If recommendations are explored later, they must be clearly separated from verified evidence.

### Decision actions

Provide:

- Choose this approach
- Request revision
- Keep exploring
- Inspect contested change
- Record decision

When selecting an approach, require a short rationale:

- Why was it selected?
- What evidence mattered?
- What risk is being accepted?
- Was anything intentionally left unresolved?

Store the rationale in:

- The event log
- The comparison projection
- The decision receipt
- Joined-participant views
- Replay

The rationale must survive refresh and reconnection.

### Decision outcome language

Keep selection and application distinct.

Possible outcomes:

- Decision recorded and applied
- Decision recorded; application blocked by conflicts
- Decision recorded; awaiting authorized application
- Revision requested
- Further exploration requested

Do not call an application conflict a failed decision.

---

## 10. Activity and provenance

Preserve the event log, but group events into human-readable milestones by default.

Examples:

- Inspected the authentication flow
- Identified three affected modules
- Proposed changes to three files
- Verification failed
- Sarah submitted direction
- Direction queued for the next safe boundary
- Direction applied
- Revised the patch
- Required checks passed
- Alternative approach completed
- Alex selected the baseline
- Decision applied to the working tree

Raw information should be available under **Technical details**:

- Tool calls
- Tool arguments
- Tool results
- Event envelopes
- Sequence numbers
- Raw JSON
- Model-routing decisions
- Token accounting

The default experience should tell the mission story.

The technical view should preserve auditability.

---

## 11. Multiplayer authority

Presence is not enough.

The UI must show:

- Who is present
- Who is currently connected
- Who can submit direction
- Who holds control
- Who can approve tools
- Pending requests for control
- Pending handoff offers
- Queued directions
- When each direction became active
- Who recorded the final decision

### Control baton

Represent authority as a visible baton.

Examples:

- Alex in control
- Maya requested control
- Control offered to Maya
- Waiting for Maya to accept
- Control will transfer at the next safe boundary
- Maya now in control

Do not use ownership language that implies control can never move.

### Handoff lifecycle

Replace atomic handoff with:

1. Current controller offers handoff
2. Recipient receives the offer
3. Recipient accepts or declines
4. Execution reaches a safe boundary
5. Control transfers
6. Transfer is recorded

If execution is not active, transfer may happen immediately after acceptance.

### Direction lifecycle

Show direction as a stateful object:

1. Submitted
2. Queued
3. Applied
4. Superseded, rejected, or cancelled if applicable

Participants must be able to distinguish:

- Something typed in chat
- A proposed direction
- A direction the execution is now following

### Role-aware joined sessions

Joined sessions must be role-aware by construction.

Do not render privileged actions and rely only on disabled buttons.

Suggested roles:

- Viewer
- Contributor
- Controller
- Mission administrator

Example capabilities:

#### Viewer

- Observe activity
- Inspect evidence
- View approaches
- View decisions and receipts

#### Contributor

- Viewer capabilities
- Submit direction
- Comment on evidence
- Request control

#### Controller

- Contributor capabilities
- Pause or resume
- Approve permitted actions
- Create approaches
- Make operational decisions

#### Mission administrator

- Controller capabilities
- Manage participants
- Change roles
- End the mission
- Control retention or export where supported

The final selection may require a specific decision permission rather than being granted to every controller.

---

## 12. Detailed visual direction

### Overall feeling

The product should feel like:

**Conductor’s composure, Linear’s precision, and Figma’s multiplayer clarity, arranged like a quiet engineering control room.**

It should not feel like:

- A cyberpunk terminal
- A wall of developer telemetry
- A generic admin dashboard
- A colorful Kanban board
- A chat application with extra panels
- A monitoring console designed only for machines

The emotional qualities should be:

- Calm
- Precise
- Shared
- Serious
- Inspectable
- Responsive
- Trustworthy
- Modern without being fashionable
- Dense without feeling cramped

A person should feel that important engineering work is under control.

### Color system

Use a deep graphite foundation rather than pure black.

Suggested dark tokens:

- Application background: `#0B0D10`
- Primary plane: `#111419`
- Elevated plane: `#171B21`
- Hover surface: `#1B2028`
- Selected surface: `#202633`
- Primary border: `rgba(255, 255, 255, 0.08)`
- Strong border: `rgba(255, 255, 255, 0.14)`
- Primary text: `#F2F4F7`
- Secondary text: `#A3A9B3`
- Muted text: `#6F7682`

Semantic accents:

- Active/control blue: `#6E86FF`
- Alternative violet: `#9A7BFF`
- Verified green: `#45C486`
- Needs-attention amber: `#E7B15A`
- Failed/blocked red: `#E06C75`

These exact values can be adjusted to the existing design tokens, but preserve the hierarchy.

### Color meaning

Use color semantically:

- Neutral: inactive or informational
- Blue: active execution, selected navigation, control
- Violet: alternative approach identity
- Green: verified evidence or successfully recorded outcome
- Amber: unverified, incomplete, or requiring human attention
- Red: failed, blocked, denied, or dangerous
- Gray: completed but not independently verified

Do not use green merely because an agent completed.

Completion and verification are different states.

Do not fill entire cards with semantic colors.

Use accents in:

- Status dots
- Thin borders
- Branch lines
- Small badges
- Verification marks
- Selected controls
- Critical text

Large colored panels should be rare.

### Spatial layout

At a common desktop width, target approximately:

- Mission header: 52–56px high
- Decision spine: 220–240px wide
- Active canvas: fluid and dominant
- Evidence inspector: 300–340px wide
- Composer: 64–88px high depending on content

The active canvas must feel like the product.

The side panels support the decision instead of competing equally for attention.

Avoid a layout where every column has the same visual weight.

### Mission header placement

Left side:

- Mission goal
- Mission phase
- Repository as secondary metadata

Middle or right:

- Current controller
- Participant avatars
- Needs-attention state

Far right:

- Invite
- Terminal
- Command palette
- Overflow actions

Permissions and model details should be inside a compact mission-information popover unless immediately relevant.

Do not fill the header with pills.

### Decision spine placement

The left side should contain:

- Mission stages
- Branch structure
- Participants
- Control state

Do not put passive tool-call counts in the prime part of this rail.

Small operational totals may remain in a subdued footer or technical popover.

The Decision Spine should make the workflow understandable at a glance.

### Active canvas placement

Use generous internal margins:

- Approximately 24px around major canvas content
- Approximately 16px between cards
- Approximately 8px inside compact control groups

Keep the main content width readable.

Do not stretch paragraphs and summaries across the complete canvas width.

Use max-width constraints for narrative content while allowing comparison structures to expand.

### Evidence inspector placement

The right panel should remain visually quieter than the central canvas.

Use:

- Compact section titles
- Consistent evidence rows
- Strong pass/fail/unknown semantics
- Expandable detail
- Direct navigation to changed files and checks

Avoid repeating the same information in the canvas and inspector.

The canvas explains the decision.

The inspector supplies the proof.

### Typography

Use a clean interface sans-serif such as the current system font, Inter, Geist, or SF Pro.

Recommended hierarchy:

- Mission goal: 20–24px, semibold
- Major screen title: 17–20px, semibold
- Card title: 14–15px, medium or semibold
- Interface body: 13–14px
- Metadata: 11–12px
- Dense evidence values: 12–13px
- Technical text: monospace, 12–13px

Use monospace only for:

- Paths
- Commands
- Branches
- Model identifiers
- Diffs
- Receipt IDs
- Event details
- Numeric execution evidence where helpful

Do not render ordinary interface language in monospace.

### Borders, shadows, and radii

Use:

- One-pixel alpha borders
- Radii around 8–10px
- Minimal shadow
- Slightly stronger contrast for selected or floating surfaces

Avoid:

- Thick borders
- Large glowing shadows
- Excessively rounded cards
- Floating glass panels everywhere
- Neon effects

Depth should come primarily from plane contrast and borders.

### Motion

Motion should be fast and restrained:

- 120–180ms transitions
- Small fades
- Short position changes
- Subtle panel expansion
- No decorative bouncing
- No constant pulsing

Meaningful motion can occur when:

- A direction changes from queued to applied
- Control transfers
- A checkpoint forks
- An approach completes
- A decision converges into a receipt
- Evidence changes state

The branch graph may animate when a fork is created or a decision is recorded.

Do not continuously animate active branches.

### Cards

Cards must answer a specific question.

Examples:

- What is this approach trying?
- What evidence passed?
- What needs attention?
- Who currently controls the mission?
- What changed between the approaches?

Avoid generic cards containing unrelated counts.

Do not use card grids merely to make the screen look populated.

### Status language and iconography

Use simple geometric icons and status marks.

Examples:

- Circle: not started
- Filled dot: active
- Check: verified or completed stage
- Amber diamond: needs attention
- Bar or pause mark: paused
- X: failed
- Branch line: approach divergence
- Converging line: human decision

Avoid robot icons, agent faces, lightning bolts, and excessive sparkle imagery.

The product is about engineering authority, not AI theater.

### Empty states

Never leave a giant empty canvas with centered gray text.

An empty state should still show:

- The current baseline
- The mission goal
- What is available
- Why the next action matters
- One primary action

For example, before alternatives exist:

- Show the current approach card
- Show its available evidence
- Explain what trying another approach provides
- Show “Try another approach”

### Loading states

Loading should preserve layout.

Use skeletons matching:

- Mission rows
- Activity groups
- Approach cards
- Evidence rows

Do not replace the entire interface with a spinner.

### Error states

Errors should explain:

- What failed
- What state remains safe
- Whether work was preserved
- What the user can do next

Example:

> The alternative execution stopped unexpectedly. Its changes and activity were preserved. Retry from the checkpoint or inspect the failure evidence.

### Light mode

If maintaining light mode, preserve the same semantic hierarchy.

Do not treat light mode as an inverted afterthought.

Use warm or neutral off-white planes rather than pure white everywhere, with similarly restrained accents.

Dark mode remains the primary taste reference.

---

## 13. Spatial visualization

The target mission room should roughly read like this:

```text
┌────────────────────────────────────────────────────────────────────────┐
│ Mission goal              Needs decision     Alex in control      ••• │
├───────────────┬───────────────────────────────────┬────────────────────┤
│ DECISION      │                                   │ EVIDENCE           │
│ SPINE         │          ACTIVE CANVAS            │                    │
│               │                                   │ Verification       │
│ ✓ Brief       │    Shared checkpoint              │  ✓ Tests           │
│ ✓ Execution   │           │                       │  ✓ Build           │
│ ● Approaches  │      ┌────┴────┐                  │  ! Diagnostics     │
│ ○ Decision    │   Baseline  Alternative           │                    │
│ ○ Receipt     │      └────┬────┘                  │ Changed files      │
│               │       Decision required           │ Contested files    │
│ PEOPLE        │                                   │ Remaining risks    │
│ ● Alex        │   Evidence and approach details   │ Permissions used   │
│ ○ Maya        │                                   │                    │
├───────────────┼───────────────────────────────────┼────────────────────┤
│               │ Give direction…                   │                    │
└───────────────┴───────────────────────────────────┴────────────────────┘
```

The UI should not say:

> Look how much agent machinery is running.

It should say:

> Here is the mission. Here is who is in control. Here is where the approaches diverged. Here is what has been proven. Here is the decision the team needs to make.

---

## 14. What to borrow, own, and refuse

### Borrow

From Conductor and other strong tools:

- Calm visual density
- Clear workspace status
- Progressive disclosure
- Reliable keyboard navigation
- Diff-centered review
- Inline comments returned to the agent
- Checks and merge-readiness framing
- Compact participant presence
- Strong empty and loading states
- Good command palette behavior
- Clear separation between primary work and utilities

### Own

Novus should uniquely own:

- Shared mission as the collaboration object
- Decision Spine
- Shared checkpoint visualization
- Competing approaches from the same execution state
- Evidence-first Decision Room
- Submitted-to-applied direction lifecycle
- Explicit authority baton
- Accepted handoff
- Recorded selection rationale
- Chosen and rejected approach history
- Decision receipt
- Replay of human and agent activity
- The difference between completion, verification, decision, and application

### Refuse for now

Do not build:

- Full code editor
- Generic Kanban
- Agent avatar theater
- Huge model marketplace
- Generic fleet dashboard
- Automatic winner scoring
- Broad issue tracker
- Multi-repository breadth
- Complex visual workflow builder
- Analytics without a decision use case
- Cloud platform breadth before the mission loop is proven

---

## 15. Scope rule

Every proposed feature must strengthen at least one of four verbs:

1. Frame
2. Branch
3. Prove
4. Decide

Ask:

- Does it help frame the mission?
- Does it help branch an approach?
- Does it help prove the result?
- Does it help an authorized human decide?

If the answer is no to all four, do not add it now.

Recommended allocation for the next product cycle:

- 70% finish and sharpen the core decision loop
- 20% team pilot foundations
- 10% enterprise research and prototypes

Add depth to the signature workflow before adding breadth.

---

## 16. Implementation sequence

Do not implement the entire redesign in one broad change.

Before each slice:

1. Inspect the current source and relevant contracts.
2. State what can be achieved using existing data.
3. Identify any contract additions separately.
4. List affected desktop, guest, shared UI, worker, projection, receipt, and test surfaces.
5. Implement one vertical slice.
6. Run the repository gate.
7. Report what changed, what remains, and what was deliberately deferred.

Read and follow:

- `AGENTS.md`
- `README.md`
- `V1_README.md`
- `PROGRESS.md`
- The `novus-ui` skill
- The event-contract extension procedure when changing session events
- The harness build procedure when changing agent capabilities

Do not casually widen the event contract from one renderer component.

### Slice 1: Approach surface using existing data

#### Goal

Fix the most visible product mismatch without unnecessarily widening the protocol.

#### Deliver

- Present the baseline/current approach.
- Rename Attempts to Approaches in customer-facing UI.
- Replace the two-field fork form with the differentiating-intent flow.
- Generate an approach label automatically where possible.
- Remove duplicated fork explanations.
- Remove duplicated fork CTAs.
- Eliminate the empty comparison canvas.
- Add meaningful approach states.
- Show the shared checkpoint.
- Keep current choose/apply behavior.
- Preserve read-only guest construction.

#### Acceptance

- The baseline is visible before a fork.
- A user can explain what will be compared before creating an alternative.
- Only one primary approach-creation action is visible.
- No automatic winner or ranking is introduced.
- “No tests run” remains visibly unverified.
- Failed approaches remain visible.
- Guest remains read-only by construction.
- Existing comparison and decision tests remain green.
- Renderer tests cover:
  - Baseline only
  - Alternative being created
  - Alternative running
  - Completed comparison
  - Failed approach
  - No tests
  - Recorded decision
  - Application conflict

### Slice 2: First Decision Room

#### Goal

Make comparison evidence-first.

#### Deliver

- Behavioral-intent section
- Verification section
- Unverified claims
- Contested files
- Unique files
- Clear failure evidence
- Human interventions
- Request revision
- Keep exploring
- Decision rationale
- Decision receipt presentation

If this requires event-contract changes, update:

- Contract
- Worker emission
- Projection
- Compare endpoint
- Desktop
- Joined desktop
- Browser guest
- Shared UI
- Receipt
- Replay
- Tests

#### Acceptance

- The user can choose without relying on an agent summary.
- “No tests run” is never presented as success.
- Failed approaches remain decision evidence.
- Selection rationale survives refresh.
- Selection rationale is visible to joined participants.
- Application conflict remains distinct from decision failure.
- Contested files can be inspected directly.
- Chosen and rejected approaches remain available after the decision.

### Slice 3: Multiplayer authority

#### Goal

Turn shared viewing into real multiplayer control.

#### Deliver

- Clear controller identity
- Request-control UI
- Handoff offer
- Recipient acceptance
- Safe-boundary transfer
- Direction queue
- Submitted, queued, and applied states
- Role-aware actions
- Decision-authority presentation

#### Acceptance

- Every participant can identify who controls the mission.
- Contributors can request control.
- Handoff cannot silently assign responsibility to an offline participant.
- Transfer survives refresh and reconnect.
- Direction state is unambiguous.
- Joined views never expose actions outside the participant’s role.
- Every control transition is recorded.

### Slice 4: Reliability before pilot

#### Deliver

- Fork cleanup policy
- Orphaned running-approach recovery
- Dev-process cleanup
- Resume-safe usage totals
- Resume-safe budget totals
- Build receipt coverage
- Lint receipt coverage
- Test receipt coverage
- Diagnostics receipt coverage
- Visible cost
- Renderer test coverage
- Signed distributable

#### Acceptance

- No terminal state leaks a worktree indefinitely.
- Worker restart cannot leave a false running state.
- Dev processes do not survive a deliberately closed mission.
- Receipt totals remain cumulative across pause and resume.
- Verification receipt matches the UI.
- Cost shown in the UI matches the receipt.
- Clean-machine installation succeeds repeatedly.
- The application can complete the V1 flow without terminal intervention.

### Slice 5: Mission Inbox

#### Goal

Make Novus legible as a team product rather than a collection of repository tabs.

#### Deliver

- Attention-based Mission Inbox
- Mission titles and goals
- Phase and next action
- Controller and participants
- Approach count
- Evidence state
- Recently completed missions
- Repository as secondary context

#### Acceptance

- A user can see what needs attention without opening every mission.
- Repository identity remains available but does not dominate.
- Missions across repositories can coexist coherently.
- Running and decision-required work are visually distinct.
- The inbox does not become a generic Kanban board.

### Slice 6: Team pilot surface

#### Deliver

- Durable shared sessions
- Role-aware invitations
- GitHub repository connection
- Pull request status
- Required checks
- Exportable decision receipt
- Basic team grouping
- Basic usage and cost view
- Stable onboarding
- Stable update path

#### Acceptance

- Two people on separate machines complete the complete mission loop.
- A participant can safely request or receive control.
- A reviewer can follow a shared link and understand the decision without a verbal walkthrough.
- Repository policy visibly determines what is possible.
- Pull request status and the decision receipt agree.
- A team can use Novus weekly without developer assistance.

---

## 17. Enterprise path

Do not attempt to build every enterprise requirement before proving the mission loop.

### Stage 0: Product proof

Prove:

- Real multiplayer session
- Real alternative execution
- Evidence comparison
- Human selection
- Reliable application
- Decision receipt
- Clean installation

### Stage 1: Design-partner pilot

Add:

- Durable team service
- GitHub integration
- Roles
- Required checks
- Audit export
- Cost visibility
- Stable onboarding
- Three to five active teams

### Stage 2: Enterprise trust

After repeated team use, add as customer demand proves necessary:

- SAML or OIDC SSO
- SCIM
- Fine-grained RBAC
- Enterprise-level policies
- Repository-level policies
- Audit-log retention and streaming
- Model allowlists
- Tool allowlists
- Secrets broker
- Network egress control
- Data-retention settings
- Admin visibility
- Encryption and key-management story
- Managed isolated runners
- Customer-controlled runners
- Dedicated or VPC deployment where justified

### Execution security

Git worktrees are workflow isolation, not a security boundary.

They do not independently provide:

- Process isolation
- Network isolation
- Secret isolation
- Resource limits
- Protection from shared Git metadata manipulation
- Protection from hostile commands

Enterprise execution eventually requires a stronger sandbox or runner boundary.

Recommended deployment progression:

1. Local host with outbound-only relay
2. Customer-managed runner inside the customer environment
3. Managed isolated runners
4. Customer-dedicated or VPC deployment when demanded

Do not build a complete cloud execution platform before the decision workflow is proven.

---

## 18. Explicit current non-goals

Do not build during the initial slices:

- Full code editor
- Generic project-management board
- Multi-repository missions
- Large agent fleets
- Automatic approach ranking
- Learned model-routing UI
- Marketplace
- Broad integration catalog
- On-prem deployment
- SSO or SCIM
- Organization-wide analytics beyond pilot needs
- Complex approval workflow builder
- Custom workflow language
- Agent persona system

These become candidates only after design partners repeatedly use the mission loop.

---

## 19. Product proof metrics

Track:

- Time from agent completion to trusted decision
- Percentage of decisions made without reading the entire transcript
- Percentage of missions with complete verification evidence
- Percentage of approaches requiring human redirection
- Time from direction submission to direction application
- Compare-to-selection conversion
- Number of alternatives created per consequential mission
- Rework after selection
- Defects found after merge
- Human attention minutes per accepted change
- Cost per accepted change
- Percentage of handoffs successfully accepted
- Percentage of missions with more than one active human participant
- Time from “needs attention” to human response

### Primary qualitative test

Ask the reviewer:

> Can you explain why the selected approach won, what evidence supported it, who authorized it, and what risk remained?

If the reviewer must read the complete transcript to answer, the Decision Room has failed.

### Multiplayer qualitative test

Ask each participant:

> Can you tell who is in control, what direction the agent is following, what needs your attention, and what happens next?

If not, multiplayer is present technically but not legible as a product.

---

## 20. North-star experience

A staff engineer opens Novus and sees that an authentication migration needs a decision.

They enter the mission and immediately understand:

- The migration goal
- Who is present
- Who controls the execution
- What the current approach attempted
- What remains unverified

Another engineer joins the same live mission.

They submit a concern about backward compatibility.

The direction appears as queued and then applied at a safe boundary.

The team creates an alternative approach from the same checkpoint with the instruction to preserve compatibility.

Both approaches execute independently.

The Decision Room shows:

- Their behavioral differences
- Which verification passed
- Which claims remain unverified
- Which files both changed
- Which approach introduced more migration risk
- Which human directions affected each approach
- Cost and time as secondary evidence

The staff engineer chooses one approach and records why.

Novus applies it or explains precisely why application was blocked.

The final receipt records:

- Mission
- Participants
- Controller history
- Human directions
- Shared checkpoint
- Both approaches
- Verification
- Selected result
- Decision rationale
- Application outcome

A reviewer joining afterward can understand the complete decision without receiving a private transcript dump or verbal explanation.

That is the product.

---

## 21. Final working rule

For every proposed feature, answer:

1. Does it help frame the mission?
2. Does it make multiplayer collaboration more operational?
3. Does it help branch an approach?
4. Does it help prove the result?
5. Does it help an authorized human decide?
6. Does it make the decision reconstructable afterward?

If the answer is no to all six, do not add it now.

Build Novus around one exceptional loop:

**Enter the same mission. Direct the work. Branch the approach. Prove the result. Decide together.**
