Purpose: The single honest statement of what exists right now. Anyone reading only this file should know exactly what Novus can and cannot do today.
Authoritative for: current implementation status, evidence, known gaps, the current milestone.
Not authoritative for: what Novus should become (PRODUCT.md), how it should be built (ARCHITECTURE.md), how it should look (DESIGN.md), why choices were made (DECISIONS.md).
Update when: any capability changes state, in the same change that alters the capability. Status claims require an Evidence line.
Last reviewed: 2026-08-01

# Progress

## Current milestone

**Documentation foundation.** Establish the canonical documents and decision record so implementation can begin against stable contracts. This milestone contains no application functionality by definition.

## Status rules

- Every status is one of: **Not started**, **Partial**, **Implemented**, **Blocked**.
- **Implemented** and **Partial** require an Evidence line: a command with observed output, or a link to an artifact a human can inspect. Documentation is never evidence of functionality. Deterministic tests are evidence that the tested path works deterministically — they are never "live proof" of end-to-end behavior; only a real client exercising a real system is.
- The Golden V0 workflow ([README.md](README.md#the-golden-v0-workflow)) is the milestone gate for the first implementation: it is not done until two real clients execute all twenty steps.

## Application capabilities

All application capabilities are **Not started**. The previous prototype was removed in full (commit `50c4851`); none of its behavior carries over.

| Capability | Status |
| --- | --- |
| Authentication and sessions | Not started |
| Organizations and membership | Not started |
| Repository connection (GitHub App) | Not started |
| Mission creation and lifecycle | Not started |
| Invitations and participants | Not started |
| Roles and server-enforced capabilities | Not started |
| Control leases, requests, handoffs | Not started |
| Direction lifecycle | Not started |
| Workstreams and executions | Not started |
| Harness adapters (Claude Code, Codex) | Not started |
| Execution providers and cloud workspaces | Not started |
| Runner protocol (events, commands, reconnection) | Not started |
| Presence | Not started |
| Changes (diff) presentation | Not started |
| Verification evidence | Not started |
| Review and revision requests | Not started |
| Pull-request creation and tracking | Not started |
| Receipts | Not started |
| Missions surface | Not started |
| Mission Room surface | Not started |
| Review surface | Not started |
| Design token system and primitives | Not started |

## Documentation

| Item | Status | Evidence |
| --- | --- | --- |
| Canonical documents (README, PRODUCT, DESIGN, ARCHITECTURE, PROGRESS, DECISIONS, AGENTS, CLAUDE symlink) | Implemented | Files exist at repository root; `CLAUDE.md` is a symlink (`ls -la CLAUDE.md`); `scripts/gate.sh` exits 0 (run 2026-08-01) |
| Executable repository gate | Implemented | `scripts/gate.sh` exits non-zero on seeded violations and 0 on the current tree (run 2026-08-01; D-016) |
| Decision record | Implemented | [DECISIONS.md](DECISIONS.md) entries D-001 through D-023, including vendor selections D-019–D-023 |
| Harness feasibility — documentation-level | Implemented | Official-docs verification for Claude Code (headless, streaming, resume, permissions, auth) and Codex (exec/app-server, approvals, interrupt, auth), recorded with sources in D-017 |

## Known gaps

- No application code, tests, build system, or dependencies exist.
- Harness feasibility is proven at documentation level only (D-017). The hands-on spike — install, authenticate, stream, steer, approve, and interrupt both CLIs in a real clean Linux workspace on the chosen sandbox provider (D-023) — has not run. The adapter contract is not frozen until it does.
- The design token values in [DESIGN.md](DESIGN.md#tokens) have not been proven on a rendered screen; contrast ratios are calculated, not observed.
- The gate's source-code checks (gradients, raw colors, PROGRESS staleness) are dormant until application code exists.

## Blocked

Nothing is blocked. The next step is the harness feasibility spike, then the first implementation slice: a thin vertical skeleton — authenticate one user, create one mission, persist it, reconstruct it after refresh — with no agents and no visual flourish.
