---
name: novus-ui
description: Design and refine Novus UI with a deliberate visual point of view. Use when building or changing any desktop UI.
---

# Novus UI quality loop

`DESIGN.md` is the only source of Novus visual truth. Read the relevant sections before editing. Do not restate or invent tokens, states, primitives, or product behavior here.

## Before code

Write a short Surface Taste Brief:

1. What question must this surface answer?
2. What should the eye see first, second, and third?
3. What should the surface feel like?
4. What is the one memorable design decision?
5. What is intentionally absent?
6. Which existing primitives and tokens compose it?

Design one composed surface with a point of view. Do not assemble generic cards, rows, buttons, and explanatory copy. Keep Novus's calm authority, dense content, soft chrome, and personality in its words. Treat the prohibited patterns in `DESIGN.md` as hard constraints.

For dialogs and overlays, verify before finishing:

- title, context, content, and actions share an intentional inset and alignment axis;
- the container is sized to its content and bounded by the existing dialog rules;
- rows have a clear primary value and subordinate action, with no floating controls;
- header, body, and footer read as one composition rather than unrelated blocks;
- whitespace is intentional, not the result of a missing wrapper or padding rule.

## After code

Run the real app and inspect screenshots at the supported window sizes. Ask:

- Is there one clear focal point and one primary action?
- Do the type, spacing, and surfaces create a deliberate rhythm?
- Does anything feel generic, accidental, over-explained, or equally weighted?
- What can be removed without losing clarity?
- Is the signature detail purposeful rather than decorative?

Revise the weakest decisions, then capture the result again. Passing tests without reviewing the rendered result is incomplete. Follow `AGENTS.md` for evidence, screenshots, and the repository gate.
