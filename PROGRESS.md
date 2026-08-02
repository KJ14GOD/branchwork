Purpose: The single honest statement of what exists right now. Anyone reading only this file should know exactly what Novus can and cannot do today.
Authoritative for: current implementation status, evidence, known gaps, the current milestone.
Not authoritative for: what Novus should become (PRODUCT.md), how it should be built (ARCHITECTURE.md), how it should look (DESIGN.md), why choices were made (DECISIONS.md).
Update when: any capability changes state, in the same change that alters the capability. Status claims require an Evidence line.
Last reviewed: 2026-08-01

# Progress

## Current milestone

**First vertical slice.** The documentation foundation and feasibility spikes are complete. The current milestone delivered the first production-shaped slice: launch the Novus desktop application, authenticate one user, create one mission, persist it and its initial event in PostgreSQL, and reconstruct it after a full relaunch. Everything beyond that slice remains Not started.

## Status rules

- Every status is one of: **Not started**, **Partial**, **Implemented**, **Blocked**.
- **Implemented** and **Partial** require an Evidence line: a command with observed output, or a link to an artifact a human can inspect. Documentation is never evidence of functionality. Deterministic tests are evidence that the tested path works deterministically — they are never "live proof" of end-to-end behavior; only a real client exercising a real system is.
- The Golden V0 workflow ([README.md](README.md#the-golden-v0-workflow)) is the milestone gate for the first implementation: it is not done until two real clients execute all twenty steps.

## Application capabilities

The previous prototype was removed in full (commit `50c4851`); none of its behavior carries over. Evidence for every Partial line: `pnpm run test` (14 deterministic tests: 5 contract, 9 control-plane against real PostgreSQL) and `pnpm run e2e` (the complete slice through the actual Electron app — sign-in, empty surface, creation, relaunch, reconstruction — with screenshots in `apps/desktop/e2e/evidence/`), both run 2026-08-01.

| Capability | Status |
| --- | --- |
| Authentication and sessions | Partial — GitHub OAuth desktop flow (D-027), first-party revocable sessions, hashed tokens, OS-backed credential storage. Unconfigured OAuth fails fast with a named 503 surfaced in the setup card. **Live GitHub round-trip proven 2026-08-01**: the user signed in through the real system-browser flow and the durable user row exists (`users.login = KJ14GOD`, github_id present); remaining Partial only because sign-in is single-org personal and untested on Windows/Linux |
| Organizations and membership | Partial — personal org auto-provisioned at first sign-in; server-side org scoping proven (cross-org missions invisible, 404 not 403). No multi-member orgs, no org management |
| Repository connection (GitHub App) | Partial — the repository provider boundary exists (D-031: listing, exact base resolution, idempotent branch creation) and the desktop selects repositories through it, but only against the deterministic fake provider; the live GitHub App adapter is unbuilt and live repository access is unproven |
| Repository branches, checkpoints, and workspace synchronization | Partial — one server-named mission branch per workstream, pinned to an exact 40-hex base SHA, idempotent creation with a per-repository uniqueness index, failed/pending/created as durable state with retry, all event-recorded (fake provider only). Checkpoints and workspace synchronization (D-025) not started |
| Mission creation and lifecycle | Partial — creation with goal + success criteria + repository + exact base revision; mission + Mission Admin participant + workstream + initial events commit in one transaction; creation-key idempotency proven under 8-way concurrent duplicates; only the New mission state exists; no lifecycle transitions |
| Invitations and participants | Partial — creator-as-Mission-Admin participant row only; no invitations |
| Roles and server-enforced capabilities | Partial — `org.mission.create` and org scoping enforced server-side; the full capability table is not implemented |
| Control leases, requests, handoffs | Not started |
| Direction lifecycle | Not started |
| Workstreams and executions | Partial — workstream records exist (base ref/SHA, mission branch, branch status; one per mission as a V0 constraint); executions not started |
| Harness adapters (Claude Code, Codex) | Not started |
| Execution providers and cloud workspaces | Not started |
| Runner protocol (events, commands, reconnection) | Not started |
| Presence | Not started |
| Changes (diff) presentation | Not started |
| Verification evidence | Not started |
| Review and revision requests | Not started |
| Pull-request creation and tracking | Not started |
| Receipts | Not started |
| Missions surface | Partial — loading placeholders, empty state, offline notice with retry, mission rows, creation dialog with validation and persistence-failure states; attention grouping reduced to the one reachable group |
| Mission Room surface | Partial — reduced New-mission view only: goal, state line, success criteria, event history. No composer, participants, workstreams, or evidence |
| Review surface | Not started |
| Design token system and primitives | Partial — tokens.css carries the DESIGN.md values on rendered screens: monochrome authority retheme and setup room (D-028), plus the Light/Dark/System theme system, 6px buttons, sanctioned brand glyphs (vectors for GitHub/Claude Code; user-supplied theme-inverted OpenAI mark for Codex, D-030), and read-only local-harness detection with plan reporting on setup (D-029; observed live: GitHub connected identity, Claude Code "Max plan" via macOS Keychain, Codex "ChatGPT Plus" via its token claim). Light palette is provisional — not yet screen-proven. Remaining primitives unbuilt |

## Documentation

| Item | Status | Evidence |
| --- | --- | --- |
| Canonical documents (README, PRODUCT, DESIGN, ARCHITECTURE, PROGRESS, DECISIONS, AGENTS, CLAUDE symlink) | Implemented | Files exist at repository root; `CLAUDE.md` is a symlink (`ls -la CLAUDE.md`); `scripts/gate.sh` exits 0 (run 2026-08-01) |
| Executable repository gate | Implemented | `scripts/gate.sh` exits non-zero on seeded violations and 0 on the current tree (run 2026-08-01; D-016, D-026); implementation/PROGRESS reconciliation covers staged, unstaged, and untracked implementation paths |
| Decision record | Implemented | [DECISIONS.md](DECISIONS.md) entries D-001 through D-026, including provider-spike outcome D-024, repository-continuity contract D-025, and agent workflow enforcement D-026 |
| Repository/workspace synchronization contract | Implemented | Product behavior, revision representation, checkpoint/sync protocol, UI states, V0 boundary, and failure handling reconcile across README.md, PRODUCT.md, ARCHITECTURE.md, DESIGN.md, and D-025; `scripts/gate.sh` passes (run 2026-08-01) |
| Harness feasibility — documentation-level | Implemented | Official-docs verification for Claude Code (headless, streaming, resume, permissions, auth) and Codex (exec/app-server, approvals, interrupt, auth), recorded with sources in D-017 |
| Harness feasibility — hands-on, local + clean-Linux container | Partial | Run 2026-08-01. Verified live: Claude Code 2.1.220 `-p --output-format stream-json` (init event with capability flags, session id, per-model cost), `--resume` with correct recall, SIGTERM → exit 143 with child tasks marked killed, allowlist enforcement; Codex 0.145.0 `exec --json` (thread.started/turn/item events, usage), `exec resume --last` with correct recall, `app-server` JSON-RPC initialize handshake with server-initiated notifications. Clean Ubuntu 24.04 (aarch64 Docker): Claude Code installs via official script and returns structured JSON `is_error` when unauthenticated; Codex 0.146.0 musl binary from GitHub releases runs and requires a trusted git directory or `--skip-git-repo-check`. Adapter notes: `codex exec` consumes stdin; both CLIs emit stderr noise the supervisor must tolerate. |
| E2B provider spike — live run | Implemented | Run 2026-08-01, results in `spikes/e2b/spike-results.json` (D-024). Create 125–190ms, pause 134ms, resume 238ms, cold starts 146–1561ms; files and background processes survive pause/resume; both harness CLIs install and run in-sandbox; default-deny denies as expected, but IP-based allowlists break DNS — egress default-deny requires a proxy (D-024). No provider API keys were transmitted; the authenticated-harness leg has not run. |
| Vertical slice — desktop workflow, live | Implemented | `pnpm run e2e` run 2026-08-01: the actual Electron app signs in, shows the empty Missions surface, creates a mission, closes fully, relaunches, restores its session from OS-backed storage, and reconstructs the mission and its `mission.created` event from PostgreSQL. Screenshots: `apps/desktop/e2e/evidence/1-sign-in.png` … `4-mission-reconstructed.png`, reviewed against DESIGN.md prohibited patterns. Gate now runs build, typecheck, lint, and the deterministic suites. |
| Repository slice — desktop workflow (fake provider) | Implemented | Run 2026-08-01 on branch `slice/repository-missions`: repository selection → exact base SHA display → mission creation → `novus/m-…` branch allocation → full relaunch reconstruction, plus the deterministic failure/retry path, through the real Electron app (`pnpm run e2e`, 2/2; evidence `5-mission-repo.png`, `6-branch-retry.png`). 25 control-plane tests cover identity, base pinning, creation-key idempotency (8-way concurrency), transient-failure retry, branch conflict, unconfigured provider, and reconstruction. Read-only security audit findings (vacuous branch index, duplicate-key 500s, plaintext flow tokens, fake provider accepting unknown SHAs) all fixed; sessions are now minted at claim time so no live token is ever stored. All proof is against the deterministic fake provider — no live GitHub App exists. |

## Known gaps

- Real GitHub OAuth has never round-tripped: every authenticated run used the gated fake upstream (D-027). Proving it needs a GitHub OAuth App (callback `http://127.0.0.1:4460/auth/github/callback`) and its credentials in `.env`.
- The desktop app runs from `pnpm dev` only; there is no packaged, signed, downloadable build, and no Windows/Linux run has happened.
- One personal organization per user is assumed throughout the slice; org selection and multi-membership are undefined in code.
- The design token values are now proven on rendered screens (evidence screenshots), but only on macOS at one window size; density, keyboard navigation, and most primitives remain unexercised.
- The harness spike (D-017) has run locally, in a clean-Linux container, and live on E2B (D-024). Still unproven: authenticated harness operation in a clean environment under org-provisioned API keys (no provider keys have been transmitted to any sandbox), and structured approval surfacing end to end (Claude Code `--permission-prompt-tool`, Codex app-server `requestApproval` round-trip) — a forced `--disallowedTools` denial returned no structured denial record in `-p` mode, so approval routing must be proven at the adapter level. These two items are the remaining gate on freezing the adapter contract.
- Egress default-deny via provider IP rules is proven unworkable (D-024): the design answer is an egress proxy, which does not yet exist even as a specification.
- The repository-continuity contract is documented (D-025), but none of it is implemented: no mission-branch allocation, revision tracking, checkpoint artifacts, explicit synchronization, conflict presentation, or replacement-workspace reconstruction exists.
## Blocked

- The live-GitHub authentication leg is blocked on GitHub OAuth App credentials (only the account holder can create them; see `.env.example`).
- The authenticated-harness leg of the spike is blocked on explicit opt-in to transmit provider API keys to a disposable sandbox (`NOVUS_SPIKE_SEND_*` flags), and on an Anthropic API key, which is not present on this machine. Only the account holder can provide these.

Next step: prove the live GitHub OAuth round-trip, then the second slice — repository connection (GitHub App) and mission-branch allocation per D-025 — before any harness execution.
