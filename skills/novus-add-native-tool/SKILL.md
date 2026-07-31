---
name: novus-add-native-tool
description: Add a native tool to the Novus agent as a complete vertical slice — contract, description, implementation, permission class, sharing and redaction boundaries, both renderers, and the tests that pin them together. Use when adding or substantially changing a tool, when a tool renders wrong or empty in a UI, or when deciding which permission class an operation belongs in.
---

# Novus Add Native Tool

A tool is not added when it executes. It is added when the model can be
offered it, a human can see what it did, a remote guest sees the same thing
the host does, and the approval gate knows which class it is. Half of that is
compiler-enforced; the other half has been missed twice, and both misses
reached the same audit: six new tools that opened empty panels, and a file
deletion approved without anyone being shown what it would remove.

## Decide the class and shape before writing code

**Permission class** (`TOOL_CLASSES` in `apps/worker/src/policy.ts`):

- **read** — pure repository reads. One precedent for a network read:
  `list_provider_models` is classed read because it takes no arguments, so
  there is no model-controlled vector for the dangerous class to gate. A new
  network tool only gets this treatment under the same conditions.
- **write** — `apply_patch` is deliberately the *only* write-class tool. A
  new destructive filesystem effect does not get its own write tool; it gets
  a proposal tool (see below) and flows through `apply_patch`. If you think
  you need a second write path, read `apply-decision.ts` first — server-side
  writes reuse the same two tools with synthetic calls.
- **dangerous** — anything that executes project-defined or arbitrary code
  (`run_command`, `run_tests`, `run_build`, `run_diagnostics`, `dev_server`).
  Enters the allow-list in `buildApprovalGate` under `NOVUS_ALLOW_COMMANDS`.

**Execution shape:**

- Request/response (`run_command`'s shape): reuse its spawn discipline — no
  shell, detached group, kill the group, settle after a drain, scrubbed env.
- A process that outlives the call (`dev_server`'s shape): the failure mode
  is a leaked process holding a port, so its lifetime must be bounded by the
  worker's (`stopAllDevServers` on the shutdown path) and anything that runs
  with commands enabled — the benchmark harness included — must stop what it
  started. The tool description is a promise to the model; teardown that
  breaks the promise is a bug even when no human notices.
- A destructive intent (create/delete/edit): a proposal tool. Proposing
  writes nothing; the destructive act happens only in `apply_patch` behind
  the write gate, and apply re-resolves the stored path rather than trusting
  it, so a forged proposal naming `../outside.txt` or `.env` is refused at
  apply time. Restate the drift check for your kind: a file that appeared
  refuses the create, a file that changed refuses the delete.

## The slice, in order

1. **`packages/contracts/src/contracts.ts`** — add the call variant to
   `ToolCallSchema` and the result variant beside it. This needs the
   contract lock (`./scripts/contract-lock.sh status`); run `contract-mapper`
   first if the reach is unclear.
2. **`apps/worker/src/tool-descriptions.ts`** — the model-facing description
   and input schema. Keep every promise it makes; describe *when* to call
   it, not only what it does.
3. **`apps/worker/src/tools.ts`** — the implementation, a class bound to
   `repositoryPath` at construction. Every path goes through
   `resolveInsideRepository`. Probe confinement in tests rather than reading
   the resolver: absolute paths, `..` at several depths, normalising
   re-entry, symlinked files, symlinked parent directories, symlinks aimed
   at `.env` and `.git` — all refused (`tools.test.ts` is the pattern).
4. **`apps/worker/src/policy.ts`** — the class, and
   **`session-registry.ts`** — register in `buildTools` and, if dangerous or
   write, in `buildApprovalGate`'s allow-list. A tool described but not
   registered killed non-Anthropic sessions once (`list_provider_models` was
   described unconditionally, registered conditionally): register even when
   the capability is unavailable, and fail the *call*, not the run.
5. **`apps/worker/src/shareable.ts`** — decide what crosses to the guest and
   relay. Verdicts, structured lists, and lifecycle cross; raw stdout,
   diagnostic raw tails, and dev-server logs stay on the host; absolute host
   paths are withheld the way `git_branches` worktree paths and
   `fork.created`'s `worktreePath` already are. Do not fall through the
   default for a new result type — falling through is how build stdout
   nearly reached remote guests.
6. **`apps/worker/src/redaction.ts`** — if the tool carries command output
   or file contents under any name, the dotenv rule must see it. "`dev_server
   start cat .env`" was `run_command`'s leak wearing a different name; the
   logs result carries its command precisely so the rule can match
   statelessly.
7. **Both renderers.** `packages/ui/src/tool-results.ts`'s collapsed summary
   is guarded by a `satisfies never` — the compiler forces it. The expanded
   panel (`tool-result-panel.tsx`) and the diff view in `event-row.tsx` are
   **not** forced, and neither is the host/guest agreement about what counts
   as a patch (`apps/desktop/src/session-tab.tsx`'s filter and count versus
   `apps/guest/src/timeline.ts`). Every one of these was missed on the same
   commit once. The rule: grep for every place that switches on a tool name;
   any switch without a `satisfies never` is a place your tool does not
   exist yet. A proposal tool must render its diff — a deletion that shows
   no diff is a deletion approved blind — and must say "creates" or
   "deletes" in words, because an all-red diff and a large edit look
   identical right up until one is approved.
8. **Tests.** A success-path test, a trust-boundary test (confinement or
   drift), and — free of charge — `tool-coverage.test.ts`, which pins four
   agreements the compiler cannot: contract union ↔ descriptions
   (bidirectional), a permission class for every tool, a real session
   registering every described name, and every dangerous tool reachable when
   the host allows commands. If your tool is wired wrong, this file is what
   goes red first; treat it as the checklist, not an obstacle.

## Failure semantics

A tool failure returns to the model as `tool_result` with `is_error: true`.
A failing tool must never end a run — that invariant is in CLAUDE.md and
`merge-guard` audits for it. Validation errors from malformed model calls
become observations, not thrown errors (`model-response.test.ts`).

## Verify without spending

The gate (`pnpm typecheck && pnpm test && git diff --check`), then drive the
running app against a scripted adapter — `novus-run-app` for launching,
`novus-ui` for the zero-spend CDP verification pattern. Then update the
tool's row in PROGRESS.md, including that it has not seen a live model turn
— every tool added since 2026-07-29 is in that position, and the file says
so per tool.
