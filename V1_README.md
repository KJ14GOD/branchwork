# Novus V1

This document defines the first build. It intentionally excludes most of the
long-term platform described in [README.md](./README.md).

## V1 outcome

V1 must prove one sentence:

> Two people can safely collaborate with a real coding agent, fork its work into
> two isolated attempts, and select the better result using observable evidence.

The release is successful only if both parts work:

1. **Coding harness:** the agent can inspect a repository, modify files, run
   commands, and return verified results.
2. **Multiplayer session:** another person can join live, observe, contribute
   direction, take control, and participate in a fork/compare decision.

A fake agent with beautiful collaboration is not V1. A capable private agent
with no meaningful shared control is also not V1.

## Where we actually are

Updated 2026-07-30. Keep this honest; it is the section that decides what gets
built next.

**Both halves are now real, and the gap between them has closed almost all the
way.** The harness half: a typed agent loop with a budget in place of a step
ceiling, sixteen tools including command execution, Git branches and
worktrees, structured typecheck/lint diagnostics, build execution,
long-running dev-server management, and file creation and deletion through
the same propose-then-apply gate as edits (2026-07-30 — before that an agent
could not create a file at all without contorting run_command), path
confinement that survives symlinks, deny-by-default
permissions, and an event stream three surfaces render live (desktop, guest,
and a relay in between). The multiplayer half: a real SQLite-backed event
store behind an HTTP+SSE worker, a separate WebSocket relay process a teammate
off the host machine can watch through, an invite endpoint that mints a
role-scoped token the worker never re-issues, a direction endpoint a running
turn folds in at its next boundary, cancel/pause/resume endpoints the same run
loop honours at that same boundary, a handoff endpoint that actually moves
execution authority rather than just recording that it happened, live presence
distinct from who was ever invited, and all of it now reachable from the
desktop UI rather than curl only. Fork and compare exist too: checkpoints cut
real Git worktrees, isolated attempts run without touching each other or the
parent's index, the compare screen shows them side by side, and choosing one
now records the decision and applies it.

What is still missing, plainly:

- **The renderer has no test coverage.** Every hook in `apps/desktop/src` and
  `apps/guest/src` is unverified by anything but hand-testing — worker logic is
  extensively tested, the React layer that calls it is not. That gap is exactly
  how a real bug (the Open screen's session history silently failing because
  its fetch carried no auth token) shipped and sat unnoticed.
- **No packaging.** There is no signed macOS build, so "the complete demo works
  repeatedly on a clean machine" — Milestone 5's exit condition — has not been
  attempted on a machine that isn't a developer's.
- **Requesting control has no UI trigger.** `control.requested` is a real
  event with a real route (`POST /sessions/:id/control/request`) any
  participant can call, and it renders in the timeline like anything else, but
  no button calls it. The natural place used to be argued away — the guest is
  structurally read-only and has never issued a POST — but that argument
  expired on 2026-07-30: the desktop's joined tab (below) is a
  lower-privilege participant surface that already POSTs direction, and the
  button has not been added there either. Handoff itself does not depend on
  it: the owner can hand off to anyone in the presence list from the desktop
  UI without a request ever being made.
- **A teammate now joins in the Novus app itself, with honest limits.**
  Since 2026-07-30 the desktop app has a join mode beside its hosting
  default: a plain launch hosts exactly as before (no mode picker anywhere on
  that path), while `--join` / `NOVUS_JOIN` opens a window that spawns no
  worker at all, and a hosting window's titlebar Join button takes a pasted
  invite without relaunching. A joined tab reads the same event stream the
  browser guest reads — through `packages/session-client`, one shared client
  rather than a third implementation — shows presence, and offers exactly
  what `GET /sessions/:id/me` says the invite's role allows: direction for
  editors, pause/resume/cancel for steer-holders, watch-only otherwise,
  updating live across a handoff. The worker, not the UI, is the authority:
  it newly refuses any invited caller `POST /sessions` and
  `GET /sessions/history`, so an invite is a key to one session and nothing
  else on the host. What this does not give you yet: joined tabs do not
  survive a relaunch (the invite token is deliberately never persisted), a
  relay join is watch-only in both directions and says so, approvals still
  have no HTTP surface for a reviewer to act through, and cross-machine
  joining needs the relay behind `wss://` — the plaintext refusal is
  enforced in the shared client for the desktop exactly as for the browser,
  and nobody has stood such a relay up, so same-machine joining is what is
  actually proven (over real processes: a real worker, real invites, a real
  `--join` Electron launch asserted to spawn nothing, and a second hosting
  instance beside a live one landing on a fallback port without touching
  it). The joined tab's own React code shares the renderer test-coverage gap
  above; everything under it — launch plan, port choice, invite parsing,
  transport, and the worker's enforcement — is tested.
