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
- **Write:** patches inside the selected repository; session-owner configurable.
- **Dangerous:** arbitrary commands, network access, destructive Git operations,
  paths outside the repository, and secrets; explicit approval required or denied.

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
- Its own process namespace
- Its own development ports
- Its own event stream under the parent session

Forks never write to the same working directory.

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
2. **Small feature:** a clear request requiring changes across several files.
3. **Repository reasoning:** a task where the obvious local change is wrong
   without understanding a dependency elsewhere in the repository.

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

## Build order

### Milestone 1 — foundation

- Workspace and package structure
- Desktop window and browser guest shell
- Shared contracts package
- Electron renderer/main/preload/worker boundaries
- Local SQLite event store
- Session and event schemas

Exit condition: a fake worker event appears identically in the host and guest UI.

### Milestone 2 — real single-agent harness

- Repository selection
- Model adapter and BYOK credential storage
- Context assembly
- Native read/search/patch/command/Git/test tools
- State machine and permission checks
- Streaming execution timeline
- Final receipt

Exit condition: the agent completes the bug-fix benchmark locally and produces a
reproducible diff and test receipt.

### Milestone 3 — multiplayer control

- Session service
- Invite links
- Presence and roles
- Ordered event replication
- Direction queue
- Pause, resume, cancel, approvals, and handoff

Exit condition: a remote teammate joins an active run, supplies direction, and
reviews the resulting evidence.

### Milestone 4 — fork and compare

- Checkpoint creation
- Git worktree manager
- Isolated child runs
- Side-by-side comparison
- Human decision record
- Apply selected patch

Exit condition: two attempts run from the same checkpoint without interfering,
and the selected result applies cleanly.

### Milestone 5 — hardening

- Reconnect and resume
- Crash recovery
- Secret redaction
- Authorization tests
- Event replay tests
- Multi-client end-to-end tests
- Packaging and signed macOS build

Exit condition: the complete demo works repeatedly on a clean machine and survives
a host UI restart without losing session history.

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

