Purpose: The single honest statement of what exists right now. Anyone reading only this file should know exactly what Novus can and cannot do today.
Authoritative for: current implementation status, evidence, known gaps, the current milestone.
Not authoritative for: what Novus should become (PRODUCT.md), how it should be built (ARCHITECTURE.md), how it should look (DESIGN.md), why choices were made (DECISIONS.md).
Update when: any capability changes state, in the same change that alters the capability. Status claims require an Evidence line.
Last reviewed: 2026-08-01

# Progress

## Current milestone

**Pre-implementation feasibility.** The canonical documentation foundation is complete. The current milestone is to test the chosen cloud workspace and both official harness CLIs before their adapter contracts shape application code. This milestone still contains no application functionality.

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
| Harness feasibility — hands-on, local + clean-Linux container | Partial | Run 2026-08-01. Verified live: Claude Code 2.1.220 `-p --output-format stream-json` (init event with capability flags, session id, per-model cost), `--resume` with correct recall, SIGTERM → exit 143 with child tasks marked killed, allowlist enforcement; Codex 0.145.0 `exec --json` (thread.started/turn/item events, usage), `exec resume --last` with correct recall, `app-server` JSON-RPC initialize handshake with server-initiated notifications. Clean Ubuntu 24.04 (aarch64 Docker): Claude Code installs via official script and returns structured JSON `is_error` when unauthenticated; Codex 0.146.0 musl binary from GitHub releases runs and requires a trusted git directory or `--skip-git-repo-check`. Adapter notes: `codex exec` consumes stdin; both CLIs emit stderr noise the supervisor must tolerate. |
| E2B provider spike runner | Partial | Pinned E2B SDK `2.14.0` installs with zero audit findings; `npm run check` and `npm run dry-run` under `spikes/e2b` validate the local entry point. A live E2B run is still required. |

## Known gaps

- No application code, application tests, product build system, or production dependencies exist. The disposable feasibility runner and its pinned SDK under `spikes/e2b` are not application functionality.
- The harness spike (D-017) has run locally and in a clean-Linux container but not yet on E2B (D-023). Still unproven: workspace lifecycle, egress policy, and suspend/resume on E2B itself; authenticated operation in a clean environment under org-provisioned API keys; and structured approval surfacing end to end (Claude Code `--permission-prompt-tool`, Codex app-server `requestApproval` round-trip) — a forced `--disallowedTools` denial returned no structured denial record in `-p` mode, so approval routing must be proven at the adapter level. The adapter contract is not frozen until the E2B leg runs.
- Static inspection of E2B SDK `2.14.0` shows outbound rules accept IP addresses/CIDRs rather than domain names. The live runner resolves required service domains in one sandbox and pins the observed IPv4 addresses in a second default-deny sandbox, but this is only an experiment: changing CDN/service addresses may make the policy too brittle for the eventual default-deny goal in D-015.
- The design token values in [DESIGN.md](DESIGN.md#tokens) have not been proven on a rendered screen; contrast ratios are calculated, not observed.
- The gate's source-code checks (gradients, raw colors, PROGRESS staleness) are dormant until application code exists.

## Blocked

- The E2B leg of the harness spike is blocked on an E2B account and API key, plus an Anthropic API key for org-credential auth testing (only the account holder can provide these). No E2B sandbox has been created, and the existing OpenAI credential has not been transmitted anywhere.

Next step after unblocking: finish the E2B spike leg, then the first implementation slice — a thin vertical skeleton: authenticate one user, create one mission, persist it, reconstruct it after refresh — with no agents and no visual flourish.