- **A handoff is atomic, not a two-step accept.** The protocol document below
  describes the recipient explicitly accepting a handoff; what is built
  transfers ownership the moment the owner clicks, the same way an invite
  mints a role without a confirmation round-trip. `acceptedAt` on
  `control.transferred` is stamped at that moment rather than won by a
  separate acceptance event.
- **A resumed run's token usage undercounts.** Usage is reported by the model
  adapter per call and was never logged, so pausing and resuming has nothing to
  rebuild it from — a resumed run's usage counters restart at zero, and its
  eventual receipt reports only the tokens spent after the most recent resume,
  not the full run. The same is true of the run's budget clock: it also resets
  on resume, so neither a long pause nor the turns before it count against the
  continuation's own budget. Neither is surfaced to whoever is watching — it
  is written down here and in `agent-runner.ts`'s own comments, not in the
  timeline. What *is* carried forward correctly is the harder part: the
  model's tool-exchange context from before the pause, rebuilt from the event
  log rather than lost, so a resumed run does not have amnesia about what it
  already tried.

Seven earlier failure modes, closed:

- ~~**Pause, resume, and handoff do not exist.**~~ Fixed 2026-07-30: `POST
  /sessions/:id/pause` records `run.pause_requested`; the run loop honours it
  at the same turn boundary cancel and direction already use and appends
  `run.paused` — not terminal, so it gets no receipt. `POST
  /sessions/:id/resume` restarts the same run under the same id, rebuilding
  the paused turn's tool exchanges from the log so the model does not lose
  what it had already tried. `POST /sessions/:id/handoff` transfers ownership
  via `participants.ts`'s `transferOwnership` — already written, never wired
  to a route — and records `control.transferred`; only the current owner can
  call it, checked twice, once by the route's capability table and once by
  the registry itself. See Milestone 3.
- ~~**Presence is historical, not live.**~~ Fixed 2026-07-30: `GET
  /sessions/:id/presence` reports who currently holds an open event stream,
  counting connections per participant so a second tab or a reconnect does not
  read as a departure — distinct from `participant.joined`, which only ever
  said who was invited. Both the desktop and guest UIs poll it and show a live
  dot next to whoever is actually watching. Proven over a real socket in
  `presence.test.ts`: opening and closing a real SSE connection flips presence
  live and back, and an invited participant appears separately from the host.
- ~~**Nothing can stop a run in flight.**~~ Fixed 2026-07-30: `POST
  /sessions/:id/cancel` records `run.cancel_requested`; the run loop honours
  it at the same turn boundary direction is folded in at and appends
  `run.cancelled`, distinct from a failure throughout the receipt, the
  projection, and the guest's status. See Milestone 3.
- ~~**Choosing an attempt does nothing.**~~ Fixed 2026-07-30: `POST
  /sessions/:id/decision` records `decision.recorded` and, when the session
  has writes enabled, applies the chosen attempt's changes to the parent's
  working tree — reusing `propose_patch`/`apply_patch` per file rather than a
  new write path. See Milestone 4.
- ~~**The agent cannot yet verify its own work.**~~ Fixed 2026-07-29:
  `run_command` and `run_tests` exist, are `dangerous` class, and are opted into
  with `NOVUS_ALLOW_COMMANDS=1`.
- ~~**Events do not survive a restart.**~~ Fixed 2026-07-29 for the log, and
  2026-07-30 for the *session*: the worker reads prior sessions back from SQLite
  on every request to `/sessions/history`, and the desktop's Open screen now
  sends the token that route requires, so "Carry on with" actually shows what
  the log remembers instead of coming back empty.
- ~~**Nothing has ever been benchmarked.**~~ Fixed 2026-07-29: all three
  Evaluation tasks — bug fix, small feature, repository reasoning — exist as
  fixtures and have each passed against the real model once. See *Benchmark
  results*.

One piece of `README.md`'s own roadmap is also real now, ahead of the rest of
this milestone rather than after it: **multiple model providers.** `apps/worker/src/openai-model.ts`
is a second `ModelAdapter` beside Anthropic's, selected at boot with
`NOVUS_MODEL_PROVIDER`/`NOVUS_MODEL` (unset, behaviour is unchanged). Reviewed
by scope-warden before it was built, which flagged — correctly — that this is
roadmap work landing ahead of Milestone 3's own remaining items; recorded
here rather than treated as a reason not to, since reaching into the roadmap
was explicitly in scope for this slice. Proven deterministically (message
building, context elision, and the required trust-boundary case: malformed
tool-call arguments become an observation, not a thrown error) and proven live
at the process level — a real worker still boots on the Anthropic default
unchanged, an unrecognised provider name refuses at boot with a stated reason,
and a real request reaches OpenAI's API and is validated by it. What is *not*
proven: a full live round-trip against a real OpenAI model, because no valid
`OPENAI_API_KEY` was available to run one with. `openai-smoke.ts` is there to
run by hand the moment one is.

