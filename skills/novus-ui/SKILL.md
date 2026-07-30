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

## Theme

Two token blocks, both in `:root` at the top of `styles.css`: `:root,
:root[data-theme="dark"]` (the default) and `:root[data-theme="light"]`.
`data-theme` is stamped on `<html>` synchronously in `main.tsx` — before
React mounts, not in an effect — and kept there by `use-theme.ts`'s
`useTheme()` hook, which persists the choice to `localStorage`
(`novus.theme`) and defaults to `prefers-color-scheme` when nothing is
stored. The toggle itself lives in `app.tsx`'s titlebar (`.titlebar__action`,
labelled with the theme switching *to*, matching the "attempts"/"timeline"
convention). `apps/desktop/index.html`'s `color-scheme` meta tag is `dark
light` — both, not just dark, or the UA assumes the page never supports light
before any CSS has run.

**The light block is not the dark block inverted.** Dark mode maps the five
planes to one monotonic lightness ramp because there is nowhere to go but
lighter. A light canvas has nowhere to go but *darker* than white, so — the
way VS Code's Light+ and Zed's light theme both do it — the planes split into
two moves instead of one ramp:

- **Content planes** (canvas, raised, floating) go toward paper white. This is
  what you read and act on, so it gets the most contrast.
- **Chrome/recessed planes** (well, surface) sit a shade grayer than the
  paper — the frame around the content, and the sunken output within it, read
  as one "not paper" register.

Borders still do the separating, at the same alpha formula as dark mode
(`rgb(var(--fg) / 0.1)` etc.) — only `--fg` flips from a light RGB triple to a
dark one, so the formula keeps meaning "a border, not a fill" on either
background. Light mode's alpha steps are tuned slightly stronger (13%/22%
border vs dark's 10%/16%) because the same percentage of a dark foreground
over a near-white background reads fainter than the reverse.

Shadows also do not just change color. Dark mode's ring is a literal
near-black (`#050506`) because pure black at low alpha casts nothing on a
near-black canvas. Light mode's ring is `rgba(20, 20, 22, 0.1)` — an ordinary
low-alpha black works fine on white, the way it does in every light UI.

What stays hardcoded dark regardless of theme: `apps/desktop/electron/main.ts`'s
`backgroundColor` (`#0a0a0b`, matching dark `--bg`), because the main process
picks the window's paint color before any renderer code — and therefore any
`localStorage` read — can run. A window opened in light mode can flash dark
at the edges during a resize. Wiring the stored theme into the native window
background would need it read from somewhere the main process can see before
`createWindow()`, which nothing does today; this is a known rough edge, not
an oversight to fix reflexively.

## Planes

Five, deepest to highest. Adjacent planes are deliberately close — separation
is the border's job, not the surface's. Wide lightness jumps read as stacked
gray rectangles, which is the flatness this system replaced.

| plane | token | dark | light | used for |
| --- | --- | --- | --- | --- |
| well | `--bg-well` | `#060607` | `#eef0f2` | diff bodies, `pre` output, input tracks, terminal dock |
| canvas | `--bg` | `#0a0a0b` | `#fbfbfc` | timeline, body |
| surface | `--surface` | `#101012` | `#f3f4f6` | titlebar, tab bar, session bar, rail, files panel, cards, panels |
| raised | `--surface-raised` | `#17171a` | `#ffffff` | primary button, kbd, hunk strips |
| floating | surface + shadow | — | — | palette, invite modal — nothing else |

Two rules that are easy to violate:

- **Output sinks, chrome rises.** Anything the agent produced (diffs, command
  output, raw payloads) goes in a well *below* the canvas. An agent tool is
  mostly output; raising every output card makes the screen lumpy, sinking
  them gives the chrome a stable frame. This is the single most load-bearing
  depth decision.
- **Nothing in the chrome may be lighter than a floating surface** (dark
  mode) **/ nothing in the chrome may be whiter than a raised control**
  (light mode). The elevation direction is fixed per theme; one violation
  breaks the spatial model.

`--bg` (dark value) must equal `backgroundColor` in
`apps/desktop/electron/main.ts` or the window flashes the wrong color on
launch and resize — see *Theme* above for why this is dark-only and stays
that way for now.

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

## Tabs

The app holds N sessions open at once, one tab each. The split, least-invasive
to what `use-session.ts`/`use-session-events.ts`/`use-comparison.ts` already
were:

- **`use-session.ts`** is now the *catalog*: host capabilities, remembered
  sessions, and `open()`, which creates or resumes a session and returns its
  `SessionSummary` rather than storing it. One instance, at `App`.
- **`use-session-actions.ts`** (new) is the per-session action set — `ask`,
  `invite`, `direct`, `cancel`, `pause`, `resume`, `handoff` — everything
  `use-session.ts` used to also own, now taking a fixed `SessionSummary`
  instead of managing one. One instance per tab.
- **`use-session-events.ts`, `use-comparison.ts`, `use-presence.ts`,
  `use-file-changes.ts`** were already shaped to take a `sessionId` parameter
  and needed no changes at all — that shape is why the split above was small.
- **`session-tab.tsx`** (new) is almost everything `app.tsx` used to render
  when a session was open: the session bar, rail, timeline, files panel,
  terminal dock, palette, invite panel. It calls all four per-tab hooks above.
  `app.tsx` renders one `<SessionTab>` per open tab.

