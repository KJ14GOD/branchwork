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
| Canonical documents (README, PRODUCT, DESIGN, ARCHITECTURE, PROGRESS, DECISIONS, AGENTS, CLAUDE symlink) | Implemented | Files exist at repository root; `CLAUDE.md` is a symlink (`ls -la CLAUDE.md`); link check in [AGENTS.md](AGENTS.md#the-repository-gate) passes |
| Seed decision record | Implemented | [DECISIONS.md](DECISIONS.md) entries D-001 through D-015 |

## Known gaps

- No application code, tests, build system, or dependencies exist.
- No vendor has been selected for database, cloud sandbox provider, or realtime transport; interfaces are defined in [ARCHITECTURE.md](ARCHITECTURE.md), vendor picks are pending [DECISIONS.md](DECISIONS.md) entries.
- The harness adapter contract is defined at the protocol level only; it has not been validated against the current CLI surfaces of Claude Code or Codex.
- The design token values in [DESIGN.md](DESIGN.md#tokens) have not been proven on a rendered screen; contrast ratios are calculated, not observed.

## Blocked

Nothing is blocked. The next step is human review of this foundation, then scaffolding per [ARCHITECTURE.md](ARCHITECTURE.md).