Before starting anything else from the roadmap in `README.md`, check it
against this section. Multiplayer is no longer the thin half — apply, cancel,
pause, resume, handoff, and live presence all closed on 2026-07-30, which was
the risk this document used to guard against. What is thin now is narrower:
the renderer's own test coverage, and packaging. Everything under *V1
architecture* and *Multiplayer protocol* below is built; what remains is
proving it on a machine nobody developed it on, and proving the UI layer the
way the worker's own logic already is.

## Benchmark results

All three Evaluation tasks pass against the real model, 2026-07-29. One run
each — an existence proof, not a rate.

| Task | Result | Model calls | Files changed |
| --- | --- | --- | --- |
| Bug fix | pass | 8 | 1 |
| Small feature | pass | 21 | 4 |
| Repository reasoning | pass | 15 | 1 |

Each scores against a hidden regression test the agent never sees, and the
scorer re-runs the suites itself rather than believing what the agent reported.
A run that edits the committed tests is refused outright.

Repository reasoning is the one worth reading. Its fixture has a shared range
selector that is closed at both ends; the daily rollup double-counts midnight
because of it, and the obvious fix — narrowing the selector — makes the whole
visible suite pass while silently breaking the retention caller that depends on
the closed bound. Verified: with that fix the visible suite is 18/18 green and
the hidden test fails. The agent did not take it. It read the other caller,
explained why compaction needs the closed upper bound, and changed the day
boundary in the one place that wanted it.

Small feature failed twice before it passed, and both failures were the
harness's rather than the model's. The first hit a sixteen-step ceiling with
eleven steps spent legitimately reading an unfamiliar repository. The second
died when the model sent a malformed tool call and the validation error escaped
the run loop, ending the run with no receipt and nothing in the log explaining
it. Both are fixed, and the second is why the loop is bounded by a budget rather
than a step count.

What this does not establish: one run per task says nothing about a rate, all
three fixtures are small, and only the private leg of the Evaluation grid has
been measured — the shared run with a human intervention and the two forked
attempts both need Milestones 3 and 4.

## Demo

1. The host opens the Novus macOS app.
2. The host selects a local Git repository.
3. The host enters: `Fix the failing authentication refresh test`.
4. Novus creates a session and starts its coding agent.
5. A teammate opens the invite link.
6. Both participants see model messages, tool activity, changed files, tests,
   cost, and current status in real time.
7. The teammate adds a constraint: `Do not change the token schema`.
8. The runtime applies that direction at the next safe agent-turn boundary.
9. The host checkpoints the run and creates a fork.
10. One attempt fixes the locking behavior; another changes retry behavior.
11. Each attempt runs in its own Git worktree.
12. Novus displays both diffs, test results, time, cost, and summaries.
13. The teammate reviews and the host selects one attempt.
14. Novus applies the selected result to the original working branch.
15. The session remains replayable as an ordered timeline.

## Scope

### Included

- macOS desktop host
- Browser-based guest session
- One local repository per session
- One first-party coding-agent loop
- One model provider initially
- Bring-your-own API key
- Repository search, file reading, patching, terminal, Git, and tests
- Live ordered event stream
- Owner, editor, reviewer, and viewer roles
- Presence
- Human direction
- Pause, resume, cancel, and handoff
- Checkpoint and one-level session forks
- Git worktree isolation
- Compare screen
- Run receipts
- Local session persistence

### Explicitly excluded

- General-purpose AI collaboration
- Mobile applications
- Voice and video
- More than one repository per session
- Autonomous merging without human approval
- Full cloud coding environments
- Enterprise SSO and billing
- Fine-tuning or training models
- Learned model routing
- Large agent teams
- Long-term organizational memory
- Jira, Linear, and Slack integrations
- Adapters for every existing coding harness

## V1 architecture

```text
Host macOS application
  ├── React renderer
  ├── Electron main process
  ├── secure preload bridge
  └── local agent worker
        ├── agent loop
        ├── model adapter
        ├── context builder
        ├── native tools
        ├── policy/approval gate
        ├── Git worktree manager
        └── local event store
                  │
                  │ outbound authenticated WebSocket
                  ▼
        Multiplayer session service
          ├── session authority
          ├── ordered event relay
          ├── presence
          ├── roles
          └── control/direction queue
                  │
                  ▼
          Browser guest client
```

