Purpose: Defines the Novus visual and interaction system: how the product must feel, the complete token system, layout, primitives, composition rules, state presentation, and the patterns that are prohibited. This document must be concrete enough to reject an unattractive implementation in review.
Authoritative for: product feeling, visual references, design tokens, typography, layout and shell, primitive components, composition rules, signature elements, information architecture of the three surfaces, state presentation (of states defined in PRODUCT.md), interaction, accessibility, keyboard behavior, responsive and overflow behavior, prohibited patterns.
Not authoritative for: what states and lifecycles mean (PRODUCT.md — this document presents PRODUCT.md's state names verbatim and may not add, rename, or merge states), system mechanics (ARCHITECTURE.md), status (PROGRESS.md).
Update when: PRODUCT.md adds or renames a state (same change); a token, primitive, or rule is added or changed — token changes require a DECISIONS.md entry.
Last reviewed: 2026-08-01

# Design

## Product feeling

Novus must feel: calm, soft, precise, slightly cute, premium, human, quietly technical, comfortable during long sessions, trustworthy, purposeful.

It must not feel: cyberpunk, neon, theatrical, like an admin template, like a generic IDE clone, like a generic AI dashboard, like a terminal multiplexer with decoration, like every component came from a separate prompt.

The resolving rule — every screen is checked against it: **density in the content, softness in the container, personality in the words.**

- *Structure is technical*: dense rows, tabular numerals, monospace for paths/SHAs/commands, precise 1px separators, keyboard-first affordances.
- *Chrome is soft*: squircle radii on interactive controls, generous outer margins even when rows are dense, warm off-white text, gentle motion.
- *Voice is cute*: microcopy ("Maya has the baton", "Nothing needs you right now"), small identity marks. Cuteness lives in words and proportion — never in ornament, and never on evidence. Diffs, checks, and receipts are the most restrained surfaces in the product.

## Visual references

Observed on public product surfaces as of 2026-08-01 (facts, not endorsements; structural study only — never copy branding, layout pixel-for-pixel, wording, or decorative identity):

- **Conductor** (conductor.build): the workspace as a single legible unit — branch, files, terminal, diff, and PR path hang off one noun; keyboard-addressable movement between work, diff, checks, and PR; a checks tab as one pre-merge gate; archive/history lifecycle hygiene. Borrow: legibility, calm density, direct stage-to-stage movement, cloud workspace lifecycle clarity.
- **Factory/Droid** (factory.ai): explicit autonomy levels with risk-classified actions; a clean separation of "what phase am I in" from "what is permitted"; continuity of one session across surfaces. Borrow: explicit permission boundaries, separation of primary workflow from advanced controls, instruction-to-tested-result directness.
- **Hoplite** (hoplite.sh): cloud execution as a normal expectation; thread statuses as a first-class state machine; inline typed approvals in the activity stream; keyboard-driven navigation; immediate previews; per-run cost legibility. Borrow: cloud-as-default posture, compact task-oriented presentation, approvals living in the stream rather than an admin surface.

Novus's own signature is none of these: it is the multiplayer Mission Room — the baton, the direction thread, the evidence ledger, presence as authorship, and the state line (see [Signature elements](#signature-elements)).

## Tokens

Every visual value in the product comes from this section. A literal hex, px shadow, one-off radius, or unlisted type size in component code fails review ([AGENTS.md](AGENTS.md#rules), rule 14).

Two themes exist: **dark is the default and the reference**; light is a token-for-token override selected by preference (Light / Dark / System, persisted, resolved before first paint — D-029). Components never branch on theme; they consume tokens only. Light values are provisional until proven on rendered screens the way the dark set was.

### Color

Dark, restrained system. No decorative gradients, no neon, no glow, no glassmorphism, no large colored panels. Color is semantic or absent.

| Token | Value | Meaning |
| --- | --- | --- |
| `--bg` | `#141517` | Application background (graphite, not pure black) |
| `--surface-1` | `#1C1D20` | Primary surfaces (warm charcoal) |
| `--surface-2` | `#232428` | Elevated surfaces: overlays, menus, dialogs |
| `--edge` | `#FFFFFF` at 8% | Default border; 12% hover; 16% max, never above |
| `--text-1` | `#ECEAE6` | Primary text (warm off-white) |
| `--text-2` | `#A8A49D` | Secondary text (warm gray): metadata and labels only |
| `--text-3` | `#918C84` | Faint: timestamps, disabled — never the sole carrier of information |
| `--accent` | `#E5E2DC` | Warm ivory: active state, focus, control/baton. Authority and activity are monochrome light, never a hue (D-028). Pressed: `#CFCCC5` |
| `--ok` | `#8FAE8B` | Muted sage: **verified evidence only** |
| `--warn` | `#D9A47E` | Soft apricot: attention, incomplete verification |
| `--danger` | `#C97B6F` | Muted red: failure, denial, destructive actions only |
| `--alt` | `#9C8DB8` | Subdued violet: identifies a competing approach only — never quality. May render as a 1px lane-header border: the only non-`--edge` border in the product |

Semantic lock: a token may not be used outside its meaning. Sage for "online" fails review exactly like a raw hex does. Anything not covered by a semantic token renders in neutrals.

Light theme overrides (provisional): `--bg #F2F0EC` · `--surface-1 #FAF9F6` · `--surface-2 #FFFFFF` · `--edge` black 10% (16% hover) · `--text-1 #26241F` · `--text-2 #5D594F` · `--text-3 #77726A` · `--accent #26241F` (authority inverts to warm ink; pressed `#3A3833`) · `--ok #4F7A4A` · `--warn #A15F28` · `--danger #A8443A` · hover/selected/pressed: black 4/6/6%. Same contrast obligations as dark.

Interaction states: row/list hover `#FFFFFF` at 4%; selected `#FFFFFF` at 6% plus a 2px `--accent` left edge; pressed `#FFFFFF` at 6%. Disabled controls: label and icon at 40% opacity, no hover response, default cursor.

### Typography

- UI family: **Inter** (fallback: system-ui). Mono: **JetBrains Mono** — paths, SHAs, diff content, commands, check names.
- Complete scale (size/line-height, weight). No other sizes exist.

| Step | Use |
| --- | --- |
| 11/16, 500, tracking +0.02em | Micro labels, uppercase section labels |
| 12/18, 400 | Metadata, timestamps |
| 13/20, 400 | Dense rows (mission list, activity, checks) |
| 14/22, 400 | Body, composer text |
| 16/24, 600 | Section headings |
| 20/28, 600 | Surface titles |
| 28/34, 650 | Mission title — one per room, nothing competes with it |

- Weights available: 400, 500, 600, 650. Nothing bolder.
- Tabular numerals wherever numbers align (counts, durations, line numbers).
- Hierarchy floor: every screen uses ≥3 distinct steps. Secondary/muted text is limited to metadata and labels; any sentence a user must act on is `--text-1`.

### Spacing, grid, shell

- Spacing scale (px): 4, 8, 12, 16, 24, 32, 48, 64. No other values.
- Grid: 8px base; rows in dense lists are 32–36px tall; touch/pointer targets ≥32px.
- Shell: top bar 48px, **borderless** — it separates from content by height and spacing alone, never a hairline; navigation rail 240px (Missions surface); Mission Room sidebar 280–320px max; content max-width unconstrained in the Room, 720px for prose-like content (receipts, empty states); outer page margins 24–32px.
- The app shell never scrolls; see [Overflow](#overflow).

### Radii

6px — inputs, rows, small controls, **buttons** (buttons are squarish, never pill-adjacent — D-029) · 10px — contained cards · 14px — dialogs, drawers, the composer · full — identity marks only. Squircle corner smoothing where the platform allows; plain border-radius with the same values where it does not. Radii come only from this list.

### Elevation

- Level 0: none (default; separation by spacing and 1px edges).
- Level 1: `0 1px 2px rgb(0 0 0 / 0.30)` — sticky bars, popovers.
- Level 2: `0 8px 24px rgb(0 0 0 / 0.35)` — dialogs, drawers.
- No colored shadows, no text-shadow, no blur >24px.
- Layers (z-order), lowest to highest: content · sticky bars · popovers and menus · dialogs and drawers · toasts.

### Focus

2px `--accent` ring, 2px offset, on every focusable element; never removed, never color-only. Focus is the accent's home turf — it is always visible and always the same.

### Motion

- Durations: 120ms (hover/press), 180ms (reveal/collapse), 240ms (overlays, the baton handoff). Easing: `cubic-bezier(0.3, 0.7, 0.3, 1)`.
- Motion only on state change. No entrance animations on initial render, no parallax, nothing animates unprompted. Exactly one element in the product may loop: the working indicator while an agent runs (`--motion-breath`: 1500ms opacity cycle — the only looping duration).
- Respect `prefers-reduced-motion`: all motion drops to opacity-only.

### Icons

One approved set (stroke style, 1.5px stroke, 16px default). No icon without adjacent text, except inside an IconButton with a tooltip. No emoji in chrome, states, or buttons — emoji appear only inside user-authored text.

### Identity marks

- Humans: circular mark, 20px (inline) or 24px (headers), initials on `--surface-2`, 1px edge. No photos in V0.
- Agents/harnesses: rounded-square mark, same sizes, harness glyph, always paired with the harness name in text. Agents are visually distinct from humans at a glance (circle = person, square = machine) and never rendered as characters or mascots.

### Status semantics

Status renders as **StatusDot + text**, never as a pill and never as color alone. Dot colors: `--accent` running/active, `--ok` verified, `--warn` attention/waiting, `--danger` failed/offline, `--text-3` idle/complete. The dot never blinks; the working indicator (`--motion-breath`) exists only on the active execution row.

## Signature elements

Five elements make a screen recognizably Novus. They are the only permitted uses of their respective treatments.

1. **The baton.** Control is one small solid `--accent` squircle beside the controller's name, everywhere the controller appears. A handoff moves the baton between names in one 240ms motion at the safe boundary. One mark, one meaning, product-wide — the answer to "who is in control?" is always this mark.
2. **The direction thread.** A submitted direction renders with a left-edge `--accent` line connecting author → direction → the activity it produced. Lifecycle (queued, applied, superseded, rejected) renders as states of that one thread — position and line treatment — not as badges.
3. **The evidence ledger.** Verification is a fixed two-column ledger (check name · outcome) in mono, `--ok` only after a check passed, environment attribution beneath. The identical ledger component appears in Mission Room, Review, and Receipt — "verified" always looks exactly the same.
4. **Presence as authorship.** Participants appear where they acted: small identity marks inline on directions, reviews, handoffs, and stops. There is no floating avatar pile; the ParticipantStack in the room header is the only aggregate view.
5. **The state line.** One persistent single-line strip under the mission title: current state + next action ("Running — Claude Code is editing auth middleware · Pause"). The state name is emphasized by weight (500) in `--text-1`, never by color — the header contains no colored text; it is the answer to "what is happening and what happens next?"

## Information architecture

Project-first (D-032). The window's subject is parallel agent work, never code files. Invitations, permissions, technical logs, environment configuration, and advanced settings live in bounded overlays or contextual inspectors.

1. **Projects sidebar** — the persistent left rail (240px): the user's repositories (GitHub and local), each expanding to its missions/workstreams; nouns and counts only, plus Add project (GitHub picker or local folder). An **attention view** at the rail's top surfaces Needs-you items across projects — the old Missions queue, demoted to a lens.
2. **Project room** — the center: **workstream tabs** across the top (parallel attempts, each its own harness/model choice); each tab is a chat-first mission room — the direction thread as a conversational feed, the state line, and a persistent chat composer (prominent; the one exception to the idle-height rule) carrying harness/model selection; Changes and Verification one keystroke away, never the default canvas.
3. **Review** — behavioral result summary; the diff; the evidence ledger; build/diagnostic state; comments; open concerns; PR readiness.

The room keeps Novus's identity inside Conductor-adjacent patterns: state line, evidence ledger, attribution, and (later) the baton are what the tabs contain — not a bare chatbot, and never a file tree as the main event.

## Layout

- Each surface declares one **primary region** occupying ≥55% of width. Sidebars ≤320px. Inspectors are overlays, not permanent columns. No two regions may have equal visual weight.
- Machinery is subordinate: model names, repo refs, workspace ids render at the 11–12px steps in `--text-2/3`, inside inspectors — never in the mission header. The mission, not the machinery, is the room's subject.
- Navigation rails contain nouns and counts only. Explanatory prose lives in tooltips or empty states, two sentences maximum.

### Density

Dense where content is (lists, activity, diff: 32–36px rows, 13/20 type); relaxed where chrome is (24–32px outer margins, 16–24px section gaps). Density never comes from shrinking type below the scale, and softness never comes from inflating rows.

### Overflow

The app shell never scrolls. Every surface declares which region owns overflow; only ScrollArea primitives scroll. Wide content (diff, ledger, tables) scrolls horizontally inside its own container. Content may never extend below the viewport unmanaged.

### Responsive

- One layout system for the desktop app's resizable window (the same client later ships in the browser). ≥1200px: full shell. 900–1200px: sidebar collapses to an overlay. <900px: single-column room — state line, activity, composer; Changes and Verification become full-screen views. Nothing hides that answers the eight room questions ([PRODUCT.md](PRODUCT.md#multiplayer-behavior)); things reflow, they do not vanish.

### Accessibility

- Text contrast ≥4.5:1 for every text token on every surface it may appear on, including `--text-3` (`#918C84` ≈4.6:1 on `--surface-2`, higher on darker surfaces); `--text-3` additionally stays restricted to timestamps and disabled labels and is never the sole carrier of information. Token changes must re-verify these ratios. Status never conveyed by color alone (dot + text always); full keyboard operability; visible focus everywhere; `prefers-reduced-motion` honored; all interactive elements labeled for assistive tech; live-region announcements for state-line changes, control transfers, and approval requests.

### Keyboard

- Global: `⌘K` command palette (actions scoped by capability), `⌘1/2/3` surfaces, `⌘J` next needs-you item.
- Room: `⌘Enter` submit direction, `⌘.` pause/resume, `⌘⇧S` stop (confirms), `G` then `C`/`V`/`A` jump to Changes/Verification/Activity, `R` request control, `O` offer control (controller only).
- Lists: arrow navigation, `Enter` open, `E` archive from Completed.
- Every dialog: `Esc` closes, focus is trapped and restored.

## Primitives

These are the only primitives. Feature components compose primitives; they never invent local styling, and no component may add an arbitrary color, radius, shadow, gradient, type size, or spacing value.

`Button` (primary/secondary/text/danger) · `IconButton` · `TextButton` · `Input` · `Textarea` · `Select` · `Menu` · `Tooltip` · `Popover` · `Dialog` · `Drawer` · `Tabs` · `StatusDot` · `IdentityMark` · `ParticipantStack` · `Row` · `Section` · `Separator` · `ScrollArea` · `Composer` · `EvidenceItem` · `DiffRow` · `CheckRow`

Composition rules:

- Primary Button: `--accent` background, `--bg` text — a light control on a dark product, never a colored one. Secondary: `--surface-1` with a 1px edge. Text buttons: `--text-2`, lifting to `--text-1` on hover.
- Exactly one primary Button visible per surface state. Everything else renders secondary, text, or icon.
- Maximum one border level per region: a bordered container never contains another bordered container. Nesting is expressed by spacing and type, never a second border. Section separation defaults to whitespace or a 1px Separator, not a card.
- Maximum one pill-shaped element per row; pills are interactive filters/toggles only. Status is StatusDot + text (see [Status semantics](#status-semantics)); new badge variants require a change to this document.
- New primitives require a DECISIONS.md entry.

## Component behavior

- **Composer.** Persistent in the room, proportionate: idle height one input row (≤56px), grows with content to 40% of viewport maximum. It states its behavior in placeholder microcopy per state (see matrix). Non-controllers' composer submits to the queue and says so. In a multi-workstream room it submits to the focused workstream and names it in the placeholder. It is never a large blank canvas.
- **Diff.** Per-file DiffRows: path (mono), +/− counts (tabular), state. Expanded: unified diff, mono 13/20, additions/deletions tinted at 12% background opacity of `--ok`/`--danger` — the only place those tokens appear as backgrounds. Inline comments attach to lines and appear in Review.
- **Verification.** The evidence ledger (signature element 3). Checks never render as pills; a pending check is `--text-3`, running `--accent` dot, passed `--ok`, failed `--danger` with its output one reveal away. Environment attribution ("reported by cloud workspace wsp_…") always visible — evidence is a claim with an origin ([PRODUCT.md](PRODUCT.md#principles) P3).
- **Mission-list row.** 36px: StatusDot, mission title (13/20, `--text-1`), repo ref (12/18 `--text-2`), controller's IdentityMark + baton if held, needs-you reason in `--warn` text when applicable, relative time (`--text-3`, tabular). No progress bars, no thumbnails.
- **Participants.** ParticipantStack in the room header: up to five 20px marks + overflow count; controller marked with the baton. Hover: name, role, connection state. Disconnected participants dim to 40%; they never disappear.
- **Control request.** An inline row in the activity feed (not a toast, not a modal): requester's mark, "requests control", Offer/Decline for the controller, quiet `--warn` dot while open.
- **Handoff.** The offer renders as a card-level row addressed to the recipient with Accept/Decline; on accept, "waiting for a safe boundary" appears in the state line; at the boundary the baton animates to the recipient (240ms) and an attributed event lands in the feed.
- **Workstreams.** One workstream: no workstream chrome at all — the room is the workstream. Multiple: a slim lane header per workstream (name, controller baton, execution status). An approach-flagged workstream gets an `--alt` edge on its lane header — identification only, never a quality signal, and no comparison UI unless both compared artifacts exist.
- **Cloud workspace lifecycle.** Rendered in the state line + an inspector: provisioning (progress as text, no spinner theater), ready, suspended, failed (provider error verbatim, Retry provisions new). Workspace machinery never occupies the canvas.
- **Repository continuity.** The workspace inspector shows location, mission branch, abbreviated base SHA, abbreviated workspace SHA, and one synchronization state: Up to date, Update available, Syncing, or Sync failed. These are compact label/value rows, not badges or a permanent status dashboard. Update available offers Inspect commits as the primary action; after inspection, Sync workspace is capability-gated and states that it waits for a safe boundary. Uncommitted files on another machine are never implied to be present. Local-mirror controls do not render in V0.
- **First-run setup.** The signed-out surface is a setup room, not a login page: no top bar and no hairline — the window's top inset is a full-width drag region and the traffic lights sit over the canvas. Content sits in the upper third, title left; the connection-card row aligns to the right edge of the content column. Title "Set up Novus" at the mission scale, one subtitle sentence, then the card row — the one sanctioned card grid in the product. Each card: official service glyph (monochrome, `currentColor`, from the sanctioned brand-icon set — D-029), name, one-line description, a separator, and a status row. GitHub is interactive (Connect → plain waiting text while the browser leg runs → "✓ Connected as {login}" in `--text-1`). Harness cards report *observed local facts* — CLI detected on this machine, signed-in plan where the CLI's own files state it — as claims about this Mac, never as Novus capability; when nothing is detected they say so plainly. Cloud execution wording stays future-tense until it exists (sole sanctioned mention of unreleased capability, D-028). Below the cards, a Theme row: label and one-line description left, a three-option segmented control (Light / Dark / System) right; the selection applies immediately and persists. Once connected, the surface's single primary action is "Finish setup", bottom-right. Waiting and error states are plain text — no dots, no spinners.
- **Review.** Result summary in prose (what the change does, per the mission's success criteria), then diff, then ledger, then comments/concerns as attributed rows, then PR readiness as a CheckRow list (approvals, checks, conflicts). One primary action: Request revisions or Accept result (capability-gated).
- **Receipt.** A single scrollable document (720px measure): goal, participants and roles, timeline of applied directions and control transfers, changes summary, the evidence ledger's final state, review outcomes, PR reference, and an explicit "remaining uncertain" section. Same components as the room — a receipt is the room, frozen.

## Transient states

- **Loading.** Quiet placeholders: `--surface-1` blocks in final layout positions, no shimmer animation. Structure appears first, content fills in.
- **Empty.** Left-aligned, one sentence + one action, no illustration. Missions empty: "No missions yet. Start one when you have work worth doing together." Never a decision UI over nothing: comparison views require two artifacts, "needs decision" requires a real decision.
- **Errors.** Inline at the failure site, `--danger` text + recovery action. Full-surface errors only when the surface cannot render at all: route load failure, authentication failure, or a missing resource.
- **Offline/reconnecting.** A single-line notice bar under the top bar — `--surface-1` background with a `--warn` StatusDot and `--warn` text; there are no filled color bars anywhere in the product: "Reconnecting — the room is current as of 14:32." No modal, no blur; stale content stays readable and read-only.
- **Permission denied.** The action stays visible but disabled, with a tooltip naming the capability and who has it ("Only the controller can pause. Maya has the baton."). Denial is informative, never mysterious; hidden actions are reserved for Viewer-irrelevant chrome.
- **Destructive confirmations.** Dialog with consequence stated in one sentence, the danger Button on the right, and typed confirmation only for irreversible org-level actions. Stop-execution confirms with one click; force-interrupt states what will be interrupted.
- **Toasts.** Only for outcomes with no visible surface result; one at a time; 4s; never for errors that have an inline home; never stacked.

## State presentation

Keyed verbatim to [PRODUCT.md](PRODUCT.md#the-mission-state-model). Fields per state: message (the state line), primary action (the one primary Button — states of unattended progress deliberately have none), secondary, canvas, sidebar, composer, evidence, participants, color, recovery. Fields not stated inherit from the preceding primary state; the sidebar defaults to participants and workstreams; overlay states change only the fields they name and never replace the primary state's layout.

**New mission** — "Set up the workspace to begin." · Primary: Provision workspace · Secondary: Edit mission · Canvas: goal + success criteria · Sidebar: participants, repo ref · Composer: disabled, "Available once the workspace is ready" · Evidence: none · Participants: ParticipantStack renders all participants with connection state · Color: neutral · Recovery: n/a.

**Provisioning workspace** — "Preparing your cloud workspace…" · Primary: none (in progress) · Secondary: Cancel · Canvas: goal + provisioning step as text · Sidebar: unchanged · Composer: disabled, same copy · Evidence: none · Color: `--accent` dot · Recovery: on failure → Workspace failed.

**Workspace failed** — "Workspace setup failed." · Primary: Retry (new workspace) · Secondary: View provider error · Canvas: error verbatim, mono · Sidebar: unchanged · Composer: disabled · Evidence: none · Color: `--danger` · Recovery: retry provisions new; error preserved in history.

**Ready for instruction** — "Ready. Tell {harness} what to do." · Primary: composer submit · Secondary: Invite teammate · Canvas: goal + success criteria · Sidebar: participants, workspace ready · Composer: focused, "Direct {harness}…" · Evidence: none yet · Color: neutral, `--accent` focus · Recovery: n/a.

**Agent starting** — "{Harness} is starting." · Primary: none · Secondary: Stop · Canvas: activity feed begins · Composer: enabled (queues) · Evidence: none · Color: `--accent` · Recovery: start failure → inline error + Retry.

**Agent running** — "Running — {current activity summary}." · Primary: Pause · Secondary: Stop · Canvas: activity feed streaming; direction thread visible · Sidebar: workstreams, files touched count · Composer: controller "Steer {harness}…" / others "Add direction to the queue…" · Evidence: checks appear as they run · Participants: working indicator on the execution row · Color: `--accent` · Recovery: disconnects → Runner offline overlay.

**Needs direction** — "{Harness} is waiting for direction." · Primary: composer submit · Secondary: Stop · Canvas: feed + the harness's question highlighted at bottom · Composer: focused · Evidence: current · Color: `--warn` dot · Recovery: n/a. Missions surface: Needs you.

**Needs approval** — "{Harness} asks to {action}." · Primary: Approve (controller) · Secondary: Deny · Canvas: approval request payload rendered plainly · Composer: enabled · Evidence: current · Participants: non-controllers see who can approve · Color: `--warn` · Recovery: deny returns to running with denial as context. Needs you (controller).

**Direction queued** *(overlay)* — thread shows queued position; composer confirms "Queued — applies at the next safe point"; author may cancel from the thread.

**Control requested** *(overlay)* — inline request row (see Component behavior); `--warn` dot on the participant stack; controller's Needs you.

**Handoff offered** *(overlay)* — offer row addressed to recipient, Accept/Decline primary for them; expiry countdown as text.

**Handoff waiting for boundary** *(overlay)* — state line appends "Handing control to {name} at the next safe point"; if the timeout passes: stall notice + Force interrupt (controller / Mission Admin) with consequence stated.

**Paused** — "Paused by {name}." · Primary: Resume (controller) · Secondary: Stop · Canvas: feed frozen at pause point, marked · Composer: enabled (queues) · Evidence: current · Color: `--warn` dot, calm · Recovery: n/a.

**Verification running** — "Verifying — {n} checks running." · Primary: none · Secondary: Stop checks · Canvas: feed + ledger with running rows · Evidence: ledger prominent · Color: `--accent` · Recovery: check-runner failure marks affected checks failed with output.

**Verification failed** — "{n} checks failed." · Primary: Review failures · Secondary: Re-run checks · Canvas: ledger with failures expanded first · Composer: enabled — revision direction is the expected next act · Color: `--danger` on failed rows only, chrome stays calm · Recovery: direction → new execution turn. Needs you.

**Work completed but unverified** — "Work finished. Nothing has been verified." · Primary: Run verification · Secondary: Review changes anyway · Canvas: changes + empty ledger stating plainly what did not run · Color: `--warn` · Recovery: verification or explicit acceptance-with-uncertainty (recorded in receipt).

**Ready for review** — "Ready for review." · Primary: Open review · Secondary: Request changes via direction · Canvas: result summary + changes + green ledger · Evidence: full · Color: `--ok` on verified rows only · Recovery: n/a. Needs you (reviewers).

**Revision requested** — "{Name} requested revisions." · Primary: composer submit (revision direction, pre-linked to the request) · Secondary: View request · Canvas: request + affected evidence · Color: `--warn` · Recovery: new execution turn.

**Pull request open** — "PR #{n} open — {checks/review summary}." · Primary: Open PR on GitHub · Secondary: Sync now · Canvas: PR readiness CheckRows + review state · Evidence: ledger + CI claims, attributed · Color: state-dependent per row · Recovery: sync failures inline with re-auth path.

**Completed** — "Completed {date}. Receipt saved." · Primary: View receipt · Secondary: View history · Canvas: receipt · Composer: hidden · Color: neutral; `--ok` only inside the ledger · Recovery: n/a. Terminal states never resume; every action here is read-only.

**Cancelled** — "Cancelled by {name} {date}." · Primary: View receipt · Secondary: none · Canvas: receipt including what was abandoned · Color: neutral, not red — cancellation is an outcome, not a failure · Recovery: n/a.

**Execution interrupted** — "{Harness} was interrupted." · Primary: Restart execution (a continuation in the same workstream) · Secondary: View last activity · Canvas: feed ending at a marked interruption point · Composer: enabled — direction queues for the next execution · Evidence: current, honestly partial · Color: `--warn` · Recovery: restart consumes the queue; nothing is lost. Missions surface: Needs you.

**Execution stalled** *(overlay)* — state line appends "No progress for {duration}"; Force interrupt available to the lease holder / Mission Admin with consequence stated; `--warn` dot; every use logged to the feed.

**Repository sync error** *(overlay)* — a notice row in Changes and the state line names the cause ("GitHub token expired", "branch conflicts with main"); primary for capability holders: View remediation (inspector with the error verbatim, mono); direction still queues; `--danger` on the sync row only, chrome stays calm.

**Reconnecting** *(overlay)* — the notice bar (see Transient states): "Reconnecting — current as of {time}." Room read-only; composer disabled preserving draft; on restore, bar resolves and backfilled events land marked.

**Runner offline** *(overlay)* — state line: "Runner offline — last heard {time}." Actions requiring the runner disable with tooltips; direction still queues durably; on reconnect, events backfill with a gap marker if any ([ARCHITECTURE.md](ARCHITECTURE.md#runner-plane)).

**Repository update available** *(overlay)* — state line appends "Repository update available — agent is on {short SHA}." Primary in the workspace inspector: Inspect commits · Secondary after inspection: Sync workspace (controller only; waits for a safe boundary) · Composer remains enabled and names the pinned revision in its context tooltip · Color: `--warn` dot on the inspector row only · Recovery: explicit sync succeeds to the reviewed target SHA or moves to Repository sync error. Missions surface does not become Needs you unless the active execution requires the update to proceed.

## Prohibited patterns

Each rule is testable in review; violating any one fails the review.

1. No CSS gradient functions anywhere (AGENTS.md rule 15).
2. No raw color values in component code; tokens only, used within their semantic.
3. No glow: shadows only from the elevation scale; no colored shadows; no text-shadow.
4. No pills for status; max one pill per row, interactive only.
5. No cards in cards; max one border level per region.
6. No screen with fewer than three type-scale steps.
7. No page scrolling: only ScrollArea scrolls; the shell never does.
8. No equal-weight regions; one primary region ≥55% width per surface.
9. No composer taller than one row at idle — except the project room's chat composer, whose prominence is deliberate (D-032) and still bounded at 40% of viewport.
10. No prose in navigation rails.
11. No decision or comparison UI over empty content.
12. No machinery (model, repo, workspace ids) in the mission header.
13. No emoji, mascots, sparkles, or cartoon robots anywhere in chrome.
14. No skeleton shimmer, no entrance animations, no unprompted motion; nothing loops but the working indicator.
15. No toast stacking; no toast for anything with an inline home.
16. No numeric stat tiles, donut charts, or dashboard furniture in V0 surfaces; counts are text in rows.
17. No center-aligned marketing-style empty states; no illustrations in empty states.
18. No new primitive, token, or badge variant without a DESIGN.md change and DECISIONS.md entry.
19. No Tailwind-default or library-default palette values leaking through (`blue-500` et al. fail review).
20. No presentation-only privileged actions: anything rendered as available must be server-enforced ([AGENTS.md](AGENTS.md#rules) rule 13).

Review procedure: implementation changes touching UI attach a screenshot; the reviewer checks it against this list and the [composition rules](#primitives). Text rules alone do not catch composition failures.
