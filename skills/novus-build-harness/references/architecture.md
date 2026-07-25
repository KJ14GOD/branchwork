# Novus Harness Architecture

Use this reference to orient quickly. Verify it against source before relying on
details, and update it after structural changes.

## Product direction

Novus is building a first-party coding harness that becomes multiplayer after it
is valuable for one engineer. Its differentiation is inspectable execution,
skills, evaluation, routing, forks, comparison, and eventually shared control.

## Current execution

```text
worker.ts (long-lived server)
  → SessionRegistry (one session per selected repository)
  → FixedModelRouter
  → AnthropicModelAdapter (Claude Sonnet 5)
  → AgentRunner
      → search_repository
      → read_file
      → propose_patch (preview only, never writes)
      → approval gate (write and dangerous classes)
      → apply_patch (the only tool that mutates the repository)
      → ordered tool events
  → final grounded response
       │
       └── event-server.ts (SSE, loopback only)
             → apps/desktop renderer timeline
```

The model requests tools but never executes host operations itself. The
renderer is a read-only projection of the event log; it holds no execution
authority and reaches the host only through the event stream.

## Current packages

| Path | Responsibility |
| --- | --- |
| `packages/contracts` | Zod schemas and inferred shared types |
| `apps/session-service` | In-memory ordered event store and subscriptions |
| `apps/worker/src/model.ts` | Provider-neutral model and router interfaces |
| `apps/worker/src/anthropic-model.ts` | Anthropic message/tool translation |
| `apps/worker/src/agent-runner.ts` | Bounded model/tool execution loop |
| `apps/worker/src/tools.ts` | Repository-confined native tools |
| `apps/worker/src/policy.ts` | Permission classes and the approval gate |
| `apps/worker/src/session-registry.ts` | Per-repository sessions and turn queueing |
| `packages/contracts/src/protocol.ts` | HTTP contract between a client and the worker |
| `apps/worker/src/diff.ts` | Dependency-free unified diff rendering |
| `apps/worker/src/event-server.ts` | Loopback SSE stream of one session's log |
| `apps/worker/src/worker.ts` | Current executable composition root |
| `apps/worker/src/demo.ts` | Scripted run for renderer development |
| `apps/desktop` | Vite/React renderer: timeline, diff review, `/` palette |

## Implemented capability

- Real Anthropic API adapter using `claude-sonnet-5`.
- Scripted model adapter for deterministic tests.
- Repository content search using a bundled ripgrep binary.
- UTF-8 file reading.
- Repository traversal and symlink-escape protection.
- Explicit denial of `.env` and `.git` access.
- Structured patch proposal from exact-match edits, rendered as a unified diff
  with `status: "proposed"`. The working tree is never written, and each
  proposal retains the content it was computed against so a later application
  step can detect drift.
- Ordered `run.started`, progress, tool request/result, and completion events.
- Live event subscriptions for terminal output and UI streaming.
- SSE event transport bound to loopback, with `since`/`Last-Event-ID` resume and
  mid-handshake buffering so a reconnect never drops or reorders an event.
- A renderer that streams the timeline live, validates every event against the
  shared contract before display, renders proposed patches as reviewable
  diffs, and exposes real actions through a `/` command palette.
- Multi-turn sessions. A runner keeps finished turns and replays them, so a
  follow-up question resolves against the earlier conversation. Each turn is
  its own run in the ordered log; turns within a session are serialised.
- Repository selection at runtime. Tools are constructed per session, so a
  client can point the worker at any directory without restarting it, and one
  session's tools cannot reach another's repository.
- A bidirectional client contract: `POST /sessions` to open a repository and
  `POST /sessions/:id/turns` to ask. Progress is never in the response — it
  arrives on the event stream, keeping the log the single source of truth.
- Permissioned patch application. `apply_patch` re-reads the file, refuses when
  it drifted from the proposal's base content, and refuses to apply twice.
- An approval boundary in front of every write and dangerous tool, emitting
  `tool.approval_requested` then `tool.approved` or `tool.denied`. With no gate
  configured the default denies, so a missing policy cannot silently permit a
  write. A denial returns to the model as an explained decision.
- Tool failures returned to the model as observations (`is_error` tool results)
  so it can correct a rejected call, recorded as `tool.failed` events.
- Sixteen-step emergency loop ceiling, a three-consecutive-failure cap, and a
  `run.failed` event on every unsuccessful exit — a run never ends by throwing.

## Known limitations

- The event store is in memory, and a client's session is React state only, so
  reloading the page returns to the repository picker even though the worker
  still holds the session.
- Conversation history grows without compaction, so a long session will
  eventually exceed the context window.
- There is no Electron shell yet, so the "desktop" app is a browser page and
  the repository is chosen by typing a path rather than a native picker.
- The approval gate is programmatic only. Nothing asks a human at approval
  time; the host pre-authorises tools before the run starts.
- No command execution, tests, Git tools, cancellation, persistence, cost
  accounting, or session resume exists yet.
- Routing is fixed to one model.
- Skills are stored in `skills/` but are not yet discovered or loaded by the
  Novus runtime.
- The renderer observes but cannot act: no goal entry, direction, approval, or
  cancellation reaches the worker yet. The event stream is one-directional.
- There is no Electron shell, so the renderer runs in a browser and the host
  security boundary is loopback binding rather than a preload bridge.
- The guest package manifest exists, but no guest client is active.

## Non-negotiable invariants

1. Keep provider code out of tool execution.
2. Validate untrusted model output before use.
3. Resolve and verify real paths before filesystem access.
4. Protect secrets and unrelated user work.
5. Record enough structured evidence to replay and evaluate a run.
6. Keep model choice replaceable.
7. Add concurrency by isolating runs; do not share mutable run state.
8. Treat the ordered session event log as the future multiplayer authority.

## Next milestone

Wrap the renderer in an Electron shell: main process, preload bridge, native
directory picker, and the worker spawned as a child process so the host is one
application rather than two terminals. Persist the chosen session so a reload
resumes it instead of returning to the picker.

Then command and test execution — capability 4. `run_command` and `run_tests`
are the first dangerous-class tools, so they inherit the approval gate but need
their own containment: an explicit argv rather than a shell string, a working
directory confined to the repository, a timeout, output caps, and redaction of
environment values before command output enters an event.

The approval gate should also gain a human-facing implementation, so a run can
pause for a decision rather than only consulting a pre-authorised allow list.
