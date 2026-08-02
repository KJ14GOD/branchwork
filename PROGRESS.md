Purpose: The single honest statement of what exists right now. Anyone reading only this file should know exactly what Novus can and cannot do today.
Authoritative for: current implementation status, evidence, known gaps, the current milestone.
Not authoritative for: what Novus should become (PRODUCT.md), how it should be built (ARCHITECTURE.md), how it should look (DESIGN.md), why choices were made (DECISIONS.md).
Update when: any capability changes state, in the same change that alters the capability. Status claims require an Evidence line.
Last reviewed: 2026-08-01

# Progress

## Current milestone

**Project-first shell with real local execution (D-032).** Live today, end to end in the desktop app: sign in with GitHub, see your real repositories through the GitHub App or add a local folder, open a project, start a workstream by typing the first message, and watch a real Claude Code turn work in a dedicated mission worktree and land an attributed checkpoint commit — reconstructed from PostgreSQL after a full relaunch. Multiplayer, cloud execution, verification, review, and receipts remain Not started.

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
| Repository connection (GitHub App) | Partial — the GitHub App exists (manifest flow, one-click create + install; app `novus-kartik` installed on the user's account 2026-08-01) and the live adapter is proven for **listing and exact base resolution** against the user's real repositories (observed live: real repo list served through installation tokens). Live branch creation is implemented with the same idempotency mapping (201 / 422-exists compare / 422-unknown-base) but has not yet created a real branch; the fake provider still backs all deterministic tests. **Local repositories** (D-032): registration with machine-bound identity, folder paths never leaving the machine, desktop-side git (branch created as a plain ref, never touching the working tree), and reported outcomes as claims — backend and Electron machinery built 2026-08-01; the picker UI arrives with the project shell |
| Repository branches, checkpoints, and workspace synchronization | Partial — one server-named mission branch per workstream, pinned to an exact 40-hex base SHA, idempotent creation with a per-repository uniqueness index, failed/pending/created as durable state with retry, all event-recorded (fake provider only). Checkpoints and workspace synchronization (D-025) not started |
| Mission creation and lifecycle | Partial — creation with goal + success criteria + repository + exact base revision; mission + Mission Admin participant + workstream + initial events commit in one transaction; creation-key idempotency proven under 8-way concurrent duplicates; only the New mission state exists; no lifecycle transitions |
| Invitations and participants | Partial — creator-as-Mission-Admin participant row only; no invitations |
| Roles and server-enforced capabilities | Partial — `org.mission.create` and org scoping enforced server-side; the full capability table is not implemented |
| Control leases, requests, handoffs | Not started |
| Direction lifecycle | Not started |
| Workstreams and executions | Partial — workstream records exist (base ref/SHA, mission branch, branch status; one per mission as a V0 constraint); executions not started |
| Harness adapters (Claude Code, Codex) | Partial — **Claude Code proven live 2026-08-02**: a direction typed into the chat composer of the real desktop app ran a real headless Claude Code turn in a dedicated mission worktree against a real local git repository; its activity streamed into the room as attributed events and its work landed as an attributed checkpoint commit on the mission branch (`novus/m-ptxm43ke`, `HELLO.md` containing `hello`, verified with `git show` on the branch; evidence `11-live-claude-turn.png`). Model and effort are selectable in the composer and passed through as real `--model`/`--effort` flags (allowlisted before reaching the CLI, persisted, recorded on the execution's start event). Stop via SIGTERM implemented but not live-exercised; only the local surface exists (no cloud runner); Codex appears disabled in the model menu and is not started |
| Execution providers and cloud workspaces | Not started |
| Runner protocol (events, commands, reconnection) | Not started |
| Presence | Not started |
| Changes (diff) presentation | Not started |
| Verification evidence | Not started |
| Review and revision requests | Not started |
| Pull-request creation and tracking | Not started |
| Receipts | Not started |
| Missions surface | Partial — replaced by the project-first shell (D-032): projects sidebar (GitHub + local, counts, needs-attention lens, add-project menu; selection is a background highlight only), evidence `9-project-shell.png`. The old Missions list is gone; the attention lens is its successor |
| Mission Room surface | Partial — chat-first room (D-032): workstream tabs per project, form-free first-message creation with derived goal, conversational event feed (direction bubbles, harness text/tool lines, checkpoint and turn system lines) polling durable events, prominent composer with honest disabled state for GitHub repos, Working…/Stop, repository-continuity inspector. Proven end to end with the deterministic fake harness including full-relaunch reconstruction (`pnpm run e2e` 2/2, screenshots 9/10, 2026-08-01). No participants, evidence ledger, or review yet |
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
| Repository slice — desktop workflow (fake provider) | Implemented | Run 2026-08-01 on branch `slice/repository-missions`: repository selection → exact base SHA display → mission creation → `novus/m-…` branch allocation → full relaunch reconstruction, plus the deterministic failure/retry path, through the real Electron app (`pnpm run e2e`, 2/2; evidence `5-mission-repo.png`, `6-branch-retry.png`). 25 control-plane tests cover identity, base pinning, creation-key idempotency (8-way concurrency), transient-failure retry, branch conflict, unconfigured provider, and reconstruction. Read-only security audit findings (vacuous branch index, duplicate-key 500s, plaintext flow tokens, fake provider accepting unknown SHAs) all fixed; sessions are now minted at claim time so no live token is ever stored. All proof is against the deterministic fake provider — no live GitHub App exists. Review wave (2026-08-01): keyboard-only creation completable with a now-trapped dialog focus; narrow-window (760×600) and offline-with-stale-rows states proven in the real app (`7-narrow-mission.png`, `8-offline.png`); the compound first-mission concurrency race found in adversarial review is fixed with a bounded settle loop and locked by three consecutive green suite runs. |

## Known gaps

- Real GitHub OAuth has never round-tripped: every authenticated run used the gated fake upstream (D-027). Proving it needs a GitHub OAuth App (callback `http://127.0.0.1:4460/auth/github/callback`) and its credentials in `.env`.
- The desktop app runs from `pnpm dev` only; there is no packaged, signed, downloadable build, and no Windows/Linux run has happened.
- One personal organization per user is assumed throughout the slice; org selection and multi-membership are undefined in code.
- The design token values are now proven on rendered screens (evidence screenshots), but only on macOS at one window size; density, keyboard navigation, and most primitives remain unexercised.
- The harness spike (D-017) has run locally, in a clean-Linux container, and live on E2B (D-024). Still unproven: authenticated harness operation in a clean environment under org-provisioned API keys (no provider keys have been transmitted to any sandbox), and structured approval surfacing end to end (Claude Code `--permission-prompt-tool`, Codex app-server `requestApproval` round-trip) — a forced `--disallowedTools` denial returned no structured denial record in `-p` mode, so approval routing must be proven at the adapter level. These two items are the remaining gate on freezing the adapter contract.
- Egress default-deny via provider IP rules is proven unworkable (D-024): the design answer is an egress proxy, which does not yet exist even as a specification.
- Execution events are reported under the user's session, so within an organization a signed-in user could fabricate harness-attributed events (D-033). Harmless while every org is one person; **runner credentials are a hard prerequisite for multiplayer**.
- Local execution runs the agent with edit authority in a mission worktree. Mitigations in place: server-resolved branch and repository (the renderer names neither), branch-name validation, single-flight per mission, a secret-path denylist that refuses to commit `.env`/keys/`.pem` files, worktree pruning, and in-flight turns killed and recorded on app quit. Worktrees are still never removed after a mission ends, and the real `claude` spawn/stream path has only the single manual live run behind it — no automated coverage.
- The repository-continuity contract is documented (D-025), but none of it is implemented: no mission-branch allocation, revision tracking, checkpoint artifacts, explicit synchronization, conflict presentation, or replacement-workspace reconstruction exists.
## Blocked

- The live-GitHub authentication leg is blocked on GitHub OAuth App credentials (only the account holder can create them; see `.env.example`).
- The authenticated-harness leg of the spike is blocked on explicit opt-in to transmit provider API keys to a disposable sandbox (`NOVUS_SPIKE_SEND_*` flags), and on an Anthropic API key, which is not present on this machine. Only the account holder can provide these.

Next step: prove the live GitHub OAuth round-trip, then the second slice — repository connection (GitHub App) and mission-branch allocation per D-025 — before any harness execution.
