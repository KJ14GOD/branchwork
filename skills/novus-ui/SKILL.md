---
name: novus-ui
description: The desktop UI's visual language — planes, alpha borders, radii, type, motion, and interaction states — and how to change styling without breaking it. Use when styling or restyling anything in apps/desktop, adding a component or state, adjusting spacing, color, hover, focus, or elevation, or reviewing a change that touches styles.css.
---

# Novus UI

Calm, technical, alive, precise, collaborative. Dark graphite and near-white,
with colour reserved for meaning. Depth comes from a small set of systems, not
decoration. Every rule below exists because its absence is what made the app
read flat; break one and that flatness returns locally, which is worse than
globally because it shows.

All tokens live in **`packages/ui/src/tokens.css`**, which both clients import.
Do not introduce a literal where a token exists — and after the scales below, a
token exists for essentially everything.

## Novus Signal — read this first

The product is a shared workroom where several people and several agents work
one change together. Two rules follow from that and outrank everything else in
this file.

**1. Colour says whose work this is, or what needs a person. Never how good it
is.**

| Token | Means, and means only this |
| --- | --- |
| `--signal` | Live work, control, addressability. Blue. |
| `--ws-1`…`--ws-4` | Workstream identity — provenance. Equally saturated, none of them green, because a colour that reads as a verdict would rank the approaches on the one surface that must not. |
| `--add` | Added lines, and **verification that actually ran and passed**. |
| `--alert` | Something is waiting on a person. |
| `--del` | Removed lines, and failure. |
| `--action` / `--action-text` | The one inverted control: the dominant action. |

**Green is verification. An agent finishing is not an agent being right.** A
`run.completed` milestone, a "Done" workstream, a summary — all neutral. The
only things that may take `--add` in chrome are a passed check and a verified
mission. This is the distinction the whole product exists to make; it is worth
more than any layout in this file.

**2. Composition follows state. A region that has nothing to say is absent, not
empty.**

`apps/desktop/src/mission-state.ts` derives which of seven states a mission is
in and returns a `MissionComposition` saying which regions exist. The shell
reads that object; it does not re-decide from `busy && attempts.length && …` in
the markup. That re-deciding is exactly how the old shell came to render the
lifecycle, an Approaches explanation, Control, Participants, Required checks and
Changed files — all of them empty — on a repository nobody had asked anything
of yet. **Each state must render a genuinely different composition, not the
same three columns with different words in them.** `workroom.render.test.tsx`
holds that, and most of its assertions are about what is *absent*.

### Typography is split by kind, not by chrome

Sans (`--font-ui`) is the product's voice: mission goals, navigation, actions,
explanations, names, status, evidence sentences. Mono (`--mono`) is for
literals only — code, commands, paths, branches, model ids, tokens, raw output.
A path is mono because somebody may retype it; "Nothing has verified these
changes" is not.

### One primary action per screen

`.button--primary` is filled in `--action` (the foreground colour) with
`--action-text` on it. **It is the only inversion anywhere in the app**, which
is what makes it unmistakable without spending a hue. Two of them on one screen
destroys the whole mechanism — the recovery state's button is deliberately a
plain `.button` for this reason, because the dock's Send is already the primary.

### Stylesheet layout

- `packages/ui/src/tokens.css` — tokens, both clients.
- `apps/desktop/src/styles.css` — shell and the older surfaces.
- `apps/desktop/src/styles/` — one file per feature area. **New component work
  goes here.** `styles.css` passed four thousand lines covering every screen the
  app has ever had, which makes "where does this rule live" unanswerable and "is
  this rule still used" unanswerable twice.

**The collision that will bite you:** `styles.css` `@import`s the feature files
at the top, so on equal specificity **the older rules in `styles.css` win**.
`.evidence__*` and `.rail*` already exist there, owned by the compare screen and
the legacy rail. The Workroom's copies are scoped (`.evidence--panel …`,
`.rail.rail--workroom`) for exactly this reason — a single class lost every
property the two blocks shared, and the inspector silently inherited a
decorative `::before` diamond and the wrong gap. If a new rule looks like it is
not applying, check for the same class name further down `styles.css` before
anything else.

## Scales

This is the section the rest of the file now hangs off, and it is the one that
did not exist. `:root` used to define radii, easing and font families and
nothing else: no spacing scale, no type scale. Every padding, gap, margin and
font-size across ~1600 lines was therefore hand-picked at its call site, and
every type size sat inside a 10–13px band.

**That absence was the "extremely vibecoded and generic" complaint, stated
mechanically.** Values that do not come from a system cannot produce rhythm,
and a type scale whose steps are 10/11/12/13 cannot produce hierarchy — nothing
can read as more important than anything else because nothing is meaningfully
bigger than anything else. Neither problem is fixable by nudging individual
values, which is why the fix was a full refactor rather than a pass of tweaks.

