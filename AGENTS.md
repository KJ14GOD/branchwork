Purpose: The working contract for every implementation agent (and human) making changes in this repository. Claude Code and Codex read this file first; `CLAUDE.md` is a symlink to it.
Authoritative for: agent workflow, the repository gate, documentation-update obligations, prohibitions.
Not authoritative for: product truth (PRODUCT.md), design truth (DESIGN.md), system truth (ARCHITECTURE.md), status (PROGRESS.md), decisions (DECISIONS.md).
Update when: the workflow, gate, or prohibitions change. Such changes require a DECISIONS.md entry.
Last reviewed: 2026-08-01

# Working rules for agents

## Required workflow for every task

1. Read [README.md](README.md).
2. Read the canonical documents relevant to the task — at minimum the "Authoritative for" lines of all seven, and the full sections that own what you are about to touch.
3. Before writing code, state the affected product and architectural contracts: which domain objects, lifecycles, capabilities, protocol messages, or design tokens your change touches, and which documents own them.
4. Do not widen scope. If the task requires something a canonical document forbids or does not define, stop and surface it; do not improvise product truth.
5. Update the owning documentation in the same change that alters behavior. A renamed or added mission state lands in PRODUCT.md and DESIGN.md in the same commit; a new domain object lands in PRODUCT.md and ARCHITECTURE.md in the same commit; a vendor or irreversible choice lands in DECISIONS.md.
6. Run the repository gate (below) before declaring a change complete.
7. Provide evidence: the command you ran and its observed output, or an artifact a human can inspect. Changes touching UI additionally include a screenshot, reviewed against [DESIGN.md](DESIGN.md#prohibited-patterns) and its composition rules. Update [PROGRESS.md](PROGRESS.md) status lines with that evidence.
8. Report documentation impact in your change summary: which documents you updated, and explicitly "no documentation impact" only when the gate's checks confirm it.

## Rules

9. Never add a root Markdown file without explicit approval recorded in [DECISIONS.md](DECISIONS.md).
10. Never place product truth inside a skill, agent definition, or prompt file. Skills may only point to the canonical documents.
11. Never call deterministic tests live proof. Tests are evidence for the tested path; "works" claims about the product require a real client against a real system.
12. Never mark something complete because an adjacent subsystem works. Each PROGRESS.md line moves on its own evidence.
13. Never make privileged actions presentation-only. Every capability listed in [PRODUCT.md](PRODUCT.md#roles-and-capabilities) is enforced by the server; hiding a button is not enforcement ([ARCHITECTURE.md](ARCHITECTURE.md#authorization)).
14. Never invent local design values. Every color, radius, shadow, type size, and spacing value comes from the token system in [DESIGN.md](DESIGN.md#tokens); a literal hex, px shadow, or one-off size in component code fails review.
15. Never use gradients. No CSS gradient functions anywhere unless DESIGN.md explicitly introduces an approved semantic gradient by name.
16. Never use Fleet or any parallel implementation fan-out until the contracts in ARCHITECTURE.md are stable and the task is genuinely divisible into independent slices. One agent, one coherent change, is the default.

## The repository gate

Run from the repository root. All checks must pass. When application code exists, its build/test/lint commands are added here (and only here).

```bash
# 1. Frontmatter present in every canonical doc
for f in README.md PRODUCT.md DESIGN.md ARCHITECTURE.md PROGRESS.md DECISIONS.md AGENTS.md; do
  for field in "Purpose:" "Authoritative for:" "Not authoritative for:" "Update when:" "Last reviewed:"; do
    grep -q "^$field" "$f" || echo "MISSING $field in $f"
  done
done

# 2. CLAUDE.md is a symlink to AGENTS.md
[ -L CLAUDE.md ] && [ "$(readlink CLAUDE.md)" = "AGENTS.md" ] || echo "CLAUDE.md symlink broken"

# 3. Internal links resolve
grep -RhoE '\]\(([A-Za-z0-9._/-]+\.md)' *.md | sed -E 's/.*\(//' | sort -u \
  | while read -r f; do [ -f "$f" ] || echo "BROKEN LINK: $f"; done

# 4. No product truth outside canonical docs
grep -rlE '^(Mission|Workstream|Execution|Direction|ControlLease|Receipt):' .claude/ skills/ 2>/dev/null \
  && echo "Product definitions found outside canonical docs"

# 5. No gradients (once source code exists)
grep -rn 'linear-gradient\|radial-gradient\|conic-gradient' --include='*.css' --include='*.tsx' --include='*.ts' . 2>/dev/null \
  && echo "Gradient found"
```

## Reading order for common tasks

- Product behavior, lifecycles, roles → [PRODUCT.md](PRODUCT.md)
- Anything a user sees → [DESIGN.md](DESIGN.md), and the state names it keys from in [PRODUCT.md](PRODUCT.md#the-mission-state-model)
- Protocol, persistence, security, runners → [ARCHITECTURE.md](ARCHITECTURE.md)
- "Is X built?" → [PROGRESS.md](PROGRESS.md) only
- "Why is it this way?" → [DECISIONS.md](DECISIONS.md)
