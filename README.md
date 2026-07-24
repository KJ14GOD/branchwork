# Novus

**A multiplayer coding harness for humans and AI agents.**

Novus is a shared environment where engineers and coding agents work on the same
software task. Teammates can watch an agent execute, contribute context, redirect
it, hand off control, fork competing attempts, compare evidence, and merge the
best result.

The product is not a group chat placed beside a coding agent. Novus owns the
execution state: the repository, agent runs, tool calls, checkpoints, branches,
artifacts, approvals, tests, and final decision.

> Coding agents should not live in private sessions. Their work should be
> inspectable, steerable, and collaborative by default.

For the scoped first release, see [V1_README.md](./V1_README.md).

## The thesis

AI coding is becoming long-running and parallel. A meaningful task may involve
several agents, hours of execution, multiple human reviewers, and decisions that
outlive any one chat window.

Existing collaboration systems were designed around human-authored files and
tickets. Existing coding agents are primarily private sessions. Teams therefore
lose context when they copy agent output into Slack, send transcript links, or
manually explain what an agent attempted.

Novus makes the **agent session itself** a shared unit of work.

## Product

A Novus session begins with a repository and a goal:

```text
Fix the authentication race condition
                    │
              Shared session
                    │
       humans add context and constraints
                    │
            coding agent executes
                    │
        commands, patches and tests stream live
                    │
           ┌────────┴────────┐
           │                 │
      fork approach A   fork approach B
           │                 │
        Agent 1            Agent 2
           │                 │
           └────── compare ──┘
                    │
       human approves the stronger result
                    │
               merge to main
```

During the session, participants can:

- Watch the same live execution timeline.
- See which model, agent, tool, branch, and person produced each event.
- Add direction without reconstructing the agent's context.
- Pause, resume, cancel, or approve sensitive actions.
- Transfer responsibility between people or agents.
- Fork from a checkpoint into an isolated Git worktree.
- Run alternative approaches concurrently.
- Compare diffs, tests, cost, time, and evaluation results.
- Merge a selected result while retaining the complete history.
- Replay how the result was produced.

## Starting wedge

**Branch, compare, and merge shared coding-agent sessions.**

Basic multiplayer prompting is useful, but it is not enough. Novus is
differentiated by treating agent work like versioned execution:

1. Work has an owner and a live state.
2. Every consequential action becomes an event.
3. A session can checkpoint and fork.
4. Forks execute in isolated repository state.
5. Results are compared using evidence rather than presentation.
6. Humans decide what becomes canonical.

This wedge combines the strongest ideas from coding harnesses, Git, collaborative
editors, and durable workflow systems.

## What Novus is—and is not

Novus is:

- A real coding harness around foundation models.
- A shared control surface for humans and agents.
- A versioned execution system for agent work.
- A reliability and evaluation layer.
- Eventually, a model- and agent-agnostic collaboration platform.

Novus is not:

- A chat room with several bot personas.
- A thin wrapper around Claude Code or Codex.
- A Kanban board pretending to be an agent runtime.
- A fully autonomous system with no human control.
- A new foundation model.
- A replacement for Git.

Git versions source code. Novus versions the **work that produced it**.

## The coding harness

Novus starts with its own small coding-agent loop so the product can observe and
control execution at the lowest useful level.

```text
Goal
  → context assembly
  → model decision
  → tool request
  → policy and approval check
  → tool execution
  → observation
  → evaluation
  → continue, ask a human, or finish
```

### Native tools

Operations requiring maximum control and observability should be native:

- Repository search
- File and directory reading
- Structured patch application
- Terminal commands
- Git status, diff, branches, and worktrees
- Test and build execution
- Diagnostics
- Development-server and preview management
- Browser interaction later in V1

### Extensible tools

External systems should be added through typed adapters and MCP:

- GitHub
- Linear and Jira
- Documentation systems
- Databases
- Cloud providers
- Observability platforms
- Company-specific tools

### Model layer

Models are accessed through a provider-neutral interface. A run records the
provider, model, configuration, token usage, latency, and cost for every call.

Adaptive routing is part of the long-term harness, not the initial product
claim. Routing will eventually choose a model or agent using:

- Task type and estimated difficulty
- Required tools and context size
- Historical success on similar work
- Latency and cost budget
- Repository and organization policy
- Independent evaluation results

Users should be able to bring their own provider credentials. Novus must never
make a single model provider its architectural foundation.

## Multiplayer model

The shared session is an authoritative, ordered event stream—not several clients
mutating local state independently.

Core entities:

| Entity | Meaning |
| --- | --- |
| Workspace | Team, repositories, policies, members, and shared configuration |
| Session | One collaborative software mission |
| Participant | A human or agent attached to the session |
| Run | One agent execution within a session |
| Event | Immutable record of a message, tool call, patch, decision, or state change |
| Checkpoint | A recoverable point in execution and repository state |
| Fork | A child run created from a checkpoint |
| Handoff | Explicit transfer of responsibility or control |
| Artifact | Diff, test result, log, screenshot, plan, or report |
| Decision | Human approval, rejection, selection, or merge |
| Receipt | Reproducible summary of what ran and what proved the result |