**Spacing** — `--space-1`…`--space-8`: 2, 4, 8, 12, 16, 24, 32, 48. Base 4 with
real jumps at the top. Named by intent in the stylesheet's own comment
(hairline / tight / compact / default / comfortable / roomy / section / page)
so the right step is obvious at the call site and adjacent steps do not get
picked by feel.

**Type** — `--text-eyebrow` 11, `--text-micro` 12, `--text-small` 13,
`--text-body` **14**, `--text-section` 15, `--text-title` 16, `--text-screen`
19, `--text-hero` 24, `--text-display` **30**.

`--text-display` is the mission goal and the start canvas's question, and it is
the only display-sized type in the shell. Before it existed, the strongest text
on a session screen was the repository path — so five missions in one
repository all opened looking identical.

- **Body went 12px → 14px.** "Everything still feels very small/tiny in the
  grand scheme of things" was direct feedback. This is a desktop application,
  not a terminal status line; 14px is what GitHub, Zed and Linear use for body
  text. Sizes came up across the board as a consequence, not as a separate
  decision.
- The bottom three steps are deliberately close, because dense technical data
  has to live somewhere and a diff gutter cannot be 16px. **Hierarchy does not
  come from that end.** It comes from 14 → 16 → 19 → 24, which are real jumps.
  The old scale had no step above 14 at all, which is exactly why nothing on
  screen had a top.

**Line height** — `--leading-flat` 1.15 (single-line chrome where the box sets
the height), `--leading-tight` 1.35 (headings), `--leading-normal` 1.5,
`--leading-prose` 1.65 (anything the model or a person wrote).

**Weight** — `--weight-normal` 400, `--weight-medium` 500, `--weight-strong`
600. **"500 is the app-wide maximum weight" is superseded.** That rule existed
because mono bolds optically fast, and it stopped being true for chrome the
moment the type split put chrome on a proportional face. 600 is now correct for
headings and primary buttons. 500 remains the maximum on anything set in
`--mono` — the original reasoning still holds there, and that is the selector
list near the top of the stylesheet.

**Control heights** — `--control-s` 24, `--control-m` 30, `--control-l` 36. A
design system sizes its controls; picking a height per button is how you end up
with five buttons that are all almost the same height.

**Layout** — `--bar-h` 40, `--session-bar-h` 46, `--rail-w` 264, `--files-w`
240, `--tree-w` 236.

### What is still allowed to be a literal

Geometry, not rhythm, and each one carries an inline comment saying so:

- 1px/2px hairlines and accent bars (a border is not a spacing step)
- dot and glyph diameters (6px dots, 12px glyph cells)
- grid track widths, min-widths, max-widths (component geometry)
- percentages, viewport units, `ch`, and `999px` for a pill

Anything else that is not a `var()` is a bug. **A half-migrated stylesheet is
worse than either extreme**, because the next person cannot tell which values
are load-bearing.

## The nesting rule

> **At most one border between you and the canvas.**

If a container already sits inside something bordered, it separates with
**space** and a **plane change**, never another line.

"Too many boxes in boxes, very rectangular — I'm looking for something more
free flowing" was direct feedback, and the cause was mechanical rather than
aesthetic: almost every separation in the stylesheet was a 1px border, so a
panel inside a panel inside a body genuinely *was* three nested rectangles.

What this changed, concretely:

- **Tool cards and patch cards lost their borders and became wells.** A tool is
  mostly output, and "output sinks, chrome rises" (see *Planes*) already said
  where output belongs — so the plane change now does the separating a border
  used to. That removes one rectangle from every single tool call.
- **`.patch` lost three lines, not one**: its own border, the rule under its
  head, and the rule under its intent.
- **Rail sections separate with `--space-6`,** not rules. Single biggest
  de-boxing move in the file.
- **`--inset`** is new: "one step deeper than whatever you are on", expressed as
  a *black* alpha (`rgb(0 0 0 / 0.28)` dark, `rgb(20 20 22 / 0.05)` light) so it
  darkens on any plane instead of being tuned for one. It is what a nested well
  uses — a raw payload inside a tool card, a diff inside a patch card, the
  segmented control's track, the permissions group. There is no plane below
  `--bg-well`, so this is how you go deeper without inventing one.

Two places deliberately keep a line, and both earn it: `.tool-group__body`'s
left rule is the thread tying a group's events to the header above them, which
space alone cannot say; and the rail/files/tree outer edges are genuine region
boundaries.

## Theme

Two token blocks, both in `:root` at the top of `styles.css`: `:root,
:root[data-theme="dark"]` (the default) and `:root[data-theme="light"]`.
`data-theme` is stamped on `<html>` synchronously in `main.tsx` — before
React mounts, not in an effect — and kept there by `use-theme.ts`'s
`useTheme()` hook, which persists the choice to `localStorage`
(`novus.theme`) and defaults to `prefers-color-scheme` when nothing is
stored. The toggle itself lives in `app.tsx`'s titlebar (`.icon-button`,
labelled with the theme switching *to* — "Light" while dark). `apps/desktop/index.html`'s `color-scheme` meta tag is `dark
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

