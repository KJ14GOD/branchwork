---
name: novus-build-harness
description: Build, extend, debug, or review the Novus coding-agent harness while preserving its typed tool loop, provider-neutral model boundary, repository safety, observable event history, and single-user-first product sequence. Use for changes to agent execution, model adapters, routing, tools, permissions, context, evaluation, replay, sessions, or harness architecture in the Novus repository.
---

# Novus Build Harness

Implement one complete, testable harness capability at a time. Preserve the
long-term multiplayer architecture without making multiplayer infrastructure a
prerequisite for a useful single-user coding agent.

## Begin every run

1. Locate the repository with `git rev-parse --show-toplevel`.
2. Read `README.md` for the product thesis and `V1_README.md` for scope.
3. Read [references/architecture.md](references/architecture.md).
4. Inspect the current implementation before proposing abstractions. Prefer
   `rg` and targeted file reads.
5. Check `git status --short` and preserve unrelated user changes.

Treat source code as authoritative when it differs from the architecture
reference. Update the reference only when the implemented architecture changes.

## Preserve these boundaries

- The model proposes actions; Novus validates and executes them.
- Models never receive unrestricted filesystem, terminal, Git, or secret access.
- Every provider implements the same small model adapter contract.
- Every tool request and result uses a runtime-validated shared contract.
- Native tools enforce repository boundaries and return structured results.
- Consequential actions become ordered session events.
- A run may use many model turns, but it must remain cancellable and bounded by
  explicit time, cost, token, failure, and emergency-step policies.
- Build a capable single-user harness first. Keep session/run/actor/event
  identities so concurrency and multiplayer can be added without replacing the
  execution core.

## Build workflow

1. State the smallest user-visible capability and its acceptance test.
2. Trace the complete vertical path:

   ```text
   contract → model schema → runner → tool/policy → event → test/demo
   ```

3. Reuse an existing boundary before adding a package or framework.
4. Implement the narrowest production-shaped version.
5. Add:
   - a successful behavior test;
   - a trust-boundary or failure test;
   - runtime validation where data crosses components.
6. Run `pnpm typecheck`, `pnpm test`, and `git diff --check`.
7. Run a live provider call only when it materially validates the capability.
   Never print, inspect, or commit provider secrets.
8. Report what is real, what remains scripted, and the next missing capability.

## Engineering rules

- Prefer Node.js and TypeScript already present in the workspace.
- Prefer native, inspectable tools for search, files, patches, commands, Git,
  tests, diagnostics, and browser control.
- Use MCP for external systems, not for core repository operations.
- Use `apply_patch` for code edits.
- Do not introduce LangGraph, a workflow engine, containers, queues, a vector
  database, or cloud execution without a demonstrated requirement.
- Do not add a generic abstraction before two concrete implementations need it.
- Do not silently expand read access to `.env`, `.git`, or paths outside the
  selected repository.
- Do not increase an agent-loop ceiling to conceal repetition. Add visibility,
  inspect the trajectory, and fix the cause.

## Capability sequence

Unless evidence changes the order, build:

1. repository discovery and reading;
2. structured patch proposal and diff preview;
3. permissioned patch application;
4. command and test execution;
5. Git status/diff and run receipts;
6. cancellation, failure recovery, and resume;
7. a second model plus manual execution profiles;
8. eval-driven routing;
9. worktree forks and comparison;
10. shared multiplayer sessions and handoffs.