### Security boundary

The host machine is the execution authority:

- Source code remains local by default.
- Provider credentials remain in the desktop host's secure storage.
- The browser guest never obtains terminal or filesystem access.
- Guests request actions through the session service.
- The desktop host validates role and policy before acting.
- Sensitive commands require host approval.
- Only explicitly shareable events and artifacts leave the host.

## Recommended stack

Use stable current releases when implementation begins; pin exact versions in
the lockfile rather than hard-coding version numbers in this document.

| Layer | Choice | Reason |
| --- | --- | --- |
| Desktop | Electron, React, Vite, TypeScript | Mature macOS distribution and shared TS types |
| Local worker | Node.js in a separate process | Strong process/tooling APIs and failure isolation |
| Validation | Zod | Runtime validation across every trust boundary |
| Local storage | SQLite | Durable local sessions without operating a database |
| Guest client | React and Vite | Small shared-session client |
| Session API | TypeScript service with WebSocket support | One language and explicit real-time protocol |
| Cloud metadata | PostgreSQL | Sessions, participants, roles, and invite records |
| Ephemeral coordination | Redis only when needed | Presence and horizontal fan-out, not initial truth |
| Repository isolation | Git worktrees | Native, inspectable, and cheap branching |
| Model access | Thin provider adapters | Avoid locking the harness to one SDK |
| External tools | MCP after native tools | Extensibility without weakening core observability |
| Testing | Vitest plus Playwright | Unit, protocol, UI, and multi-client tests |

Do not add Docker, Kubernetes, Temporal, LangGraph, a vector database, or a
microservice fleet before V1 proves it needs them.

### Why no LangGraph initially?

The core V1 loop is small and needs precise control over tool execution,
interruption, event ordering, and replay. Novus should use its own typed state
machine:

```text
idle
  → assembling_context
  → awaiting_model
  → awaiting_tool_approval
  → executing_tool
  → evaluating_observation
  → awaiting_human
  → completed | failed | cancelled
```

LangGraph can be reconsidered for customer-authored workflows later. It should
not define the product's fundamental execution or multiplayer semantics.

## Agent loop

The first coding agent is deliberately small:

```text
receive goal
  → inspect repository instructions and Git state
  → assemble relevant context
  → call model with available tool schemas
  → validate requested tool call
  → check permission policy
  → execute tool
  → persist event and observation
  → return observation to model
  → repeat until complete, blocked, or over budget
  → run final verification
  → produce receipt
```

### Initial native tools

1. `list_directory`
2. `search_repository`
3. `read_file`
4. `apply_patch`
5. `run_command`
6. `git_status`
7. `git_diff`
8. `run_tests`

Tools return structured results—not terminal-shaped prose when reliable machine
data is available.

### Permissions

Start with three classes:

- **Read:** repository search and file reads; allowed automatically.
- **Write:** patches inside the selected repository, including creating a file
  and deleting one; session-owner configurable. Deletion is deliberately in
  this class rather than Dangerous — an ordinary patch could already blank a
  file's contents, so a separate class for removing it would be a distinction
  the threat model does not actually make — but it does mean
  `NOVUS_ALLOW_WRITES=1` authorises removal without a per-call prompt. Every
  deletion still goes through propose-then-apply, so what is being authorised
  is reviewable as a diff first.
- **Dangerous:** arbitrary commands, network access, destructive Git operations,
  paths outside the repository, and secrets; explicit approval required or denied.
  One narrow exception: `list_provider_models` is network but classed Read — it
  takes no arguments, asks one fixed question of the provider endpoint every
  model call already trusts with the full conversation, and returns a list of
  ids. Nothing about it is model-controlled, so there is no argument vector the
  Dangerous class exists to gate. See the comment beside `TOOL_CLASSES` in
  `apps/worker/src/policy.ts` for the same reasoning in place.

V1 must reject path traversal and commands outside declared policy. It must never
use `git reset --hard`, overwrite uncommitted user work, or silently modify the
host's primary branch.

## Multiplayer protocol

All participants consume one ordered session log.

Minimum event families:

```text
session.created
participant.joined
participant.left
control.requested
control.transferred
direction.submitted
direction.applied
run.started
run.state_changed
model.requested
model.responded
tool.requested
tool.approval_requested
tool.approved
tool.completed
artifact.created
checkpoint.created
fork.created
evaluation.completed
decision.recorded
run.completed
run.failed
```

Every event includes:

- Event ID
- Session ID
- Run/fork ID when applicable
- Monotonic sequence number
- Actor
- Timestamp
- Typed payload
- Visibility classification