`--radius-s` **4px** (chips, kbd, badges), `--radius-m` **7px** (controls,
inputs, rows, timeline cards), `--radius-l` **12px** (panels, palette, modal,
compare cards), `--radius-pill` 999px (chips, counts, badges).

Raised from 3/5/8. "Very rectangular" was feedback about the whole screen, and
a larger radius on the containers that survived the border-removal pass is half
the answer — space is the other half. Outer always ≥ inner; nested radius is
the cheapest depth cue there is. Cards with full-bleed children (`.tool`,
`.patch`, `.palette`) need `overflow: hidden` or the child's background pokes
the corner.

## Shadows

Only the two floating surfaces cast: `--shadow-popover` (palette) and
`--shadow-modal` (invite). Both lead with a 1px ring in a color *darker than
the canvas* — the eye reads the ring as the edge, the blur is atmosphere, and
pure black on near-black casts nothing, which is why "shadows don't work in
dark mode" felt true here before. Do not add shadows to in-flow cards; borders
carry them.

## Type

**"Mono is the identity — no second face" is superseded.** That was this
document's original rule and it did not survive research prompted by direct
feedback that the pure-mono choice read as "too sleek." Checked what
comparable tools actually ship, not just their marketing: Zed keeps
`buffer_font_family` and `ui_font_family` separate and independently
configurable; Linear uses Inter for all UI/body text and reserves Berkeley
Mono for "code and technical labels" only; Warp uses a geometric sans for
virtually all UI text specifically so the app reads as approachable rather
than "for greybeards," keeping mono for terminal content only; Cursor uses a
system-ui sans for chrome and mono for code. None of them ship one monospace
face for their own chrome as a considered choice — the "monospace as brand
signal" wave (Linear, Vercel, Raycast) consistently means mono *accents*
inside an otherwise proportional UI, not literal 100% mono. That is a real,
sourced answer, not a hedge: mono-everywhere was the one typography choice
this research found no genuine precedent for.

Two faces now, both tokens in `:root`:

- **`--font-ui`** (`-apple-system, "SF Pro Text", "Inter", sans-serif`) is
  the new default on `body`. It carries anything a person reads as prose or
  acts on as a control: buttons, labels, panel titles, empty states, the ask
  bar, and — the one that matters most — the model's own explanatory text in
  the timeline (`.event__prose`), which needs to read as a message from
  something that can write English, not as another technical field.
- **`--mono`** (unchanged token, unchanged value) stays explicit on a
  consolidated selector list near the top of `styles.css`, right after the
  `body` rule: paths, diffs, tool names and their arguments, timestamps and
  durations, tabular counts, terminal content, file-tree names, and file
  content in the browser viewer. Every one of these is identifier-shaped or
  needs column alignment — the two things mono is actually for. New
  technical-content classes join that list; new chrome/prose classes do not
  need to do anything, since `--font-ui` is body's default.

**"Hierarchy comes from one extra weight and one extra size" is superseded**
by the type scale in *Scales* above — that framing was a description of having
no scale. Hierarchy now comes from the scale's own jumps. What survives:

- Wide tracking (`--track-eyebrow`, 0.09em) is for uppercase eyebrows only.
  Never track sentence-case text.
- The floor is `--text-eyebrow` (11px) and only for uppercase eyebrows.
- **`.eyebrow` is a single primitive**, not a per-region label class. Every
  section title in the rail, the panels and the open screen uses it. It
  replaced `.rail__label` and `.open__label`, which were two hand-tuned
  near-matches for the same thing.

### Tone

**Capitalise the first letter of every user-visible string.** The lowercase
`invite` / `attempts` / `terminal` / `browse` chrome read as affected, and was
called out as such.

Machine-shaped values are the trap: run status, stream state and participant
roles all arrive lowercase because that is how they are spelled in
`packages/contracts`, and rendering the contract's spelling verbatim is how
they got on screen that way. `session-tab.tsx`'s `sentenceCase()` fixes it **at
the render boundary** — the contract keeps its spelling, the screen gets a
capital. Do not "fix" this by changing the contract.

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

## Buttons and chips

Three button variants, one geometry, all sized from `--control-*`:

- **`.button`** — quiet: transparent until hover. The default.
- **`.button--primary`** — raised fill, strong border, weight 600.
- **`.icon-button`** — the ghost for chrome: no border at all, hover fill only.
- **`.button--large`** is a size modifier (`--control-l`), not a fourth variant.

Every variant has `:hover`, `:active` and `:disabled`. A new variant needs all
three or it will be the one control that snaps.

