---
name: novus-ui
description: The desktop UI's visual language — planes, alpha borders, radii, type, motion, and interaction states — and how to change styling without breaking it. Use when styling or restyling anything in apps/desktop, adding a component or state, adjusting spacing, color, hover, focus, or elevation, or reviewing a change that touches styles.css.
---

# Novus UI

Dark, monochrome, minimal, one monospace face for everything. Depth comes from
a small set of systems, not decoration. Every rule below exists because its
absence is what made the app read flat; break one and that flatness returns
locally, which is worse than globally because it shows.

All tokens live in `:root` at the top of `apps/desktop/src/styles.css`. Do not
introduce a literal where a token exists.

## Planes

Five, deepest to highest. Adjacent planes are deliberately close — separation
is the border's job, not the surface's. Wide lightness jumps read as stacked
gray rectangles, which is the flatness this system replaced.

| plane | token | used for |
| --- | --- | --- |
| well | `--bg-well` `#060607` | diff bodies, `pre` output, input tracks |
| canvas | `--bg` `#0a0a0b` | timeline, body |
| surface | `--surface` `#101012` | titlebar, rail, cards, panels |
| raised | `--surface-raised` `#17171a` | primary button, kbd, hunk strips |
| floating | surface + shadow | palette, invite modal — nothing else |

Two rules that are easy to violate:

- **Output sinks, chrome rises.** Anything the agent produced (diffs, command
  output, raw payloads) goes in a well *below* the canvas. An agent tool is
  mostly output; raising every output card makes the screen lumpy, sinking
  them gives the chrome a stable frame. This is the single most load-bearing
  depth decision.
- **Nothing in the chrome may be lighter than a floating surface.** The
  elevation direction is fixed; one violation breaks the spatial model.

`--bg` must equal `backgroundColor` in `apps/desktop/electron/main.ts` or the
window flashes the wrong color on launch and resize.

## Borders and ghost states

`--fg` is the foreground as an RGB triple (`231 231 234`). Every border and
interaction state is the foreground at low alpha — `--border-subtle` (7%),
`--border` (10%), `--border-strong` (16%), `--hover` (6%), `--pressed` (10%),
`--selected` (11%) — so one value is correct on every plane. Never hand-pick
an opaque gray for a border: it is only right on the one background you tuned
it against.

Interactive rows (rail jumps, tool heads, palette items, recent sessions) are
**ghosts**: transparent at rest, `--hover` under the cursor, `--pressed` while
down, `--selected` when chosen. Rest-state chrome on rows is what makes a
dense tool look busy and flat at the same time.

Bordered controls move **background and border together, one step each** on
hover. Moving only the fill reads as a repaint; moving both reads as the
control lifting.

## Radii

`--radius-s` 3px (chips, kbd, badges), `--radius-m` 5px (controls, inputs,
rows, timeline cards), `--radius-l` 8px (panels, palette, modal, compare
cards). Outer always ≥ inner — nested radius is the cheapest depth cue there
is. Cards with full-bleed children (`.tool`, `.patch`, `.palette`) need
`overflow: hidden` or the child's background pokes the corner.

## Shadows

Only the two floating surfaces cast: `--shadow-popover` (palette) and
`--shadow-modal` (invite). Both lead with a 1px ring in a color *darker than
the canvas* — the eye reads the ring as the edge, the blur is atmosphere, and
pure black on near-black casts nothing, which is why "shadows don't work in
dark mode" felt true here before. Do not add shadows to in-flow cards; borders
carry them.

## Type

Mono is the identity — no second face. Hierarchy comes from exactly one extra
weight and one extra size:

- **500 is the app-wide maximum weight** (mono bolds optically fast).
  It marks eyebrows (the 10px uppercase tracked labels), panel titles, and
  primary data (`.stat__value`, `.tool__name`, `.patch__path`).
- 14px exists for two hero moments only: the open panel title and the empty
  timeline. Everything else is the 10/11/12/13 scale that was already here.
- Wide tracking (0.06–0.16em) is for uppercase eyebrows only. Never track
  sentence-case text.
- Floor is 10px, and only for uppercase eyebrows; body stays 12px.

## Motion

`--t-fast` 120ms for hover/focus/press, `--t-overlay` 160ms for the palette
and modal entrance (fade + scale from 0.98), both on `--ease`
`cubic-bezier(0.2, 0, 0, 1)`. Transition paint properties only — background,
border, color, box-shadow, opacity, transform — never `all`, never layout.
New interactive selectors join the grouped transition rule near the top of
the stylesheet. `prefers-reduced-motion` kills everything; do not opt out.

## Focus

`:focus-visible` gets the double ring (`--focus-ring`): inner ring in the
canvas color gaps it off the control's own border, outer ring at 28% fg.
Box-shadow, never outline or border — no layout shift. The palette input is
the one exemption (focused by construction; its lit bottom rule is the
affordance). If you add a focusable element you get the ring for free; do not
`outline: none` anything without replacing it.

## Buttons

Two kinds. `.open__submit` is the primary: raised fill, strong border,
weight 500. `.open__browse` is the quiet one: transparent until hover.
`.titlebar__action` is the ghost for chrome. All three have `:hover`,
`:active`, and `:disabled` states — a new button variant needs all three or
it will be the one control that snaps.

## The boundaries that bite

- **`packages/ui` markup is shared with `apps/guest`.** Styling its class
  names in the desktop stylesheet is fine; changing its markup or moving its
  one inline style (`event-row.tsx`, `{minWidth: 0, flex: 1}`) breaks the
  guest, whose stylesheet knows nothing of your new class.
- **The guest stylesheet is a deliberate mirror, currently behind.** This
  visual language lives only in `apps/desktop/src/styles.css`; the guest still
  has the old flat vocabulary. Mirroring the token block and the shared-
  component styles (`event`, `tool`, `patch`, `diff`, `kv`, `matches`,
  `compare`) into `apps/guest/src/styles.css` is the known follow-up — do it
  in one deliberate pass, not by drift.
- **Long repository paths.** The titlebar path ellipsizes at the head via
  `direction: rtl` plus an LRM `::before` that pins the leading slash. If you
  touch `.titlebar__repo`, re-test with a path longer than half the window.
- The gate does not see pixels. `pnpm typecheck && pnpm test` passes on any
  CSS; after a styling change, run the app (`novus-run-app`) and look at the
  screen you touched, in both a fresh session and one with a long history.
