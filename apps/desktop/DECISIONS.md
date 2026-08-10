
## D-104 — The theme block is icons, not words

**Context.** D-103's block carried the setup room's worded segment — Light / Dark / System as text buttons. The owner, on sight, asked for the compact icon form instead: sun, crescent, display, the pattern the reference popover used.

**Decision.** The popover's three segments are glyphs alone — sun for light, crescent for dark, a display for system — each an icon button with its label on `aria-label` and `title`, the active one washed `--selected` exactly as active icon buttons are everywhere. The block hugs its content instead of spanning the row. The **setup room keeps its worded row**: a first-run surface explains itself; the popover is for a person who already chose once.

**Alternatives.** Icons with visible labels beneath (rejected: the block outgrows the corner it lives in); replacing setup's words with icons too (rejected: setup is where the choice is taught).

**Consequences.** The one shared choice-set now carries a glyph per choice alongside its label; the popover evidence is re-shot (115–116).

**Revisit when.** A fourth appearance choice ever exists (it will not fit a glyph row quietly).
