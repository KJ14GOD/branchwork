# Novus Harness Architecture

Use this reference to orient quickly. Verify it against source before relying on
details, and update it after structural changes.

## Product direction

Novus is building a first-party coding harness that becomes multiplayer after it
is valuable for one engineer. Its differentiation is inspectable execution,
skills, evaluation, routing, forks, comparison, and eventually shared control.

## Current execution

```text
worker.ts
  → FixedModelRouter
  → AnthropicModelAdapter (Claude Sonnet 5)
  → AgentRunner
      → search_repository
      → read_file
      → propose_patch (preview only, never writes)
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
- Tool failures returned to the model as observations (`is_error` tool results)
  so it can correct a rejected call, recorded as `tool.failed` events.
- Sixteen-step emergency loop ceiling, a three-consecutive-failure cap, and a
  `run.failed` event on every unsuccessful exit — a run never ends by throwing.

## Known limitations

- The runnable goal and participant/session IDs are still hardcoded.
- The event store is in memory.
- A proposed patch cannot yet be applied; there is no approval boundary.
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

Add permissioned patch application. `apply_patch` should take a `patchId` from
an existing proposal, re-read the file, refuse to write when it no longer
matches the recorded base content, and pass through an explicit approval
boundary that emits `tool.approval_requested` and `tool.approved` events.

This is the first Write-class tool, so it is also where the permission classes
in V1_README become real rather than implied.