### Roles and authority

- **Owner:** controls the session and repository.
- **Editor:** adds direction and can operate within granted permissions.
- **Reviewer:** comments, evaluates, and approves without directly executing.
- **Viewer:** observes the session.
- **Agent:** acts only through its declared tools and granted policy.

Only one authority controls a run at a time. Other participants may submit
direction, but the runtime applies it at a safe boundary rather than corrupting
an in-flight tool action.

## Architecture

```text
┌──────────────────────────────┐
│ Novus desktop host           │
│ React UI + secure bridge     │
└──────────────┬───────────────┘
               │ typed local IPC
┌──────────────▼───────────────┐
│ Local agent worker           │
│ loop · tools · policy · Git  │
└──────────────┬───────────────┘
               │ ordered session events
┌──────────────▼───────────────┐
│ Multiplayer session service │
│ auth · presence · relay      │
└──────────┬───────────┬───────┘
           │           │
    teammate web    teammate app
       client          client
```

### Desktop host

The repository, provider credentials, terminal, and privileged tools remain on
the host machine by default. The renderer never receives unrestricted Node.js,
filesystem, or terminal access.

### Local worker

A separate process runs the model loop and tools. A crash or malformed model
response cannot directly take down the UI. Every action crosses a typed,
validated boundary and is recorded before being shown as completed.

### Session service

The cloud service synchronizes approved session events, presence, participant
direction, and control messages. It does not require uploading the entire
repository. Later cloud execution can be offered as a separate deployment mode.

### Isolation

Parallel attempts use Git worktrees and separate process environments. They must
not share writable working directories, development ports, or mutable run state.

### Persistence

The event log is the source of truth. Current state is a projection that can be
rebuilt from events. Large artifacts are content-addressed and stored separately
from event metadata.

## Reliability

Multiplayer makes reliability more important, not less. A polished transcript is
not proof that an agent succeeded.

Each completed run should produce a receipt containing:

- Initial goal and frozen starting revision
- Context supplied to the model
- Models and prompts used
- Commands and tool results
- Files changed
- Git diff
- Tests, builds, and diagnostics
- Human interventions and approvals
- Evaluation result
- Cost, tokens, and elapsed time
- Final revision or patch

Evaluators can inspect correctness, policy compliance, regression risk, and
whether the evidence supports the agent's claim. Evaluators advise; deterministic
tests and humans retain final authority.

## Product principles

1. **Shared by default.** Important work should not disappear into private chats.
2. **Local authority first.** The host controls code, credentials, and execution.
3. **Events over transcripts.** Structured actions matter more than generated prose.
4. **Branch before conflict.** Competing attempts receive isolated state.
5. **Evidence over confidence.** Tests and receipts outrank confident summaries.
6. **Human authority is explicit.** Ownership and approvals are visible state.
7. **Interoperate.** Novus should host its own agent and adapt external harnesses.
8. **Earn autonomy.** More autonomy follows demonstrated reliability.

## Roadmap

### V1 — multiplayer local coding session

- One repository
- One native coding agent
- Desktop host
- Shareable live session
- Presence and roles
- Direction, pause, resume, and handoff
- One checkpoint/fork flow using Git worktrees
- Diff and test comparison
- Run receipt and replayable event timeline

### Early product

- Multiple model providers
- Multiple concurrent runs
- Rich approvals and organization policies
- GitHub pull-request workflow
- Session resume across devices
- External agent adapters for Claude Code, Codex, and OpenCode
- Browser, MCP, skills, hooks, and reusable workflows
- Repository-specific evaluation suites

### Expansion

- Learned model and agent routing
- Cloud and hybrid execution
- Cross-session organizational memory
- Agent-to-agent delegation
- Multiplayer debugging and incident sessions
- Shared session SDK and protocol

### Long-term vision

Novus becomes the collaboration and execution layer for AI work:

> Any consequential task can become a shared session where humans and agents
> coordinate live, branch approaches, transfer ownership, evaluate evidence, and
> preserve the history of how the result was produced.

Coding is the first vertical because repository state, Git branches, tests, and
builds make collaboration and quality measurable. The session model can later
extend to research, operations, customer escalations, contracts, and other work
where teams already gather around one important problem.

## Success

Novus is working when:

- A teammate joins an active agent run without receiving a verbal recap.
- Direction reaches the agent without corrupting the current action.
- Two approaches execute independently and remain reproducible.
- Reviewers can choose a result from diffs, tests, and receipts.
- The selected result merges cleanly.
- The complete session can be replayed after everyone disconnects.
- Teams prefer the shared session over sending private agent transcripts.