This replaced `.open__submit` / `.open__browse` / `.titlebar__action`, which
were three per-location button classes that happened to be used everywhere —
so "the quiet button" was spelled `open__browse` in the rail, in the compare
screen and in the invite modal.

**`.chip`** is the matching primitive for a small stated fact: permissions,
repository state, the session facts in the empty state. `--allow` (green) and
`--warn` (amber) are its two modifiers. It replaced `.titlebar__writes` and
`.titlebar__warn`, which were near-identical.

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
- **`session-tab.tsx`** is almost everything `app.tsx` used to render when a
  session was open: the session bar, rail, timeline (now with a docked ask
  bar and grouped tool activity — see *Ask flow* and *Timeline*), files
  panel, file browser, terminal dock, palette, invite panel. It calls all
  four per-tab hooks above. `app.tsx` renders one `<SessionTab>` per open tab.

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
activeId }`), read once on mount and written after every change. This *is*
"resume a session," for every stored tab — a relaunch starts a fresh worker
with an empty in-memory session registry, even though the durable event log
survives it, so a stored `SessionSummary` trusted directly looked alive (its
SSE stream reads straight from the store, registry or not) while every other
route on it 404'd. The hydration effect calls `open(repositoryPath,
allowWrites, allowCommands, tab.id)` for each stored tab — the same call the
Open screen's "carry on with" list already makes for a single session — and
drops any tab that fails to resume rather than keeping it around looking live
while being dead. `hydrated.current` is set synchronously before that async
work starts; `open` is keyed on `endpoint`, which changes once
`bridge().workerUrl()` resolves, and that identity change would otherwise
give the effect a second chance to hydrate the same tabs twice.

**New tab is `<OpenRepository embedded>`.** The same component the empty-state
screen uses, given an `embedded` prop that skips the full-page `.open`
wrapper and renders just `.open__panel modal`, which the caller (`App`) wraps
in `.overlay`. One component, two contexts — do not fork it into a second
"new tab" form.

## Composer

**"`/` overlay, not a chat bar" is superseded.** That was this app's earlier
position on how a person asks the agent something, and direct feedback
rejected it specifically: asking a question was reachable only by already
knowing a hidden keyboard shortcut, which read as exactly the "blackbox, not
a platform" complaint the rest of this pass answers. Do not revert to
`/`-only on the theory that the palette is more "restrained" — restraint
governs decoration, not discoverability, and a control nobody can find is not
restrained, it is hidden.

**`ask-bar.tsx` is superseded by `components/composer.tsx`.** The ask bar was
a one-line textarea and a button on a bar with a rule above it — three nested
rectangles to type one sentence into — and the feedback was that it "feels
empty" and needs to actually hold things.

The composer is a persistent, always-visible control at the bottom of the
timeline column, not a modal and not conditional on any mode. What changed:

- **No bar and no rule.** `.composer` sits on the same canvas as the timeline
  (`background: var(--bg)`), so the column reads as one continuous thing. The
  *field* is the only bordered element in it, which is the nesting rule applied
  to the control a person looks at most.
- **`.composer__field` is a container with a real minimum height**
  (`--space`-derived 76px, about three lines) and a **toolbar inside it**. That
  is the shape Cursor, Zed's agent panel and Claude's own composer converge on,
  and the reason is structural rather than stylistic: it is the only shape that
  can host controls without pushing them out into a second toolbar somewhere
  else. A one-line box had nowhere to put anything, which is why it was empty.
- It holds a **model picker**, what Enter is about to do, and the send action —
  all real state, no decoration.

**Auto-grow is CSS-only and this is not optional.** `.composer__grow` is a grid
with the textarea and an invisible `::after` replica in the same cell, the
replica fed the same text via `data-value`. The row is sized by the replica; the
textarea stretches to it. The obvious implementation — read `scrollHeight`,
write `style.height` — forces a synchronous layout on **every keystroke**, and
performance was explicitly called out. Both must keep identical padding,
font-size, line-height and letter-spacing or the replica stops predicting the
height. Verified: 76px at rest, 108px at four lines, caps at 220px and scrolls.

`/` still opens `CommandOverlay`, and the two do not compete because they answer
different questions ("what do I want to say" vs. "what do I want to run") — the
same split Zed's agent panel makes:

- The composer is one control for two jobs, decided by `busy`: idle, it calls
  `ask()` and starts a turn; mid-run, it calls `direct()` and steers the one
  already running, folded in at the run's next safe boundary. The placeholder
  *and* the button label say which job it is about to do.
- `/` still opens `CommandOverlay` — filters, jump-to-patch, copy-diff,
  reconnect, and its own quick-ask input — kept as a power-user accelerant,
  not removed. Its `onAsk` is busy-aware the same way the bar is (`direct()`
  mid-run, `ask()` otherwise), so the two entry points never disagree about
  which action a typed goal means.
- The session-bar's `<kbd>/</kbd>` hint reads "Commands," not "Ask" — it is
  honest about what the shortcut is for now that asking has its own visible
  control. It uses `.kbd-hint`, the same primitive as the composer's own
  Enter/Shift+Enter hint.

### The model picker is a seam, not a feature

`use-turn-model.ts` owns which model should handle the next turn: Auto, Opus,
Sonnet, Fable. **It deliberately does not talk to the worker.**
`POST /sessions/:id/turns` accepts `{ goal }` and the worker picks its model
from `FixedModelRouter`, built once at boot from `NOVUS_MODEL_PROVIDER` /
`NOVUS_MODEL`. Per-turn routing is a separate slice against `apps/worker`;
inventing a request shape here would be guessing at a contract that slice owns.

Closing the seam is three steps, in order, and they are written out in the
hook's own header comment: an optional additive field on the turn request in
`packages/contracts`; the worker's turn route reading it; **then**
`session-tab.tsx` passing `turnModel.selected` into `ask()`/`direct()` and
`use-session-actions.ts` putting it in the body. The call site in
`composer.tsx` carries a `TODO(model routing)` pointing back.

Until then the control is honest about what it is: it remembers a preference
(per tab, persisted app-wide to `novus.turn-model`) and shows it. **Nothing in
the UI claims a run obeyed it.** The only place a model is stated as fact is
the session bar, which reads it from the run's own `run.started` event, as it
always has. Do not "finish" this by displaying the picked model as though it
were the model that ran.

## Attempts, participants, and the view switcher

Branching a session, running competing attempts, and choosing between them on
evidence is the product thesis (README, *Starting wedge*). It was one lowercase
word in the corner of the session bar. Feedback said so directly.

It is now three surfaces over the same data:

- **A permanent rail section** (`.attempt`) listing each attempt with a status
  dot, label, diffstat, file count and test verdict. It draws
  `useComparison`'s `/compare` response, **which every tab already fetches** —
  so it costs no new request and no new poll. When there are none it says what
  forking is *for* and offers the action, rather than being absent.
- **A count in the view switcher** — `.viewswitch` is a real segmented control
  replacing three independent buttons that swapped their own labels
  ("attempts" becoming "timeline"). Those never told you what the other states
  were. Attempts carries a live count badge.
- **The compare screen**, retitled and given a subtitle, with the fork form as
  the one bordered container on it and the evidence scrolling under a pinned
  header.

**Presence got the same promotion.** Roles and handoff were a row of 5px dots.
Who is here and who holds control is multiplayer state, so it is a
**Participants** rail section (`.party`) with names, roles and the handoff
action in place. The session bar keeps a compact overlapping avatar stack
(`.presence__avatar`) as the at-a-glance version.

**Known gap, and it is not a UI gap:** `POST /sessions/:id/fork` cuts the
worktree and appends `fork.created`, but **never starts a run**.
`compareAttempts` intersects the session's fork handles with
`projectSession(...).runs`, so an attempt does not exist until something has
actually executed in the fork — and nothing in the worker does that today.
Forking from the UI therefore leaves the attempts list empty until a run
happens. That is `apps/worker`'s to fix, not this stylesheet's.

## Timeline: prose and grouped tool activity

Two changes, one dependency between them. Neither is meaningful without the
other, which is why they landed in the same pass.

**The harness was throwing away the model's own words.** Both provider
adapters (`anthropic-model.ts`, `openai-model.ts`) found a tool call in the
provider's response and built a `ToolCall` from it — and discarded any text
block sent alongside it in the same response, which is exactly where a model
narrates ("I'll check the config file first") before acting. `ModelResponse`'s
`tool_call` variant now carries that text optionally, `agent-runner.ts`
threads it onto `tool.requested`'s payload (`text?: string`, additive and
optional in `packages/contracts`, so every event already on disk still
parses), and the shared `EventRow` in `packages/ui` renders it as
`.event__prose` — full prominence, `--font-ui`, never muted — above the
mechanical call summary. Without this, "make the timeline read like an agent
explaining itself" has nothing to work with beyond the final `run.completed`
summary.

**Mechanical tool events collapse into one header per run of them; narrative
events never do.** `timeline-view.tsx` walks the event list and groups
consecutive `tool.requested` / `tool.approval_requested` / `tool.approved` /
`tool.denied` / `tool.completed` / `tool.failed` events into a
`ToolGroupRow` — a disclosure with a count badge and a terse mono summary
(`list_directory, read_file ×2, propose_patch, apply_patch, run_tests`).
Everything else — `run.started`, `run.progress`, `direction.*`,
`run.completed`, `receipt.created`, `checkpoint.created`, `decision.recorded`,
and so on — passes through ungrouped, at full weight. This is the same split
Zed's agent panel uses: the model's own words are the one thing that never
collapses; tool activity is what collapses, and it collapses by kind rather
than flattening into an undifferentiated list.

A group defaults **open** only while it is both the *last* group and the run
is `busy` — a turn's tool activity stays visible live, the way Zed's
in-flight turn does, and collapses the moment the turn ends or another group
starts after it. Any group a person has manually toggled stays exactly how
they left it: `session-tab.tsx` owns `groupOverrides: Map<groupKey,
open>` rather than each group owning its own local state, specifically so
`jumpTo` (the rail's "Tool calls" list) can force a group open — via
`groupKeyFor(events, sequence)` — before scrolling to a call buried inside a
closed one. A group's key is its first event's sequence number.

When a group is collapsed, any `text` its `tool.requested` events carry
still renders — as `.event__prose`, above the collapsed header — because
hiding the model's own explanation inside a disclosure nobody has opened yet
would recreate the exact problem this exists to fix. Expanded, that same
text renders exactly once, inline, as part of that event's own row; the
group header does not duplicate it.

**A group is indented into the content column, not flush left.**
`.tool-group` carries `margin-left: calc(36px + var(--space-4) + 2px)` — the
event grid's first track, its gap, and `.event`'s transparent highlight border.
A group has no sequence number of its own, so left-flush it started 48px to the
left of every event's body, and the model's prose (which renders as a direct
child of the group when it is collapsed) hung off the left edge of the column
everything else lined up in. Measured on screen; prose and event body now share
an x to the pixel. If you change `.event`'s grid or its border, change this.

Grouping applies only when the timeline filter is `"all"`. The `"tools"` and
`"patches"` filters already do their own flattening on purpose — someone who
asked to see only tool activity is asking for a flat, scannable list, and
regrouping what is already a filtered view would fight the filter.

## Empty states

A session's log is **never** actually empty — `session.created` lands the
instant a session opens — so `visible.length === 0` was true in practice for
almost nobody, and what a fresh tab actually showed was one real row: a
sequence-0 `session.created` card rendering as a bare "0 ◇" with nothing
after it, since a fresh session's `goal` is null until a run gives it one.
That row, alone, was the "still feels very MVP" complaint made literal.

`session-tab.tsx`'s `trulyEmpty` treats "exactly one event and it is
`session.created`" (under the `"all"` filter) the same as "no events," and
swaps in `.timeline__empty` instead of rendering that one row. It is now a
`--text-hero` headline, a hint at `--text-body`, **and the session's own facts
as chips** — repository name, whether writes are allowed, whether commands are.
"Feels empty" applied beyond the composer, and the answer to it is real state
the app has already loaded, not invented affordances or placeholder suggestions. The instant a run starts,
`session.created` goes back to rendering normally as part of real history;
nothing is ever hidden once there is anything else to show. The rail's Goal
section and the changed-files panel got the same treatment in miniature —
"No goal yet — ask the agent something below to begin" and "No files changed
yet" — worded to point at the ask bar now that it exists, rather than at a
keyboard shortcut.

**Known rough edge, not introduced by this pass:** resuming a session (`POST
/sessions` with `resume: <id>`) re-runs `SessionRegistry.create()`, which
appends a fresh `session.created` unconditionally — including on a resume,
where the id already has one. A resumed session with real history therefore
carries a second, usually-goal-less `session.created` at the *end* of its
log, rendering as one more bare "◇" row after everything else. `trulyEmpty`
does not (and should not) special-case this away, since by then the log has
real content and hiding an event that genuinely happened would be dishonest
about what the log holds. Worth a real fix in `session-registry.ts` — append
`session.created` only when `options.resume` is absent — but that is a
worker-correctness bug outside this pass's UI scope, not something to fix
as a drive-by.

## File browser ("caveman mode")

Read-only: browse the open repository, open a file, look at it. This was
explicitly deferred in the previous pass and is now real, confined host-side
the same way `apps/worker`'s own tools confine repository access — a second,
independent implementation in `electron/fs-browser.ts`
(`resolveInTree`/`isProtectedPath`, mirroring `resolveInsideRepository` in
`apps/worker/src/tools.ts`) rather than a shared import, because the two apps
share no package for it today and a human browsing files through Electron's
main process is genuinely new IPC surface — unlike the terminal (see the
comment beside `terminals` in `electron/main.ts`), which widens what the
*human* can do but nothing the *agent* could not already do via a shell on
this Mac. Repository-relative paths only, resolved through `realpath` so a
symlink cannot point out, `.git`/`.env*` refused outright. Wired through
`preload.ts`/`bridge.ts` as `novus:fs-list`/`novus:fs-read`, a fourth IPC
surface beside the worker URL, the access token, the directory picker, and
the terminal.

**A toggled mode of the body grid (`mode: "browse"`, alongside `"timeline"`
and `"compare"`), not a permanent fourth column.** Research into VS Code's
Explorer and Zed's project panel both argue for a persistent, always-visible
tree; Novus deliberately does not copy that here. The window has a real
900px minimum width already carrying a 244px rail, and browsing files in
Novus is closer to an occasional reference lookup — matching what the person
who asked for this actually called it, "caveman mode," a mode you enter, not
a rail you always have open — than to the constant target of every keystroke
a real editor's tree is, where you are the one writing every file. Toggled
from the session bar exactly like "attempts," which keeps the body grid's
three views ("timeline", "compare", "browse") conceptually uniform instead
of introducing a fourth, differently-shaped permanent-panel paradigm beside
three toggle-based ones. `.body--browse` is `244px 220px 1fr` — rail (Goal
and Run stats are still useful context while looking at a file), tree,
viewer.

**Icon-less**, deliberately, not merely for lack of an icon set: VS Code's
own Explorer ships with no file-type icons by default, and the team has said
they like the plain look. A chevron for directories (`▸`/`▾`) plus a
monospace filename (`.tree__name`) is the whole visual vocabulary — nothing
here earns a second glyph, on a palette that adds no hue for it to have
anyway. Directories sort before files, then alphabetically within each
(`fs-browser.ts`'s `listDirectory`), the same convention VS Code and Zed both
use and the one thing a bare `readdir()` order gets visibly wrong. A
directory's children are fetched once, on first expand, and kept — collapsing
does not drop the cache (`use-file-tree.ts`), so re-expanding is instant.

Selecting a file opens its content in the adjacent pane (`FileViewer`,
`.viewer`) — never an overlay, never replacing the tree — read-only, capped
at 2MB with a `truncated` marker past it (a viewer, not the agent's own
`read_file`, so this cap exists purely so a stray large fixture cannot freeze
the renderer painting it) and sniffed for a NUL byte in the first 8KB to
report "binary file — not shown" instead of garbling one.

## Terminal chrome

"Looks generic — I want a stylish terminal." Three things make a terminal dock
read as considered, and none of them is decoration.

- **A real header**: a prompt glyph (`❯`, `.terminal-dock__prompt`, in
  `--live`), the word Terminal, and the repository path, which ellipsizes from
  the head via the same `direction: rtl` + LRM-`::before` trick the session bar
  uses. Full `--bar-h`, on `--surface`, so it is chrome and the body below is
  output.
- **Genuinely sunken**: an inset top shadow rather than a flat 1px line makes
  the "output sinks" rule from *Planes* literal at that edge.
- **A full 16-colour ANSI palette.** This is the one that actually mattered.
  Only `background`/`foreground`/`cursor`/`selection` were set before, so every
  program that emitted colour — `git`, `ls`, a test runner, a compiler's
  diagnostics — rendered in xterm's stock palette, which is bright, saturated,
  and belongs to a different product. `TERMINAL_THEME` now carries all sixteen,
  desaturated toward this app's own: `--add`, `--del` and `--warn-text` are
  used **verbatim** for green, red and yellow. A terminal that cannot show
  sixteen colours cannot show `git diff`; a terminal showing them in someone
  else's palette is the thing that read as unconsidered.

Also: 13px (`--text-small`, the same step the diff and file viewers use — it
was 12, a step below everything else that shows code), `lineHeight` 1.35, and a
**bar cursor**. The block cursor is the single most recognisable stock-xterm
tell.

It still resizes: `.terminal-dock__resize` is a thin absolutely-positioned strip
straddling the dock's top edge, dragging it adjusts `terminalHeight` in
`session-tab.tsx`, clamped 140–640px. `FitAddon` re-fits via the
`ResizeObserver` `TerminalPanel` already had.

> **The mirror is unenforced and now larger.** xterm paints to canvas and
> cannot read a CSS custom property, so `TERMINAL_THEME` in
> `terminal-panel.tsx` hand-mirrors design tokens as literals. Change
> `--bg-well`, `--text`, `--text-dim`, `--add`, `--del` or `--warn-text` and you
> must change that map in the same commit. Nothing checks this — not the
> compiler, not a test. Each mirrored line carries a `// === --token` comment
> so the correspondence is greppable.