**Every open tab stays mounted.** `App` renders all of them, always; only the
active one gets `style={{ display: "grid" }}`, the rest `display: "none"`
(set inline on `.tab-content`'s root, from `session-tab.tsx`). A `display:
none` element does not participate in its parent's grid layout, so `.shell`'s
single `1fr` row is only ever actually occupied by the one visible tab — but
all of them keep running: event stream, presence poll, and terminal (if
open) for a background tab do not pause or reset when you switch away, and a
tab's status badge stays live because of it. Unmounting-and-remounting per
switch was the alternative and was rejected because it would restart the SSE
connection and kill any open terminal every time you looked away.

**A tab reports its own status upward, it does not get polled for it.**
`SessionTab` takes an `onStatus` callback and calls it from a `useEffect`
keyed on the *computed values* (`runStatus`, `fileChanges.additions/deletions`),
deliberately not on `onStatus`'s own identity — `App` passes a fresh closure
per tab on every render (from a `.map()`), so depending on it would refire
every tab's effect on every keystroke anywhere in the app and could loop.
`App` holds the result in `tabStatuses: Record<tabId, TabStatus>`, read only
by the tab strip's own chip (status dot, diff-stat badge).

**Open tabs persist to `localStorage`** (`novus.tabs`: `{ tabs: SessionSummary[],
activeId }`), read once on mount and written after every change. This is not
"resume a session" (that already existed, server-side, via `/sessions/history`
and the Open screen's "carry on with") — it is "this window had these tabs
open," so relaunching the app does not lose the arrangement. Restoring a tab
does not call `open()` again; the stored `SessionSummary` already has
everything `<SessionTab>` needs; it just reconnects, the same as any
reconnect.

**New tab is `<OpenRepository embedded>`.** The same component the empty-state
screen uses, given an `embedded` prop that skips the full-page `.open`
wrapper and renders just `.open__panel modal`, which the caller (`App`) wraps
in `.overlay`. One component, two contexts — do not fork it into a second
"new tab" form.

## Changed files

`file-changes-panel.tsx` + `use-file-changes.ts` are Novus's honest version
of Conductor's right-hand per-file +/- list. "Honest" means: it draws `GET
/sessions/:id/files`, which is the worker's own `RunProjection.filesChanged`
(folded by `projectSession`, the same function `/compare` already uses) for
this session's own — not a fork's — runs, summed across turns. It is not a
second computation kept in the renderer; do not add one. If you need a
different rollup (per-run instead of whole-session, say), extend the
`/files` route in `event-server.ts`, not the client.

Refetched, not polled: `SessionTab` counts `apply_patch`-completed events in
the stream it already holds and passes that count as `useFileChanges`'s
`version` argument, which refetches on change. A patch applying is the only
thing that can change the answer, so there is no reason to ask on a timer the
way `use-presence.ts` has to (presence has no event to key off).

Lives as the body grid's third column (`.files`, 220px, `.body`'s
`grid-template-columns: 244px 1fr 220px`) — dropped entirely in the compare
screen (`.body--compare: 244px 1fr`), because a fork's changed files belong
to `CompareView`'s own per-attempt columns, not this session's panel.

## The boundaries that bite

- **A lone grid/flex item's automatic minimum size is its content's, not
  zero — this bit the tab bar and the session bar.** `.tab-content` is a
  single implicit grid column inside `.shell`; without `min-width: 0` on
  `.tab-content`, `.session-bar`, and `.body`, a long repository path (or
  enough open tabs) silently widened the whole window instead of letting
  `.titlebar__repo` ellipsize, pushing the terminal/invite buttons and the
  theme toggle off the right edge with no visible error anywhere — the
  layout was simply wider than the viewport. Same rule for `.tabstrip`,
  which additionally needs `flex: 1 1 auto` or it sizes to its tabs' content
  instead of claiming the titlebar's remaining space and scrolling
  internally. Any new direct child of a grid/flex container that is supposed
  to *shrink* needs this explicitly; it is never the default.
- **`packages/ui` markup is shared with `apps/guest`.** Styling its class
  names in the desktop stylesheet is fine; changing its markup or moving its
  one inline style (`event-row.tsx`, `{minWidth: 0, flex: 1}`) breaks the
  guest, whose stylesheet knows nothing of your new class.
- **The guest stylesheet is a deliberate mirror, currently behind.** This
  visual language lives only in `apps/desktop/src/styles.css`; the guest still
  has the old flat vocabulary, and now also lacks tabs, the files panel, and
  the theme toggle — the guest is single-session and read-only by design, so
  only the token block and the shared-component styles (`event`, `tool`,
  `patch`, `diff`, `kv`, `matches`, `compare`) are the actual follow-up.
  Mirror those in one deliberate pass, not by drift.
- **Long repository paths.** The titlebar path ellipsizes at the head via
  `direction: rtl` plus an LRM `::before` that pins the leading slash. If you
  touch `.titlebar__repo`, re-test with a path longer than half the window —
  and see the min-width bullet above, which is the other half of what makes
  this actually work now that it sits inside `.session-bar` rather than the
  top-level `.titlebar`.
- The gate does not see pixels. `pnpm typecheck && pnpm test` passes on any
  CSS; after a styling change, run the app (`novus-run-app`) and look at the
  screen you touched, in both a fresh session and one with a long history —
  and in both themes now, since `useTheme` makes light a first-class state,
  not a hypothetical.
