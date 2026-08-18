Purpose: The working contract for every implementation agent (and human) making changes in this repository. Claude Code and Codex read this file first; `CLAUDE.md` is a symlink to it.
Authoritative for: agent workflow, the repository gate, documentation-update obligations, prohibitions.
Not authoritative for: product truth (PRODUCT.md), design truth (DESIGN.md), system truth (ARCHITECTURE.md), status (PROGRESS.md), decisions (DECISIONS.md).
Update when: the workflow, gate, or prohibitions change. Such changes require a DECISIONS.md entry.
Last reviewed: 2026-08-17

# Working rules for agents

## Required workflow for every task

1. Read [README.md](README.md) and [PROGRESS.md](PROGRESS.md) completely. Inspect `git status`; existing changes belong to the user unless the task clearly says otherwise.
2. Read the canonical documents relevant to the task — at minimum the "Authoritative for" lines of all seven, the latest decision entries, and the full sections that own what you are about to touch.
3. Before writing code, state the affected product and architectural contracts: which domain objects, lifecycles, capabilities, protocol messages, or design tokens your change touches, and which documents own them.
4. Do not widen scope. If the task requires something a canonical document forbids or does not define, stop and surface it; do not improvise product truth.
5. Update the owning documentation in the same change that alters behavior. A renamed or added mission state lands in PRODUCT.md and DESIGN.md in the same commit; a new domain object lands in PRODUCT.md and ARCHITECTURE.md in the same commit; a vendor or irreversible choice appends a DECISIONS.md entry. Do not touch unrelated canonical files merely to make every file appear updated.
6. Verify at the level the change requires. During iteration, run the smallest relevant check rather than the full repository gate: a visual-only change can be inspected in the app; a focused behavior change should run its focused test; a contract, runner, persistence, security, or cross-package change should run the affected package tests. Run the full repository gate before merging a coherent slice, before pushing a shared branch, and before a release or demo build. If the user explicitly asks for rapid exploration, do not spend the iteration on a full gate; report what was and was not checked.
7. Provide evidence: the command you ran and its observed output, or an artifact a human can inspect. Changes touching UI additionally include a screenshot, reviewed against [DESIGN.md](DESIGN.md#prohibited-patterns) and its composition rules. Reconcile [PROGRESS.md](PROGRESS.md) in every implementation change: move only the capability lines whose evidence changed, add the evidence, and leave everything else honest. Never use a checkbox or prose claim as a substitute for the status table.
8. Before finishing, inspect the complete working diff and reconcile it against all seven ownership scopes. Report which canonical documents you consulted and updated; say "no change required" for a relevant owner only with a one-sentence reason. Run the gate after this reconciliation, not before it.

For visual-only work, do not edit tests merely to accommodate a new layout, shorter label, or different spacing. Preserve behavior and accessibility, inspect the rendered result, and leave broader automated verification for the slice checkpoint. A failing test that reflects an intentional behavior change must be discussed and updated deliberately; it must never be weakened just to make a run green.

## Rules

9. Never add a root Markdown file without explicit approval recorded in [DECISIONS.md](DECISIONS.md).
10. Never place product truth inside a skill, agent definition, or prompt file. Skills may only point to the canonical documents.
11. Never call deterministic tests live proof. Tests are evidence for the tested path; "works" claims about the product require a real client against a real system.
12. Never mark something complete because an adjacent subsystem works. Each PROGRESS.md line moves on its own evidence.
13. Never make privileged actions presentation-only. Every capability listed in [PRODUCT.md](PRODUCT.md#roles-and-capabilities) is enforced by the server; hiding a button is not enforcement ([ARCHITECTURE.md](ARCHITECTURE.md#authorization)).
14. Never invent local design values. Every color, radius, shadow, type size, and spacing value comes from the token system in [DESIGN.md](DESIGN.md#tokens); a literal hex, px shadow, or one-off size in component code fails review.
15. Never use gradients. No CSS gradient functions anywhere unless DESIGN.md explicitly introduces an approved semantic gradient by name.
16. Never use Fleet or any parallel implementation fan-out until the contracts in ARCHITECTURE.md are stable and the task is genuinely divisible into independent slices. One agent, one coherent change, is the default.
17. Never save a screenshot or any other evidence image outside the repository — not the Desktop, not Downloads, not a temp path handed to the user (D-143). Evidence images live in `apps/desktop/e2e/evidence/`, numbered in sequence with a short kebab-case subject; a re-capture of a subject that already has a file replaces that file rather than adding a sibling.

## The repository gate

```bash
scripts/gate.sh
```

One command; it exits non-zero on any violation and `GATE PASS` / zero only when everything passes (D-016, D-026). It checks: frontmatter presence and order in every canonical doc; the CLAUDE.md symlink; a root-Markdown allowlist; internal file links and anchors; banned language; domain terms defined outside PRODUCT.md; product truth in skills or agent config; gradients and raw color values in application source; staged, unstaged, or untracked implementation changes lacking a PROGRESS.md update; and untracked files. When application code exists, its build, test, and lint commands are added to this script (and only there). A change is not complete until the gate passes.

## Reading order for common tasks

- Product behavior, lifecycles, roles → [PRODUCT.md](PRODUCT.md)
- Anything a user sees → [DESIGN.md](DESIGN.md), and the state names it keys from in [PRODUCT.md](PRODUCT.md#the-mission-state-model)
- Protocol, persistence, security, runners → [ARCHITECTURE.md](ARCHITECTURE.md)
- "Is X built?" → [PROGRESS.md](PROGRESS.md) only
- "Why is it this way?" → [DECISIONS.md](DECISIONS.md)