## Tab strip

Singled out in feedback as reading unconsidered specifically. Two additions,
both restrained (no new color, no decoration without function):

- **The active tab gets a bottom accent** — `.tab--active::after`, a 2px
  `--text`-colored bar — so it visually attaches to the session below it,
  the way a browser or editor tab does. This is a pseudo-element, not a
  `box-shadow` on `.tab--active` itself, deliberately: `:focus-visible`
  already owns `box-shadow` for the double focus ring, and a second
  `box-shadow` here would silently replace it on a tab that is both active
  and keyboard-focused.
- **`.tabstrip` carries a permanent, subtle edge `mask-image` fade** (10px
  both sides) rather than one that only appears once tabs overflow. Cheap,
  and it answers the more specific complaint underneath "unconsidered":
  everything about the strip was static except the busy-dot pulse.

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

Lives as the body grid's third column (`.files`, `--files-w`, in `.body`'s
`grid-template-columns: var(--rail-w) 1fr var(--files-w)`) — dropped entirely
in the compare screen (`.body--compare: var(--rail-w) 1fr`), because a fork's
changed files belong to `CompareView`'s own per-attempt columns, not this
session's panel. The widths are tokens (`--rail-w`, `--files-w`, `--tree-w`)
rather than literals; read them from `:root` rather than trusting a number
quoted here, which is how this paragraph went stale once already.

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
- **The guest stylesheet is a deliberate mirror, and this pass put it much
  further behind.** This visual language lives only in
  `apps/desktop/src/styles.css`. The guest now lacks the entire token system —
  the spacing and type scales, planes-as-wells, `--inset`, the button and chip
  primitives — on top of already lacking tabs, the files panel, and the theme
  toggle. Nothing there is *broken*: no `packages/ui` markup changed this pass,
  only display strings, which the guest renders identically. It simply looks
  like the old app. Since the guest is single-session and read-only by design,
  the real follow-up is narrower than it sounds — mirror the token block and
  the shared-component styles (`event`, `tool`, `patch`, `diff`, `kv`,
  `matches`, `compare`) in one deliberate pass, not by drift.