The server assigns sequence numbers. Clients may optimistically display pending
messages, but server-confirmed order is canonical.

### Direction and interruption

Humans do not mutate a prompt that is already executing.

1. A participant submits direction.
2. It enters the ordered control queue.
3. The UI immediately shows it as pending.
4. The worker finishes or cancels the current atomic tool action.
5. The runtime adds the direction to the next model turn.
6. A `direction.applied` event confirms incorporation.

Pause prevents the next model/tool step. Cancel terminates the run. Emergency
termination may kill a child process, but the event log must state that the
resulting state may be incomplete.

### Handoff

A handoff changes who has execution authority; it does not copy a transcript.

The receiving participant inherits:

- Current goal and constraints
- Run state
- Repository revision/worktree
- Pending approvals and direction
- Artifacts and evaluation evidence
- Remaining budget

The handoff is an explicit event accepted by the recipient.

## Forking

A fork begins from a checkpoint containing:

- Parent run and event sequence
- Git commit or immutable patch base
- Agent state summary
- Relevant context manifest
- Goal and constraints
- Model/provider configuration
- Tool policy and remaining budget

Each fork receives:

- A unique run ID
- Its own Git worktree
- Its own development ports
- Its own event stream under the parent session

**Not its own process.** An attempt runs as an in-process `AgentRunner` inside
the worker, sharing its process, environment, and lifetime. This line used to
claim a process namespace per fork; that was vacuously true while nothing
executed in a fork at all, and became plainly false once something did. What
the isolation actually rests on is the worktree, a per-attempt runner with its
own tools and approval gate, and per-run local state — not an OS boundary. The
practical consequences: the worker exiting takes every running attempt with it,
and an attempt cannot be resource-limited apart from the worker. Both are worth
closing before this is trusted with long or untrusted runs.

Forks never write to the same working directory.

**What worktree isolation does not give you.** A `git worktree` shares one
repository, so the object database, every ref, the stash, and the hooks
directory are common to the parent and every fork. A fork that can run commands
can move the parent's branch with `git update-ref`, delete a live sibling with
`git worktree remove --force`, or leave a hook that fires on the parent's next
commit — all demonstrated in an audit on 2026-07-29. Isolation holds for the
working tree and not for the repository.

This is tolerable in V1 only because reaching any of it requires `run_command`,
which is `dangerous`, denied by default, and opted into per session. It stops
being tolerable the moment forks run with commands enabled by default, and the
fix then is a separate object store per attempt — a clone rather than a
worktree, paid for in disk and checkout time.

### Compare

V1 comparison includes:

- Diff summary and complete patch
- Changed files
- Test/build results
- Diagnostics
- Final agent explanation
- Human interventions
- Model and token usage
- Cost and elapsed time
- Evaluation rubric score

The final merge is always a human decision in V1.

## Persistence and replay

The local host stores the complete privileged event log in SQLite. The session
service stores the shared event subset and collaboration metadata.

Replay reconstructs UI and session state from events. It does not re-run shell
commands. Re-execution is a separate operation created from a checkpoint.

Potentially sensitive values are redacted before events leave the worker:

- Environment variables
- API keys and tokens
- Credential files
- User-configured secret patterns
- Command output matching known secrets

## Evaluation

V1 needs three repeatable benchmark tasks:

1. **Bug fix:** a repository with a failing test and a hidden regression test.
   Built. `benchmarks/bug-fix/`, run with `./scripts/benchmark.sh`, scored by
   `apps/worker/src/benchmark.ts`.
2. **Small feature:** a clear request requiring changes across several files.
   Not built.
3. **Repository reasoning:** a task where the obvious local change is wrong
   without understanding a dependency elsewhere in the repository. Not built.

A benchmark fixture is committed and never run in place. The runner copies it to
a scratch Git repository under the system temporary directory, and that copy is
the only thing writes and commands are enabled against — the runner refuses to
proceed against a path it did not create there, because enabling both
permissions is only defensible for a directory that is disposable by
construction.

For each benchmark, run:

- The same agent privately without Novus collaboration.
- One shared Novus run with a human intervention.
- Two forked Novus attempts followed by comparison.

Record:

- Task success
- Public and hidden test results
- Time to accepted result
- Human attention time
- Number and timing of interventions
- Tokens and cost
- Merge conflicts
- Whether a reviewer can explain why the result was chosen

V1 is promising when multiplayer improves decision quality or human coordination
without making every small task slower.

