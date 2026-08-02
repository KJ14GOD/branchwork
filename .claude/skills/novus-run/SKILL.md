---
name: novus-run
description: Commands to run, test, and prove the Novus app locally — dev launch, deterministic suites, Electron e2e, and the repository gate. Use when asked to run or verify the app.
---

# Running Novus locally

This skill holds no product truth (D-011); statuses live in [PROGRESS.md](../../../PROGRESS.md).

- `pnpm install` once; `pnpm run db:up` starts PostgreSQL in Docker (port 5433).
- `pnpm dev` — starts the control plane and launches the desktop app. Real GitHub sign-in needs `.env` per `.env.example`; add `NOVUS_FAKE_REPOS=1` to walk repository flows before the GitHub App exists (refused in production).
- `pnpm run build` · `pnpm run typecheck` · `pnpm run lint` · `pnpm run test` (deterministic suites; needs the database).
- `pnpm run e2e` — drives the actual Electron app end to end with deterministic upstreams; evidence screenshots land in `apps/desktop/e2e/evidence/`.
- `scripts/gate.sh` — the required gate ([AGENTS.md](../../../AGENTS.md#the-repository-gate)); a change is not complete until it passes.