- **An unbounded xterm will blow the whole window's layout out.** This was
  found on screen at 1440px: opening the terminal expanded the body's middle
  grid column to **3316px** and pushed the session bar's actions off the right
  edge. `.terminal-dock` is a grid item and `.terminal-panel` is the flex item
  `FitAddon` measures against; without `min-width: 0` on both, their automatic
  minimum size is their content's, and the feedback loop is
  unbounded container → wide fit → wider container. Nothing about
  `terminal-panel.tsx` looks wrong while it happens, which is why it is worth
  saying out loud. Pre-existing, fixed this pass. Re-test by opening the
  terminal at 900px, the shell's own minimum.
- **A `<button>` centres its own text, and that inherits.** `.tool__head` is a
  button whose `.tool__summary` is `flex: 1`, so the summary sat centred in a
  588px box instead of next to the tool name. Every other row-shaped control in
  the file sets `text-align: left`; this one was missed, before this pass as
  well as during it. If you make a row a `<button>`, set it.
- **Long repository paths.** The session bar splits the path into
  `.session-bar__repo-name` (the basename, kept) and
  `.session-bar__repo-dir` (the parents, ellipsized at the *head* via
  `direction: rtl` plus an LRM `::before` that pins the leading slash, and the
  first thing to go when the bar is tight). If you touch it, re-test with a path
  longer than half the window —
  and see the min-width bullet above, which is the other half of what makes
  this actually work now that it sits inside `.session-bar` rather than the
  top-level `.titlebar`.