Of that grid — three tasks by three configurations — one cell has been filled:
the bug-fix task, run privately, once, on 2026-07-29. It passed. The two shared
configurations are not blocked on writing more benchmarks; they are blocked on
Milestones 3 and 4, which is the same asymmetry *Where we actually are* names
at the top of this document.

## Build order

### Milestone 1 — foundation

- [x] Workspace and package structure
- [x] Desktop window and browser guest shell — both real; the guest resumes by
      sequence after a drop and names the failure it hit instead of a blank screen
- [x] Shared contracts package
- [x] Electron renderer/main/preload/worker boundaries
- [x] Local SQLite event store — `node:sqlite`, WAL, at `.novus/events.db`
- [x] Session and event schemas

Exit condition: a fake worker event appears identically in the host and guest UI.
**Met.** `reconnect.test.ts` drives this over a real SSE socket rather than
asserting a handler was called. What Milestone 1 did not include — a session
surviving a restart, not just its events — is now also true, fixed 2026-07-30.

### Milestone 2 — real single-agent harness

- [x] Repository selection
- [x] Model adapter and BYOK credential storage
- [~] Context assembly — goal plus prior turns; no repository context yet
- [x] Native read/search/patch/command/Git/test tools — all nine of the
      initial list exist and are wired into every session. The live benchmark
      run below reached for five of them unprompted. Since 2026-07-30 the set
      is sixteen: file creation and deletion joined the propose/apply flow
      (`propose_new_file`, `propose_deletion` — before that "write a new
      module" was only reachable through run_command, an unreviewable
      dangerous-class write), and README's remaining "Native tools" bullets
      landed as `run_diagnostics` (typecheck/lint with parsed
      file/line/severity output), `run_build`, `dev_server`
      (start/stop/status/logs for processes that outlive a call, killed with
      the worker so nothing leaks a port), and `git_branches`. What none of
      them are proven against yet: a live model turn — every one is
      deterministic-tested only, the same standing the rest of this table had
      before its benchmark run.
- [x] State machine and permission checks
- [x] Streaming execution timeline
- [x] Final receipt

Exit condition: the agent completes the bug-fix benchmark locally and produces a
reproducible diff and test receipt. **Met 2026-07-29, once.** The benchmark is
`benchmarks/bug-fix/`: a token bucket whose refill accumulator is reset to *now*
instead of advanced by the intervals it credited, so a caller polling faster
than the refill interval destroys its own credit a fraction at a time and starves
forever. `./scripts/benchmark.sh --live` copies that fixture to a scratch Git
repository, hands the agent a goal, and scores what comes back.

The live run, against `anthropic/claude-opus-5`: eight model calls, seven tool
calls, 40,996 in / 3,443 out, 62s. It read the module, listed the directory,
read the README and the failing test, proposed one patch, applied it, and ran
the suite. It identified the cause correctly — that the discreteness was
intended and the bookkeeping was the bug — fixed it by advancing `lastRefillAt`
by `earned * intervalMs`, and reported what the suite actually said. The receipt
cites base `667b1f53`, one file changed (+9/-3), one test run that followed the
final change, and two approvals.

What makes that a result rather than a self-report is the scoring. The runner
re-runs the fixture's own suite itself rather than believing the `run_tests`
observation the agent saw, and then runs a hidden regression test that is not in
the fixture, is not named by its test script, and is copied in only after the
agent has stopped. The hidden test uses different intervals and refill rates than
the visible one and pins the properties the visible suite only implies, so
deleting the assertion, special-casing the failing input, or replacing discrete
refill with a continuous trickle all score as failures. The scorer is itself
tested against an agent that cheats — it neuters the failing assertion, `npm test`
goes green, and the benchmark returns FAIL naming both the modified test file and
the hidden test.

What this does not establish. One run is an existence proof, not a rate: nothing
here says how often the agent succeeds, and the fixture is one small
single-file bug rather than a repository anyone works in. The other two tasks
under *Evaluation* — small feature, repository reasoning — now exist and have
each passed against the real model once too; see *Benchmark results* below for
what they actually tested. Two of the three run configurations that section
asks for still have not run, though: a shared run with a human intervention and
two forked attempts compared need Milestone 3's and 4's transport and worktree
work respectively, both of which now exist but have not yet been pointed at the
Evaluation grid. What has been measured is the private leg, three times. The
deterministic variant runs in the gate and keeps the *harness* path proven
without a provider call, but it proves the harness carries a fix, not that a
model finds one, and no count of green gates substitutes for a live run.

The receipt reports files it *patched*. A run that writes through `run_command` —
codegen, a formatter — changes files the receipt does not list, and the
"tests ran after the last change" check inherits that blind spot. Closing it
needs a diff against the base at run end, which belongs with Milestone 4.

