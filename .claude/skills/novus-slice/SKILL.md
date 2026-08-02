---
name: novus-slice
description: How to implement a Novus vertical slice the canonical way — read order, contract-first sequencing, gate, and PROGRESS reconciliation. Use when starting any implementation task in this repository.
---

# Implementing a Novus slice

This skill holds no product truth (D-011). It only points at the canonical documents and fixes the working order.

1. Follow the workflow in [AGENTS.md](../../../AGENTS.md) exactly — read order, contract statement, scope discipline, evidence, reconciliation.
2. Sequence every slice contract-first: `packages/contracts` and `apps/control-plane/src/schema.sql` change first and freeze before UI or tests build on them.
3. Domain meanings live in [PRODUCT.md](../../../PRODUCT.md); representation and mechanics in [ARCHITECTURE.md](../../../ARCHITECTURE.md); presentation in [DESIGN.md](../../../DESIGN.md) — never restate, always link.
4. Decisions (vendor, mechanism, scope) append to [DECISIONS.md](../../../DECISIONS.md) before the code that depends on them merges.
5. The slice is done when `scripts/gate.sh` passes, the e2e drives the real desktop app through the workflow, and [PROGRESS.md](../../../PROGRESS.md) moved only the lines whose evidence changed.
6. Live integrations are proven only by live runs; fake-provider coverage is stated as fake-provider coverage.