- **A stale `novus.tabs` in localStorage wedges the renderer.** Tabs persist by
  session id. Point the app at a rebuilt `NOVUS_DB` and every restored tab
  refers to a session that no longer exists; the opens hang, `opening` never
  clears, and *every row in the Mission Inbox renders disabled* — which looks
  exactly like a broken inbox and is not. Clear `localStorage["novus.tabs"]` and
  reload before blaming anything you changed. Found while screenshotting
  fixtures; cost most of an hour.
- **A mission that needs a decision does not open into the Workroom.**
  `decideDecisionRoom` routes it straight to the Decision Room, which is a
  different shell entirely. If you are trying to see a multi-workstream rail on
  screen, a forked session will not show you one — it will show you the compare
  screen. Use a session with more than one approach that is *not* awaiting a
  decision, or drive the components directly in a render test.
- **The gate does not see pixels.** `pnpm typecheck && pnpm test` passes on any
  CSS. Every bug in this section was found by *measuring the running app*, not
  by reading the stylesheet — and two of them (the xterm blowout, the centred
  tool summary) were invisible in a screenshot until the numbers were pulled
  out of `getBoundingClientRect()`. After a styling change: run the app, look
  at the screen you touched in a fresh session and one with long history, in
  both themes, and **measure the boxes you changed**.
- **Verify without spending model credit.** Drive a scripted `ModelAdapter`
  through the real `SessionRegistry` + `AgentRunner` against a scratch git
  repo, pointed at a throwaway `NOVUS_DB`; that produces genuine
  contract-validated events (including tool failures and the approval gate)
  with zero provider calls. Then launch with `NOVUS_CDP_PORT` set and drive the
  window over CDP. `SessionRegistry.create()` is what appends
  `session.created`, and without it the Open screen will not list the session.
  Pin `ANTHROPIC_API_KEY` to an obvious placeholder in the launch environment —
  `--env-file` does not override an already-set variable, so this is what
  guarantees a stray click cannot reach a provider.