Command execution is denied by default and opted into with
`NOVUS_ALLOW_COMMANDS=1`, kept separate from `NOVUS_ALLOW_WRITES` because
approving a reviewable diff and approving arbitrary code are different
decisions. Note that the allow-list gate pre-authorises rather than asking per
call, so that flag is blanket authorisation for the session — a per-call human
gate is still owed, and is what Milestone 3's approval flow should replace it
with.

### Milestone 3 — multiplayer control

This is the half that decides whether Novus is Novus, and most of it is real
now.

- [x] Session service — SQLite-backed event store behind the worker's HTTP+SSE
      routes, plus a standalone WebSocket relay (`apps/session-service`) for a
      teammate off the host machine
- [x] Invite links — `POST /sessions/:id/invite` mints a one-time,
      role-scoped token; reachable from the desktop UI, not curl only
- [x] Presence and roles — roles are real (owner/editor/reviewer/viewer,
      enforced per-route by capability); presence is now live too: `GET
      /sessions/:id/presence` reports who has an open event stream right now,
      separate from `participant.joined`'s "who was ever invited". Both the
      desktop and guest UIs poll it and show a live dot next to whoever is
      actually watching.
- [x] Ordered event replication — the relay and the worker both replay by
      sequence; a client that drops and returns holds the same log as one that
      never left
- [x] Direction queue — `POST /sessions/:id/direction` records
      `direction.submitted` for the runtime to fold in at its next turn
      boundary; has a UI box now, not curl only
- [x] Approvals — the gate and the tool classes exist and are enforced
- [x] Pause, resume, cancel, and handoff — all four now exist. **Cancel**:
      `POST /sessions/:id/cancel` records `run.cancel_requested`, and the run
      loop checks for it at the same turn boundary direction is folded in at
      — a tool call already in flight finishes, only the next model call is
      refused — then appends `run.cancelled`. **Pause** works the identical
      way through `POST /sessions/:id/pause` and `run.pause_requested` /
      `run.paused`, except it is not terminal: no receipt is produced,
      because the run has not ended. **Resume**, through `POST
      /sessions/:id/resume`, restarts the same run under the same id rather
      than starting a new one — it rebuilds the paused turn's tool exchanges
      from the event log the same way `direction` and `cancel` already read
      state from the log instead of memory, so the model does not lose
      context it had already built up. What resume does *not* carry forward:
      token usage, never logged per call so there is nothing to rebuild it
      from, and the run's budget clock, which also resets — both are
      disclosed in `agent-runner.ts`'s own comments and in *Where we actually
      are* above, not surfaced in the timeline. **Handoff**, through `POST
      /sessions/:id/handoff`, actually moves execution authority rather than
      only recording that it happened — it drives `participants.ts`'s
      `transferOwnership`, which existed before this but was never wired to a
      route. Only the current owner can call it, checked twice: once by the
      route's own capability table, once by the registry. It is atomic rather
      than a two-step accept — see *Where we actually are* for that gap
      against this document's own description of handoff below.
      `control.requested` also has a real route now
      (`POST /sessions/:id/control/request`), open to any participant, but no
      UI calls it yet — see *Where we actually are*.

Exit condition: a remote teammate joins an active run, supplies direction, and
reviews the resulting evidence. **Met**, and now for the whole milestone
rather than one path through it — join, direct, review, cancel, pause,
resume, and handoff all work end to end, proven in
`pause-resume.test.ts` (the run-loop level, including that a resumed run
actually replays its prior tool exchange to the model), `pause-resume-route.test.ts`
and `handoff-route.test.ts` (the HTTP level, including that a handoff which
demotes the caller is refused a second time), and `presence.test.ts` (a real
SSE connection flipping presence live and back). What is not covered by any
of that: the desktop and guest UI code that calls these routes, which is the
renderer test-coverage gap named above and applies here as much as anywhere
else in this milestone.

### Milestone 4 — fork and compare

