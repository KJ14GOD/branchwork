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

Hierarchy still comes from exactly one extra weight and one extra size, on
top of the font split:

- **500 is the app-wide maximum weight** (mono bolds optically fast).
  It marks eyebrows (the 10px uppercase tracked labels), panel titles, and
  primary data (`.stat__value`, `.tool__name`, `.patch__path`).
- 14px exists for a small set of hero moments: the open panel title, the
  timeline empty state's title line, and the file viewer's empty hint.
  Everything else is the 10/11/12/13 scale that was already here.
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

## Ask flow

**"`/` overlay, not a chat bar" is superseded.** That was this app's earlier
position on how a person asks the agent something, and direct feedback
rejected it specifically: asking a question was reachable only by already
knowing a hidden keyboard shortcut, which read as exactly the "blackbox, not
a platform" complaint the rest of this pass answers. Do not revert to
`/`-only on the theory that the palette is more "restrained" — restraint
governs decoration, not discoverability, and a control nobody can find is not
restrained, it is hidden.

`ask-bar.tsx` is a persistent, always-visible control docked at the bottom of
the timeline column (`.ask-bar`, inside `.timeline-column` alongside the
scrollable `.timeline` above it), not a modal and not conditional on any
mode. This is the shape every tool researched for this that serves both a
chat-style and a command-driven audience converges on — Zed's agent panel
keeps a permanently docked, bottom-pinned message editor *and* a separate
`Cmd+Shift+P` command palette, and the two do not compete because they answer
different questions ("what do I want to say" vs. "what do I want to run").
Novus now does the same split:

- The ask bar is one control for two jobs, decided by `busy`: idle, it calls
  `ask()` and starts a turn; mid-run, it calls `direct()` and steers the one
  already running, folded in at the run's next safe boundary the same way
  the rail's old direction box used to. The placeholder text says which job
  it is about to do.
- `/` still opens `CommandOverlay` — filters, jump-to-patch, copy-diff,
  reconnect, and its own quick-ask input — kept as a power-user accelerant,
  not removed. Its `onAsk` is busy-aware the same way the bar is (`direct()`
  mid-run, `ask()` otherwise), so the two entry points never disagree about
  which action a typed goal means.
- The session-bar's `<kbd>/</kbd>` hint now reads "commands," not "ask" —
  it is honest about what the shortcut is for now that asking has its own
  visible control.

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
swaps in `.timeline__empty` — a real title-plus-hint pair, not bare centered
text — instead of rendering that one row. The instant a run starts,
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

Fixed at last pass for correctness (light/dark colors match tokens); this
pass is about it looking considered. `.terminal-dock` now:

- **Resizes.** `.terminal-dock__resize` is a thin, absolutely-positioned
  strip straddling the dock's top edge (`cursor: row-resize`); dragging it
  adjusts `terminalHeight` state in `session-tab.tsx`, clamped
  `140–640px`, applied as the dock's inline `height`. xterm's own
  `FitAddon` re-fits on every resize via the `ResizeObserver` `TerminalPanel`
  already had — no new wiring needed there.
- **Has a real header**, not just a label and a close button: a small
  monospace prompt glyph (`›_`, `.terminal-dock__prompt`) ahead of the
  repository path, which still ellipsizes from the head via the same
  `direction: rtl` + LRM-`::before` trick `.titlebar__repo` uses.
- **Reads as sunken**, not just colored like the well plane: an inset top
  shadow (`box-shadow: inset 0 6px 8px -8px …`) makes the "output sinks"
  rule from *Planes* literal at the one edge that used to be a flat 1px
  line.

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
  Mirror those in one deliberate pass, not by drift. This pass adds one more
  concrete instance: `packages/ui/src/event-row.tsx` now emits
  `.event__prose` for a `tool.requested` event that carries model text, since
  that markup is shared — the guest will render the paragraph with no styling
  at all until its stylesheet catches up, same category of gap as the rest of
  this bullet, not a new one.
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
