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
      → ordered tool events
  → final grounded response
```

The model requests tools but never executes host operations itself.

## Current packages

| Path | Responsibility |
| --- | --- |
| `packages/contracts` | Zod schemas and inferred shared types |
| `apps/session-service` | In-memory ordered event store and subscriptions |
| `apps/worker/src/model.ts` | Provider-neutral model and router interfaces |
| `apps/worker/src/anthropic-model.ts` | Anthropic message/tool translation |
| `apps/worker/src/agent-runner.ts` | Bounded model/tool execution loop |
| `apps/worker/src/tools.ts` | Repository-confined native tools |
| `apps/worker/src/worker.ts` | Current executable composition root |

## Implemented capability

- Real Anthropic API adapter using `claude-sonnet-5`.
- Scripted model adapter for deterministic tests.
- Repository content search using a bundled ripgrep binary.
- UTF-8 file reading.
- Repository traversal and symlink-escape protection.
- Explicit denial of `.env` and `.git` access.
- Ordered `run.started`, progress, tool request/result, and completion events.
- Live event subscriptions for terminal output and future UI streaming.
- Sixteen-step emergency loop ceiling.

## Known limitations

- The runnable goal and participant/session IDs are still hardcoded.
- The event store is in memory.
- No patching, command execution, tests, Git tools, cancellation, persistence,
  cost accounting, or session resume exists yet.
- Routing is fixed to one model.
- Skills are stored in `skills/` but are not yet discovered or loaded by the
  Novus runtime.
- The desktop and guest package manifests exist, but no product UI is active.

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

Add structured patch proposal and diff preview without immediately mutating the
working tree. After the proposed patch is visible and validated, add an explicit
approval boundary before application.