Both halves are built now. The isolation half was already tested hard —
worktree lifecycle, checkpoint correctness, and cross-attempt isolation each
have their own adversarial tests (uncommitted work surviving a fork, an
aggressive prune not breaking a checkpoint's base, teardown removing the
worktree *and* the branch *and* Git's record of both). The decision half is
new as of 2026-07-30 and holds to the same bar: real conflicting edits, not
just the happy path.

- [x] Checkpoint creation
- [x] Git worktree manager
- [x] Isolated child runs — an attempt now genuinely executes: `POST /fork`
      starts a child `AgentRunner` in the fork's own worktree, under the fork's
      own run id, with its tools confined there and its approval gate the
      intersection of the parent session's permissions and the ones the
      checkpoint recorded. Two attempts run concurrently without touching each
      other, proven by a rendezvous barrier that fails rather than hangs if the
      runs are secretly serialised. Until 2026-07-30 this box was ticked for a
      route that cut a worktree, recorded `fork.created`, and never ran
      anything — the isolation tests passed because they tested the worktree
      manager directly, not the product. Two live gaps remain, both recorded
      below rather than hidden: an attempt interrupted by a worker exit stays
      `running` on the record forever, and nothing ever tears a fork's worktree
      down.
- [x] Side-by-side comparison — `compare.ts` plus a real compare screen in the
      desktop UI, with a working "Fork an attempt" flow
- [x] Human decision record — `POST /sessions/:id/decision` appends
      `decision.recorded` naming the chosen attempt, unconditionally: a host
      choosing an attempt whose patch no longer applies is still a decision
      worth keeping, so this is not gated on the apply below succeeding. The
      compare screen reads it back from `/compare` on refresh rather than
      holding it as throwaway local state, so a second window or a reload
      agrees with what was actually chosen.
- [x] Apply selected patch — `apply-decision.ts` writes the chosen attempt's
      changes into the parent's working tree, gated on the session having
      writes enabled. It reuses `propose_patch`/`apply_patch` verbatim per
      file — a whole-file edit checked against live content before anything
      is written, the same tool classes and the same drift check the agent
      loop already uses, not a second way to touch a file. New and deleted
      files (which those two tools cannot express — `propose_patch` refuses a
      path that is not already a file) get the same base-content check by
      hand. Every file is checked before any file is written, so one
      conflicting file refuses the whole apply rather than half-writing the
      rest. Verified against a real fork with a real conflicting parent edit,
      in the test suite and by hand against a running worker: the apply is
      refused, the conflict names the file and why, and the host's own edit is
      left exactly as it was.

Exit condition: two attempts run from the same checkpoint without interfering,
and the selected result applies cleanly. **Met.** The non-interference half
was already proven; the apply half now has its own tests covering the same
kind of adversarial case — a parent that diverged after the fork was cut —
rather than only the case where nothing else changed.

### Milestone 5 — hardening

- [x] Reconnect and resume — `reconnect.test.ts`, over a real socket
- [x] Crash recovery — `replay.test.ts` and `session-registry.test.ts` simulate
      a store that fails mid-write, the way a full disk actually does
- [x] Secret redaction — `redaction.test.ts`
- [x] Authorization tests — `access.test.ts`
- [x] Event replay tests — `replay.test.ts`
- [x] Multi-client end-to-end tests — also `reconnect.test.ts`; it drives two
      clients against one real store over one real socket
- [ ] Packaging and signed macOS build — not started. No `electron-builder` or
      `electron-forge` config exists yet, no entitlements, no notarization.

Exit condition: the complete demo works repeatedly on a clean machine and survives
a host UI restart without losing session history. **Not met** — every item
above is unit- and integration-tested on a developer machine, but until
2026-07-30 the actual restart-and-resume path was silently broken in the
desktop UI (see *Where we actually are*), so the exit condition as stated —
tested on a clean machine, repeatedly — has not been attempted even now that
the bug is fixed. Packaging alone blocks "a clean machine" outright.

## Fast implementation timeline

This is an aggressive prototype schedule, not a promise of production maturity.

| Days | Target |
| --- | --- |
| 1–2 | Foundation, schemas, desktop/worker boundary, event log |
| 3–6 | First real coding-agent loop and tools |
| 7–9 | Session service, guest client, presence, shared direction |
| 10–12 | Checkpoint, worktree fork, comparison, selection |
| 13–14 | Benchmarks, reconnect behavior, security pass, demo polish |

After the prototype, spend the next four to six weeks improving reliability,
testing with real pairs of engineers, and learning which collaborative action
provides the strongest repeated value.

## First implementation task

Start with the event model, not the visual design and not the model API.

Build a vertical skeleton in which:

1. The desktop host creates a session.
2. A local worker emits typed fake execution events.
3. Events are persisted locally.
4. The session service assigns global ordering.
5. A browser guest receives the same events.
6. Refreshing either client reconstructs identical state.

Once that foundation works, replace the fake worker with the first real
model-and-tool loop. This prevents the agent runtime and multiplayer system from
developing as two incompatible products.

## Definition of done

V1 is complete when two real people on separate devices can:

- Join the same coding-agent session.
- Understand its current state without a verbal recap.
- Safely redirect and hand off the work.
- Fork from a shared checkpoint.
- Observe two isolated agent attempts.
- Compare their code and verification evidence.
- Select and apply one result.
- Replay the complete history afterward.

