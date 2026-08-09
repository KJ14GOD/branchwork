Purpose: The append-only record of decisions that shape Novus. Anyone asking "why is it this way?" reads this file. Entries are never edited or deleted; a reversal is a new entry referencing the old one.
Authoritative for: the context, alternatives, consequences, and revisit conditions of every recorded decision, including vendor selections when they are made.
Not authoritative for: the current state of the product (PRODUCT.md, ARCHITECTURE.md, DESIGN.md describe the present; this file describes how we got here), status (PROGRESS.md).
Update when: a decision is made that constrains future work — architectural interfaces, vendor picks, scope changes, new root documents, new primitives or tokens, governance changes. Append only.
Last reviewed: 2026-08-01

# Decisions

Format per entry: Context · Decision · Alternatives · Consequences · Revisit when.

---

## D-001 — Clean rebuild from documentation

**Context.** The prototype accumulated product drift, contradictory documentation, oversized components, overlapping concepts, and an interface that no longer represented the product. Incremental repair kept reintroducing the drift.
**Decision.** Delete the prototype entirely (commit `50c4851`) and rebuild from a documentation foundation. No prototype source is restored or copied; its behavior carries no authority.
**Alternatives.** Incremental refactor (rejected: the concepts, not just the code, were wrong); keeping the prototype as reference (rejected: reference becomes template).
**Consequences.** Slower restart; zero inherited contradiction; PROGRESS.md starts honestly at nothing.
**Revisit when.** Never for the deletion; the documentation-first approach is revisited if docs and implementation begin drifting apart despite the gate.

## D-002 — Cloud-first, as a priority order

**Context.** Agent work on consequential missions must survive closed laptops, be joinable from anywhere, and run in isolation. Competitors are converging on cloud execution as the norm.
**Decision.** Novus is cloud-first: a Novus-managed cloud workspace is the default and the demo path. Cloud-first is a priority order, not an architecture constraint — the Mission Room is identical regardless of execution location.
**Alternatives.** Local-first with cloud later (rejected: multiplayer durability and the wedge both demand cloud); cloud-only (rejected: forecloses enterprise/local runners the protocol can keep cheap).
**Consequences.** V0 must ship workspace provisioning; local/enterprise runners are conformance targets, not launch surfaces.
**Revisit when.** Evidence shows the wedge's teams overwhelmingly demand local execution first.

## D-003 — Runner-agnostic architecture behind an execution-provider abstraction

**Context.** Executions may run in Novus cloud, on user machines, in customer environments, in third-party sandboxes, or behind enterprise runners. Building a microVM platform first would sink V0.
**Decision.** Define a runner protocol (runner always dials out; sequence-numbered events; idempotent commands) and an execution-provider interface owning only workspace lifecycle. Novus supplies one managed provider in V0; the conformance suite defines what "runner-agnostic" means.
**Alternatives.** Direct integration with one sandbox vendor's API throughout (rejected: vendor lock in the core); shipping local + cloud + enterprise simultaneously (rejected: scope).
**Consequences.** One protocol for all runners; no control-plane-dials-in mode ever; third-party sandboxes become adapters, not rewrites.
**Revisit when.** A provider appears whose model genuinely cannot fit the interface.

## D-004 — Operate first-party harnesses; never rebuild their loops

**Context.** Claude Code, Codex, Droid, and OpenCode each own their reasoning, context management, tools, and loops, and evolve monthly.
**Decision.** Novus operates harnesses through an adapter contract with declared capability manifests. Non-normalizable surfaces (approvals, pause semantics, mid-turn steering) pass through with attribution rather than being flattened or faked. Novus never reimplements a harness loop. V0 ships exactly two adapters: Claude Code and Codex.
**Alternatives.** Building an in-house harness (rejected: competes with partners on their strength, not ours); normalizing all harnesses to a lowest common denominator (rejected: destroys each harness's best features).
**Consequences.** Product promises are bounded by what harnesses expose (no universal mid-turn transfer promise); adapter manifests become load-bearing; harness CLI churn is an accepted maintenance cost.
**Revisit when.** A harness offers a stable, richer embedding API that changes what an adapter can promise.

## D-005 — Mission is the shared object

**Context.** The prototype scattered collaboration across sessions, rooms, runs, and comparisons; nothing was clearly *the* thing a team gathered around.
**Decision.** The Mission — goal, success criteria, participants, control policy, event history, receipt — is the unit of attention, invitation, collaboration, and record. Everything else (workstreams, executions, workspaces) hangs off it.
**Alternatives.** Session-centric (rejected: sessions are execution-shaped, not responsibility-shaped); repo-centric (rejected: the repo outlives and blurs individual endeavors).
**Consequences.** One shareable boundary; receipts have a natural scope; the Missions surface is an attention queue over missions, capped in ambition.
**Revisit when.** Real usage shows teams need a durable grouping above missions (programs/epics) — which would be added, not substituted.

## D-006 — Workstream vs. approach: approach is a flag, not an object

**Context.** The prototype turned retries, second harnesses, and follow-ups into implicit "competing approaches," making comparison chrome dominate empty rooms.
**Decision.** A Workstream is a lane of responsibility; a new Execution in the same workstream is a continuation, never an approach. "Approach" is an explicit flag on a deliberately created sibling workstream. Most missions have one workstream, one execution. Comparison UI may not render unless two flagged artifacts exist.
**Alternatives.** Approach as a first-class object (rejected: a fifth concept whose default presence invites the old failure); no approach concept at all (rejected: deliberate comparison is a real advanced workflow).
**Consequences.** Fewer concepts; the default room stays single-lane; approach workflows are opt-in and visually identified (`--alt`) without quality implication.
**Revisit when.** Deliberate-comparison usage grows enough to deserve dedicated structure.

## D-007 — Real authentication, organizations, and a production database from the start

**Context.** The prototype had no production auth, org system, or durable database, which made multiplayer claims theatrical and enterprise features unreachable.
**Decision.** The architecture defines authentication, sessions, org membership, mission-scoped invitations, server-side capability enforcement, and a durable relational event-logged store as V0 foundations — before any UI is built on top.
**Alternatives.** Prototype auth again and retrofit (rejected: retrofitting identity under multiplayer state is where the last product died); adopting a full enterprise IAM feature set now (rejected: SSO/SCIM are non-goals).
**Consequences.** V0 carries real auth work before visible features; every privileged action has a server check from day one.
**Revisit when.** Not expected; weakening this is not an option on the table.

## D-008 — Multiplayer is operational authority

**Context.** Presence-dot multiplayer is decoration; the product's differentiation is several people being genuinely responsible for the same agent-driven work.
**Decision.** Multiplayer is modeled as authority: a per-workstream ControlLease with exactly one holder, ControlRequests and HandoffOffers as separate durable machines, direction with an attributed lifecycle, capabilities enforced server-side as role ∪ lease, transfers only at runner-declared safe boundaries, and TTL/revocation so an absent controller can never deadlock a mission.
**Alternatives.** Advisory control ("anyone can type, socially coordinate") (rejected: fiction under pressure); mission-level single lease (rejected: breaks with multiple workstreams); connection-bound control (rejected: control is a grant, not a socket).
**Consequences.** Three small state machines instead of one tangled one; every control claim is CAS-validated; the UI can always answer "who is in control" truthfully.
**Revisit when.** Real teams need shared simultaneous control (pair-steering) — which would be a new, explicit mode, not a loosening.

## D-009 — Design is a product requirement

**Context.** The prototype's interface repeatedly read as prompt-generated: gradients, pill sprawl, cards in cards, equal-weight regions, an oversized composer, no hierarchy.
**Decision.** DESIGN.md is canonical and enforceable: a closed token set, a fixed type scale, a closed primitive list, composition rules, and a numbered prohibited-pattern list concrete enough to reject an implementation in review. UI changes attach screenshots reviewed against it.
**Alternatives.** Design guidelines as advisory taste notes (rejected: that is exactly what failed); adopting a stock component library's look (rejected: generic dashboard feel is a named failure mode).
**Consequences.** Slower first pixels; a recognizable product; review has teeth ("which rule does this violate?" has an answer).
**Revisit when.** The token or primitive set proves insufficient — extended by amendment, never by local invention.

## D-010 — Canonical documentation with exclusive authority

**Context.** The prototype's docs contradicted one another because several files answered the same question differently.
**Decision.** Seven canonical documents with mutually exclusive "Authoritative for" scopes and mandatory frontmatter. Overlap is resolved by ownership: PRODUCT owns meanings, ARCHITECTURE owns representation, DESIGN owns presentation keyed verbatim to PRODUCT's state names, README owns the workflow narrative, PROGRESS owns status with evidence, this file owns rationale, AGENTS.md owns process. Cross-references link; they do not restate.
**Alternatives.** One monolithic document (rejected: unreviewable, unownable); per-feature docs (rejected: sprawl is how contradiction breeds).
**Consequences.** Every fact has one home; the repository gate checks frontmatter, links, and the symlink; doc updates ride in the same commit as the change.
**Revisit when.** A genuine topic has no owner — the fix is assigning ownership, not adding a file reflexively.

## D-011 — No automatic proliferation of Markdown files or skills

**Context.** The prototype grew 15+ skills and multiple root documents that quietly forked product truth.
**Decision.** No new root Markdown file without an entry here. Skills and agent definitions may only point at canonical documents, never define product truth. CLAUDE.md exists solely as a symlink to AGENTS.md so all harnesses read one contract.
**Alternatives.** Skills as the documentation system (rejected: skills are invisible to humans reviewing the repo and drift instantly).
**Consequences.** Fewer files; the gate greps for definitions outside canonical docs.
**Revisit when.** A recurring workflow genuinely needs a skill — the skill links to docs and holds zero product truth.

## D-012 — Interfaces before vendors

**Context.** Database, blob storage, realtime transport, sandbox substrate, and identity provider all need vendors eventually; picking them first would let vendor shapes design the system.
**Decision.** ARCHITECTURE.md records interfaces and invariants only. Each vendor selection is made at implementation time and recorded here as its own entry with alternatives and exit costs.
**Alternatives.** Pick the convenient stack now (rejected: "convenient" is how the last architecture calcified).
**Consequences.** Scaffolding starts with explicit selection work; no doc names a vendor casually.
**Revisit when.** Each selection, individually, as implementation reaches it.

## D-013 — Org-provisioned harness credentials on shared workspaces

**Context.** A cloud workspace is shared territory: any file or env var readable by the harness is readable by whoever directs the harness. A participant's personal harness login on a shared machine is exfiltratable by another participant through the agent.
**Decision.** V0 cloud executions run on org-provisioned harness credentials scoped per execution, injected through the supervisor boundary; personal harness logins are never placed on shared workspaces.
**Alternatives.** BYO personal subscriptions on shared workspaces (rejected: cross-participant credential exposure); per-participant sandboxes (rejected: breaks the one-shared-workspace model of the wedge).
**Consequences.** Orgs need a harness credential setup step before first cloud mission; cost attribution is org-level in V0.
**Revisit when.** Harness vendors ship delegable, scoped, revocable per-user credentials suitable for shared environments.

## D-014 — Deletion by redaction in the event log

**Context.** Durable receipts and data-deletion obligations conflict: erasing events falsifies history; refusing deletion fails compliance.
**Decision.** Deletion requests redact event payloads while preserving the event skeleton (id, kind, actor kind, time). Receipts render redacted entries as "redacted," never silently omitting them.
**Alternatives.** Hard-delete events (rejected: receipts become lies by omission); refuse deletion (rejected: untenable legally and ethically).
**Consequences.** Receipt projection must handle redacted entries; retention policy is org-configurable over this substrate.
**Revisit when.** Counsel or regulation requires a different mechanism.

## D-015 — Workspace network policy: default-deny is the goal, default-logged is the V0 floor

**Context.** Workspaces execute model-generated code; unrestricted egress is an exfiltration channel. Full default-deny with a curated allowlist is operationally heavy for V0.
**Decision.** The workspace egress interface is allowlist-shaped from day one (package registries, repo host, model endpoints). V0 may ship with egress logged-and-visible rather than fully denied, but the interface, events, and UI treat egress policy as real so tightening is a config change, not a redesign.
**Alternatives.** Unrestricted egress silently (rejected: invisible risk); hard default-deny in V0 (rejected only as sequencing — it remains the goal).
**Consequences.** Egress activity is observable per workspace; enterprise conversations have an honest answer; a known gap is documented rather than hidden.
**Revisit when.** M2 (trust hardening) — default-deny becomes the requirement.

## D-016 — The repository gate is one executable script

**Context.** The first gate was an illustrative shell block in AGENTS.md that printed warnings without reliably failing, and could not check anchors, staleness, or raw design values.
**Decision.** The gate is `scripts/gate.sh`: a single command that exits non-zero on any violation and zero only when everything passes. It checks frontmatter presence and order, the CLAUDE.md symlink, a root-Markdown allowlist, file links, anchors, banned language, domain-term definitions outside PRODUCT.md, product truth in skills, gradients and raw color values in source, staged source changes without a PROGRESS.md update, and untracked files. Build/test/lint commands are added to it when application code exists.
**Alternatives.** Documentation-only checklist (rejected: that is what just failed review); a full lint toolchain now (rejected: no code exists to lint).
**Consequences.** "Run the gate" has one unambiguous meaning; CI can call the same script; false-positive greps were restructured so empty matches pass.
**Revisit when.** Application code arrives — the gate grows real build/test steps then.

## D-017 — Harness integration: wrap the official CLIs; auth follows machine ownership

**Context.** Feasibility was verified against official documentation on 2026-08-01. Claude Code: clean-Linux install, headless `claude -p` with `--output-format stream-json`, `--resume`, programmatic permission handling (`--permission-mode`, `--permission-prompt-tool`, hooks), SIGTERM semantics, and API-key/Bedrock/Vertex auth are all documented (code.claude.com/docs); Anthropic explicitly prohibits third-party products offering claude.ai subscription login. Codex: clean-Linux install, `codex exec --json` event stream, `codex app-server` JSON-RPC with mid-turn `turn/steer`, server-initiated approval requests, `turn/interrupt`, resume, and `CODEX_API_KEY` auth are documented (developers.openai.com/codex); API-key mode has documented feature limits vs ChatGPT sign-in, account sharing is prohibited, and no pause exists.
**Decision.** Novus adapters wrap the official CLIs as supervised child processes — Claude Code via headless stream-json, Codex via app-server JSON-RPC — with git as the authoritative diff source and worktree/branch isolation per workstream. Authentication follows machine ownership: on a user's own machine (future local runner), the user's personal harness login is inherited, Conductor-style; in Novus-managed cloud workspaces, only org-provisioned API credentials are used (D-013), never personal subscription logins — this is now vendor-mandated, not just our policy.
**Alternatives.** Harness SDKs as libraries (viable for Claude Code's Agent SDK; kept open as an adapter implementation detail); proxying personal subscriptions into the cloud (rejected: prohibited by both vendors' terms).
**Consequences.** Codex "pause" degrades to interrupt-and-resume per the adapter manifest; a hands-on spike (install, auth, stream, steer, approve, interrupt in a real clean Linux workspace) is still required before the adapter contract is frozen — documentation feasibility is not live proof.
**Revisit when.** The spike contradicts the documentation, or either vendor ships a first-party embedding API.

## D-018 — V0 client: a downloadable desktop app, one web-architecture client

**Context.** Cloud-first execution means the client is a window onto server state, but the product should feel like the tools teams already run agents in — a desktop app you download, as Conductor is. Shipping desktop and browser simultaneously doubles packaging work without proving product value.
**Decision.** V0 ships one client: an Electron shell around a single web-architecture client. Browser access later is a delivery change of the same client, not a second codebase. "Two real clients" in the Golden V0 workflow means two people's desktop apps.
**Alternatives.** Browser-first (rejected: the user decided desktop; a downloadable app also matches the local-runner future where the app supervises local CLIs); native (Swift/Tauri) shell (rejected for V0: team velocity and the web client requirement).
**Consequences.** Project structure is a web client + thin Electron shell from day one; nothing may depend on Electron-only APIs except the shell layer.
**Revisit when.** M2+, when browser delivery is scheduled.

## D-019 — Identity: GitHub OAuth plus first-party sessions

**Context.** V0 needs real authentication (D-007) without an IdP integration project. Every V0 user necessarily has a GitHub identity, and repository authorization already runs through GitHub.
**Decision.** V0 signs users in with GitHub OAuth; the control plane issues its own server-side revocable sessions. GitHub OAuth is identity only; repository access remains the GitHub App installation (never conflated, per ARCHITECTURE.md).
**Alternatives.** Email/password (rejected: credential storage burden for zero benefit); a hosted IdP like WorkOS/Auth0 (deferred: buys SSO we declared a non-goal).
**Consequences.** One "Sign in with GitHub" path; org SSO remains an extension point.
**Revisit when.** Enterprise SSO demand becomes real (currently a non-goal).

## D-020 — Database: PostgreSQL

**Context.** The control plane needs one relational store for durable state and append-only event tables with partial unique indexes and per-mission serialization (ARCHITECTURE.md).
**Decision.** PostgreSQL. Managed hosting choice is an operational detail, not a schema dependency.
**Alternatives.** SQLite (rejected: multi-node control plane); a separate event-store product (rejected: one database until proven insufficient).
**Consequences.** Event log, CAS invariants, and projections all use one engine's guarantees.
**Revisit when.** Event volume outgrows a single relational store.

## D-021 — Realtime: control-plane WebSockets, no vendor

**Context.** Clients need live room updates; runners need a persistent bidirectional command/event stream. The runner protocol already requires an outbound persistent connection.
**Decision.** The control plane terminates its own WebSocket connections for both clients and runners. No third-party realtime service.
**Alternatives.** Hosted pub/sub (Ably/Pusher) (rejected: a second source of delivery truth beside the event log, for money).
**Consequences.** Presence and event fan-out are control-plane code; horizontal scaling of socket termination is our problem, accepted at V0 scale.
**Revisit when.** Connection counts make self-managed fan-out the bottleneck.

## D-022 — Artifact storage: S3-compatible object storage (AWS S3 in V0)

**Context.** Transcripts, logs, screenshots, and receipt exports are blobs referenced by rows (ARCHITECTURE.md), with mission scoping and retention.
**Decision.** The artifact store is an S3-compatible interface; V0 uses AWS S3.
**Alternatives.** Database blobs (rejected: retention and size economics); Cloudflare R2 (viable; interface-compatible swap if egress costs matter).
**Consequences.** Signed, expiring URLs for client access; deletion/redaction cascades reach blobs.
**Revisit when.** Egress cost or region requirements favor another S3-compatible provider.

## D-023 — Cloud sandbox provider: E2B behind the execution-provider interface

**Context.** V0 needs one managed substrate for isolated workspaces that can install and run harness CLIs, hold a repo checkout, restrict egress, and suspend/resume — without Novus building a microVM platform (D-003).
**Decision.** The first execution provider targets E2B (Firecracker microVM sandboxes with persistence, pause/resume, and a supervisor-friendly API). It is an adapter behind the execution-provider interface; nothing outside the adapter may reference it.
**Alternatives.** Modal, Fly Machines, Daytona, Vercel Sandbox (Conductor's substrate) — all viable; E2B chosen for purpose-built agent-sandbox lifecycle and pause/resume matching our workspace state machine.
**Consequences.** Workspace lifecycle states map onto provider primitives in one adapter; the feasibility spike (D-017) runs on this substrate.
**Revisit when.** The spike surfaces provider limits (network policy granularity, cold-start, cost) — the interface makes the swap an adapter rewrite, not a redesign.

## D-024 — E2B confirmed by live spike; egress default-deny will use a proxy, not IP allowlists

**Context.** The live E2B spike ran 2026-08-01 (`spikes/e2b/spike-results.json`). Confirmed: sandbox create 125–190ms, pause 134ms, resume 238ms; files and running background processes survive pause/resume (frozen, not killed); both harness CLIs install and run in the sandbox. Also observed: E2B egress rules are IPv4 address/CIDR only (`::/0` rejected with a 400), and a default-deny policy built from resolved-IP allowlists blocks DNS itself — every allowlisted host became unreachable (HTTP 000) while denial of other destinations worked. Raw IP pinning is not a workable default-deny mechanism.
**Decision.** Keep E2B (D-023 stands; lifecycle and persistence results are excellent). Egress default-deny (D-015's M2 goal) will be implemented via an egress proxy in the workspace path — DNS and HTTP(S) routed through a Novus-controlled proxy that enforces a domain allowlist — not via provider IP rules. Provider IP rules remain as an outer coarse layer only. V0 continues under D-015's logged-egress floor.
**Alternatives.** Resolved-IP pinning with in-sandbox DNS override (rejected: brittle against CDN rotation, proven broken in the spike); switching providers for domain-level egress rules (not now: no evidence another provider's lifecycle matches E2B's, and the proxy is provider-agnostic anyway).
**Consequences.** The runner image gains a proxy component at M2; egress policy becomes testable independently of the provider; the spike script and results stay in `spikes/e2b/` as the reference experiment.
**Revisit when.** E2B ships domain-based egress rules, or the proxy proves incompatible with a harness's network expectations.

## D-025 — One mission branch per workstream; explicit Git synchronization

**Context.** A cloud workspace and a developer checkout are distinct filesystems. Current cloud-agent products converge on a Git-backed handoff: Conductor gives each workspace a branch and offers local/cloud workspace modes, Cursor Background Agents clone into a remote branch, and Codex, Jules, and GitHub Copilot return work through commits and pull requests. Invisible bidirectional filesystem mirroring would add conflict resolution, secret leakage, and provenance ambiguity before Novus has proven its mission loop.
**Decision.** Every workstream owns one dedicated mission branch created from an exact recorded base commit. The active workspace is the execution filesystem; GitHub is V0's explicit exchange boundary. Novus records and displays the base, workspace, and remote revisions; detects remote movement; checkpoints at safe boundaries; and requires a controller-authorized sync against reviewed SHAs. It never silently copies uncommitted local files, pulls, rebases, merges, or overwrites. Local mirrors and local runners must use the same branch/revision contract rather than introduce a second synchronization protocol.
**Alternatives.** Live two-way filesystem synchronization from V0 (rejected: high complexity and ambiguous authority); treating the cloud filesystem as permanent truth (rejected: provider workspaces are disposable); creating a new branch per prompt/execution (rejected: fragments one workstream's continuity).
**Consequences.** Workstream and workspace records carry revision fields; repository updates and sync outcomes are events; the runner protocol gains checkpoint and sync commands; UI always makes execution location and revision available without promoting machinery over the mission. V0 can ship cloud-only while preserving a credible local-mirror and local-runner path.
**Revisit when.** Design partners demonstrate that explicit branch synchronization breaks the core edit/agent loop, or a proven conflict-safe synchronization substrate can preserve attribution and security.

## D-026 — Documentation reconciliation is a gated implementation step

**Context.** `CLAUDE.md` already points to AGENTS.md and the workflow requires reading canonical owners, but the executable gate only noticed staged changes under three directory names. Unstaged implementation, scripts, spikes, or future service/client layouts could therefore pass without a PROGRESS.md reconciliation.
**Decision.** Every task starts from README.md, PROGRESS.md, and the relevant owning sections; every implementation change ends with an explicit canonical-document reconciliation. The gate examines staged, unstaged, and untracked implementation paths and requires PROGRESS.md to change in the same working change. Agents update only the owning document: status moves only with evidence, decisions append rather than rewrite, and unaffected documents are not mechanically touched.
**Alternatives.** Require humans to remind each harness (rejected: unreliable); duplicate all product truth into CLAUDE.md (rejected by D-010/D-011); force every canonical file to change on every code edit (rejected: creates meaningless churn and contradictions).
**Consequences.** Claude Code receives the rule automatically through the CLAUDE.md symlink; Codex reads the same AGENTS.md contract. The gate catches missing status reconciliation, while semantic ownership still requires agent/reviewer judgment.
**Revisit when.** The repository layout changes beyond the gate's implementation-path matcher, or a dedicated documentation-ownership linter replaces the shell check.

## D-027 — Desktop OAuth via system browser with a single-use claim; gated test hooks

**Context.** The desktop app must authenticate through GitHub OAuth (D-019) without embedding a browser, without running a local listener on the user's machine, and without ever exposing session credentials to the renderer. Deterministic tests and E2E runs cannot depend on GitHub's live OAuth upstream or a human clicking in a browser.
**Decision.** Sign-in starts at the control plane, which returns a state nonce and an authorization URL; the desktop opens it in the system browser; GitHub redirects to a control-plane callback that completes the flow server-side; the desktop polls a single-use claim endpoint that hands over the session token exactly once and destroys the flow. The token is held by the Electron main process only, encrypted at rest with `safeStorage`, and the renderer talks through a typed, zod-validated IPC bridge with `contextIsolation`, `sandbox`, and no Node access. Two test hooks exist, both refusing to activate in production/packaged builds: `NOVUS_FAKE_GITHUB` replaces only GitHub's upstream with a deterministic identity (flows, sessions, scoping, and persistence stay real), and `NOVUS_AUTH_AUTOVISIT` lets the E2E visit the authorization URL without a human browser.
**Alternatives.** Loopback redirect into an app-local listener (rejected: a listening port on the user's machine and a second redirect URI to manage); custom protocol deep link (viable later for packaged builds; polling works identically in dev and packaged modes); embedding the OAuth webview (rejected: credential phishing surface, GitHub discourages it).
**Consequences.** The control plane owns the whole OAuth exchange and the client secret never leaves it; the desktop needs no inbound network path; tests exercise the full session machinery without GitHub. The live-GitHub leg still requires real OAuth app credentials to be proven.
**Revisit when.** Packaged-build sign-in UX demands the deep-link return path, or GitHub ships a device-flow variant that fits better.

## D-028 — Monochrome authority; first-run setup surface

**Context.** The first rendered build used the dusty-blue accent on primary buttons and status dots. The user rejected it on sight: the blue read as generic, and the signed-out screen read as a login page rather than the start of a product. The reference feel (Conductor's setup screen, and the user's standing dark-monochrome taste) is a neutral, light-on-dark control language with a connection-card setup flow.
**Decision.** The `--accent` token is redefined from dusty blue `#7A9BBF` to warm ivory `#E5E2DC`: active state, focus, and the control baton are monochrome light, never a hue. Primary buttons are light controls (`--accent` background, `--bg` text). The state name in the state line is emphasized by weight, not color; the header contains no colored text. Sage/apricot/red evidence semantics are unchanged. The signed-out surface becomes a first-run setup room: no top bar, no hairline, a "Set up Novus" title and connection-card row where only real connections are interactive; unreleased capabilities may appear only as muted informational cards with no affordance — the sole sanctioned mention of unreleased capability in the product.
**Alternatives.** Keeping blue for the baton only (rejected: two authority colors is one too many); a pure login page (rejected: the first minute should establish the connection grammar the product lives on).
**Consequences.** DESIGN.md tokens, button spec, state-line rule, and setup spec updated in the same change; every existing `--accent` reference inherits the new value; screenshots re-captured.
**Revisit when.** A second authority color proves genuinely necessary (e.g., distinguishing two simultaneous controllers), or user testing shows the ivory reads as disabled.

## D-029 — Theme system, squarish buttons, brand glyphs, and local-harness detection on setup

**Context.** Second design review of the setup room asked for: a working Light/Dark/System theme choice, squarer buttons, official service icons instead of monogram chips, the card row weighted right, and connection status that reports what it can honestly know — including whether Claude Code and Codex are present on this machine and on what plan, the way Conductor's setup does.
**Decision.** (1) A real two-theme token system: dark remains the default and reference; light is a token-for-token override; preference (Light/Dark/System) persists locally and resolves before first paint; components consume tokens and never branch on theme. (2) Button radius moves to 6px — buttons are squarish, never pill-adjacent. (3) Brand glyphs come from the `simple-icons` package (CC0), rendered monochrome via `currentColor` — the sanctioned brand-icon source; no color logo bitmaps in the repo. (4) The desktop main process probes this machine read-only for harness CLIs (`claude --version`, `codex --version`) and their own credential files (`~/.claude/.credentials.json` subscription type; `~/.codex/auth.json` plan claim), and the setup cards report those observed facts as claims about this Mac. Nothing is transmitted; detection failing degrades to "not found." This does not change D-013: cloud executions still run on org-provisioned credentials, and card wording keeps cloud execution future-tense until it exists.
**Alternatives.** Dark-only until later (rejected: the user asked, and a token-override theme is cheap now, expensive after components accrete); shipping color logo bitmaps (rejected: unlicensed files in-repo and visual noise); skipping plan detection (rejected: an honest observed fact with real orientation value).
**Consequences.** DESIGN.md tokens gain a provisional light block; the credentials-file parsing is fragile-by-nature and wrapped so failure means "not found," never a crash; the light palette needs its own screen-proof pass.
**Revisit when.** Harness vendors change their local credential formats, or the light theme gets its evidence pass.

## D-030 — User-supplied Codex glyph; vectors stay for GitHub and Claude Code

**Context.** D-029 chose `simple-icons` as the sole brand-glyph source, but the set no longer carries OpenAI's mark, leaving Codex with a neutral monogram. The user supplied bitmap icons for all three services; the GitHub and Claude marks duplicate the vectors already in use (and one has a baked background), while the OpenAI knot fills the real gap.
**Decision.** The Codex card uses the user-supplied monochrome bitmap (nominative use, identifying OpenAI's own product), theme-inverted via CSS so it reads correctly on both themes. GitHub and Claude Code keep their `currentColor` vectors. The source bitmaps stay in `images/`; the app consumes a copy under `apps/desktop/src/assets/`.
**Alternatives.** Hand-tracing the OpenAI mark as an SVG path (rejected: redrawing a trademark from memory); keeping the monogram (rejected: the user explicitly supplied the icon to use).
**Consequences.** One bitmap glyph exists in an otherwise vector set; if OpenAI's mark returns to a licensed vector source, it replaces the bitmap.
**Revisit when.** A licensed vector of the OpenAI/Codex mark becomes available.

## D-031 — Repository provider boundary; creation-key idempotency; branch naming

**Context.** The repository slice (D-025) needs missions bound to exact base revisions with dedicated mission branches, but no GitHub App exists yet, and OAuth identity must never double as repository authorization. Duplicate submissions, retries, and relaunches must be structurally unable to create extra missions or branches.
**Decision.** Repository access lives behind a `RepositoryProvider` interface owned by the control plane (`listRepositories`, `resolveBase → exact SHA`, idempotent `ensureBranch`). Three implementations: the future GitHub App adapter (live), a deterministic fake — three fixed repositories including `flaky/payments`, whose first branch creation fails so retry paths are honestly testable — and an unconfigured provider that refuses with a named 503. The fake activates only via the existing fake-GitHub switch or `NOVUS_FAKE_REPOS=1`, both refusing production. Mission creation takes a client-generated `creationKey` (UUID per creation attempt, reused on retry) enforced by a partial unique index — duplicates return the existing mission. Mission branches are server-named `novus/m-{mission-id-fragment}`, one per workstream, with branch outcome (`pending|created|failed` + error) as durable workstream state, event-recorded, and retryable through an explicit endpoint guarded by status compare-and-swap.
**Alternatives.** Using the user's OAuth token against the GitHub API for repo access (rejected: identity is not authorization, and it collapses the org-level trust model); client-named branches (rejected: naming is server policy); treating branch creation as part of the mission transaction (rejected: external side effects don't belong in database transactions — the recorded `pending/failed` state plus retry is the honest shape).
**Consequences.** The live GitHub App integration remains genuinely unproven and is stated so; the desktop can walk the full flow against the fake with real auth (`NOVUS_FAKE_REPOS=1` in dev). Open product question recorded, not decided: the user asked about creating/attaching **local** repositories — that conflicts with D-002/D-025's GitHub-exchange boundary and awaits a deliberate decision rather than a quiet widening.
**Revisit when.** The GitHub App adapter lands (its installation flow gets its own decision), or the local-repository question is decided.

## D-032 — Project-first IA, chat-first room, local repositories, GitHub App

**Context.** After walking the working repository slice, the user judged the Missions-list-first surface bland and set direction against Conductor's work UI as the reference pattern: a projects (repository) sidebar, parallel workspaces as tabs inside one project, and a chat-thread room with a persistent composer carrying harness/model choice. The user has asked twice for local repositories as first-class alongside GitHub. Two guardrails were agreed: no wholesale shell copy — the tab content stays a Novus mission room (state line, evidence, authority) with a chat-shaped feed, adopting Conductor's *patterns* (parallel-work-first, files never the window's subject) inside our token system; and the chat surface ships only together with real harness execution, never as a mouthpiece for nothing.
**Decision.** (1) The IA pivots project-first: a persistent repositories/projects sidebar (GitHub and local), workstream tabs inside a project, and a chat-first mission room; the Missions attention queue becomes a secondary view, not the home. PRODUCT.md and DESIGN.md amend in the same change. (2) Local repositories become first-class now, reversing D-002's sequencing (cloud remains the architecture's spine and the multiplayer default; local is the first shipped execution surface). Local git operations run in the desktop app's main process — the local-runner precursor — never in the control plane; the control plane records local repos (provider `local`, machine-bound identity) and receives reported revisions as claims, per the existing plane rules. (3) Live GitHub repository access lands via a GitHub App created through the manifest flow (one user click to create, one to install); its installation tokens power the live RepositoryProvider. Identity OAuth remains identity-only.
**Alternatives.** Widening OAuth scope to `repo` (rejected again: identity is not authorization); keeping missions-first IA (rejected: the user's standing taste, twice affirmed, is parallel-work-first); local repos via the control plane running git (rejected: the control plane never executes).
**Consequences.** PRODUCT's information architecture and scope change materially; DESIGN's surface list and composer rules amend; the fake provider stays for tests while live GitHub and local providers join behind the same boundary; the next slice must pair the new shell with real local Claude Code execution to keep the chat honest.
**Revisit when.** The project shell exists and real usage says whether the attention queue deserves promotion again.

## D-033 — Reported execution events need runner credentials before multiplayer

**Context.** Adversarial review of the pivot found that `POST /missions/:id/events/report` derives `actorKind: harness` from the client-supplied event kind. Org scoping holds, so nobody can reach another organization's missions — but inside an org, any signed-in user could fabricate agent speech in the durable log, which contradicts the attribution promise the product is built on. Today every organization is a single person (their own machine reporting its own turns), so the exposure is self-to-self.
**Decision.** Ship the local execution surface now with reporting bound to the user session, and treat runner credentials as a **hard prerequisite for multiplayer**: before a second participant can join any mission, execution reporting must move to a per-execution runner credential issued at execution start, with the control plane rejecting harness-attributed events that do not carry it. Recorded here so the gap cannot be forgotten when presence work begins, and stated in PROGRESS as a known gap rather than a silent risk.
**Alternatives.** Blocking the whole slice until runner credentials exist (rejected: single-user orgs make the exposure self-only, and the local loop is what makes the chat honest); dropping harness attribution until then (rejected: attribution is the point — the fix is authenticating it, not removing it).
**Consequences.** The runner-token work in ARCHITECTURE.md gains a concrete first consumer; multiplayer cannot ship before it.
**Revisit when.** Invitations or presence are implemented — whichever comes first.

## D-034 — Unattended execution has no Novus-imposed ceiling; control authority and execution lifetime are separate

**Context.** The prototype's implicit rule — a participant disconnecting ends the work — was never written down and quietly contradicts the product's own promise that cloud execution survives a closed laptop. Two different questions had been collapsed into one: *who may issue commands* and *how long work may run*. Real missions (migrations, incident remediation, long verification loops) need work to continue while nobody is watching, and the same missions need authority to lapse the moment its holder does.
**Decision.** Novus imposes no universal wall-clock or turn-count limit. An authorized execution continues until the harness completes, requires human direction or approval, encounters a real failure, reaches an explicitly configured policy boundary, or receives an authorized pause, stop, or interrupt command. Specifically: participant disconnection does not itself terminate an already-authorized execution; an expired control lease removes that person's ability to issue privileged commands but never retroactively revokes work already authorized; a local execution requires the host desktop and machine to remain running, and quitting the host desktop records an explicit interrupted outcome and leaves no orphan process; cloud execution will later continue independently of the initiating laptop; provider workspace rotation preserves the mission through checkpoints and reconstruction; vendor quota, organization policy, or an explicit user budget may stop execution. Separately, the lease is amended to grant `execution.start` for its workstream: an applied direction with no active execution must be able to run, or "controller" means nothing.
**Alternatives.** A fixed maximum turn count or wall-clock ceiling (rejected: an arbitrary number that would cut real work in half and teach users to distrust the product); ending execution on controller disconnect (rejected: it is the behaviour cloud execution exists to eliminate, and it conflates authority with lifetime); requiring an Operator role to start any execution (rejected: the lease already names the person operating that workstream).
**Consequences.** PRODUCT.md's capability table gains `execution.start` in the lease column and its control section states the separation; ARCHITECTURE.md's disconnect rule is rewritten to match; the host desktop must record interruption on quit rather than leaving a room hanging on "running"; a policy-boundary interface is named but not built.
**Revisit when.** Organization policy (autonomy ceilings, budgets) becomes real, or cloud runners make an unattended execution someone else's cost.

## D-035 — Runner identity, credentials, and a polled command transport

**Context.** D-033 recorded that reported execution events were bound to the user's session, so within an organization a signed-in user could fabricate harness-attributed activity, and it made runner credentials a hard prerequisite for multiplayer. Multiplayer is now being built, so the prerequisite is due. The host desktop also needs to receive work it did not originate: the second participant has no local checkout, and their direction must execute on the machine that holds the repository.
**Decision.** The host desktop registers as the local runner for a workstream. The control plane issues a cryptographically random credential, stores only its SHA-256 hash, scopes it to (organization, mission, workstream, runner), makes it expiring and revocable, and returns the usable value exactly once — to the Electron main process, never to the renderer and never into an event payload. Runner requests authenticate with a distinct `Runner` scheme so a user session can never be mistaken for a runner. Only that credential may write `harness.*`, `runner.*`, `execution.*`, `workspace.*`, or verification evidence; the server chooses actor attribution and every payload is schema-validated against a closed union and size-bounded. Command delivery is a durable queue the runner polls: commands carry an id, workstream, execution, expected runner, idempotency key, ordered sequence, and a delivered/acknowledged/completed lifecycle. The runner reports through an outbox with a monotonic per-execution sequence, local buffering, bounded storage, backoff retry, a gap marker on overflow, and a shutdown flush; the control plane de-duplicates on (execution, sequence).
**Alternatives.** Keeping session-bound reporting until cloud runners exist (rejected: it is exactly the gap D-033 said must close before a second person joins); a persistent WebSocket now (deferred: D-021 still stands as the destination, but polling behind a proper protocol boundary proves the semantics — idempotency, ordering, replay — that the socket will inherit, and it is the part that is hard to get right); signing every event individually (rejected: a scoped bearer credential over a local loopback connection is the proportionate control at this stage).
**Consequences.** D-033 is resolved and multiplayer is unblocked. The runner protocol in ARCHITECTURE.md gains its first real consumer and its transport is named as polled-for-now. A local execution can be commanded by a participant who is not at that machine, which is what makes the second client's direction real rather than decorative.
**Revisit when.** The cloud runner lands and the same command and event semantics move onto the persistent connection D-021 chose.

## D-036 — A mission invitation grants ordinary organization membership; mission access requires participation

**Context.** Every user received a personal organization, and mission access was scoped to the organization alone. A two-person mission needs an explicit membership path, and the moment an organization has two people, organization scoping stops being sufficient: any member could open any mission by knowing its identifier.
**Decision.** Redeeming a mission-scoped invitation adds the redeemer to the mission's organization as an ordinary member (`org_role = 'member'`, never owner) and creates the participant row with the invitation's stated role. Invitations are single-use, expiring, revocable, and stored only as a token hash. Independently, mission access is narrowed: every mission read and every mutating command requires a participant row, and a non-participant receives 404 rather than 403 so a mission identifier cannot be probed. Cross-organization guests remain an extension point, not a quiet widening.
**Alternatives.** Unrestricted cross-organization guests (rejected: it invents a trust model nobody asked for and leaks organization state); a separate guest membership tier (deferred: least privilege inside one organization is enough for V0 and is honest about what it grants); leaving organization scoping as the only boundary (rejected: it makes a mission identifier a capability).
**Consequences.** PRODUCT.md's participant invariant is satisfied for real; the mission list becomes "missions you participate in"; an invited person gains ordinary organization membership, which is more than the mission alone and is stated plainly rather than implied.
**Revisit when.** A customer needs a reviewer who must not see the rest of the organization — the answer is the cross-organization guest, decided then.

## D-037 — Evidence is derived from git and from observed tool results, never from the harness's prose

**Context.** The room ended a turn with "Turn completed" and a checkpoint line, which is indistinguishable from a chat wrapper and, worse, invites the reader to treat the agent's own summary as the record. An agent that says "tests pass" has made a claim, not produced evidence.
**Decision.** Change evidence is derived from git only: the checkpoint SHA and its parent, per-file state (added, modified, deleted, renamed), additions and deletions, whether anything remains uncommitted, how many secret-like files were withheld, the branch, and the runner and environment that produced it. Verification evidence is recorded only from a structured harness tool call correlated with its own tool result: the command, a conservatively classified category, the observed exit outcome, and bounded sanitized output, attributed to the environment that ran it. A command that does not clearly match a known category produces no check at all. Assistant prose is never converted into a check, a completed turn is never a verified turn, and a checkpoint is never verification. When nothing was observed the surface says so. For V0 the bounded per-file unified diff is stored inline in the database rather than in the artifact store D-022 selected; blob storage arrives with transcripts and receipt exports.
**Alternatives.** Trusting harness-reported file lists (rejected: ARCHITECTURE.md already requires git as the diff source, and the harness's list is a claim); inferring verification from assistant text (rejected: it is precisely the fabrication the product exists to prevent); ingesting CI now (out of scope tonight, and it is a second evidence source with its own attribution).
**Consequences.** The room can show what changed, what ran, what passed, what failed, what was skipped, which environment reported it, and what remains uncertain — and can show honestly that nothing was verified, which is the uncomfortable state PRODUCT.md insists on keeping. Inline diff storage is a stated V0 shortcut with a known migration to D-022's store.
**Revisit when.** Diff volume outgrows inline storage, or CI ingestion adds its second attributed source of verification.

## D-039 — The evidence inspector docks to the right edge; invitation is a first-class surface

**Context.** Two things surfaced the moment the room was used rather than tested. First, Changes and Verification opened as an overlay drawer with a scrim, so reading the evidence hid the trace that produced it — exactly the comparison a reviewer needs to make, made impossible. The user asked for the Conductor-shaped alternative: a panel snapped to the right edge with its own on/off control. Second, and worse, the interface exposed every control verb but no way to **issue** an invitation: multiplayer was reachable only through the IPC bridge, which is what the end-to-end suite drives, so the tests passed while the feature was unreachable by hand.
**Decision.** (1) The inspector becomes a right-docked, toggleable column rather than an overlay: bounded to 420px and 40% of width so the room keeps the majority DESIGN.md#layout requires, closed by default, opened and closed by the same trigger, and deliberately not focus-trapping, because a docked region sits beside the work rather than over it. Below the single-column breakpoint it still takes the surface. DESIGN.md's "inspectors are overlays, not permanent columns" is amended accordingly — it is now "not permanent", which the toggle satisfies. (2) The projects rail gains a disclosure control per project, separate from selection, so a project can be read without moving the room. (3) Issuing an invitation lives in the inspector's Overview beside the participants it changes, showing the one-time token once with a copy action; redeeming one is a single-question dialog reached from the rail, which is the only place a person with an empty Novus looks.
**Alternatives.** Keeping the overlay and widening it (rejected: the problem is occlusion, not width); a resizable splitter (deferred: a fixed bound is one fewer state to persist and to get wrong, and it makes the ≥55% rule checkable); putting invitation in a top-level menu (rejected: it belongs with participants, which is the state it changes); a deep-link or protocol handler for joining (deferred: it needs packaged-build URL handling, and paste works identically in dev and packaged).
**Consequences.** DESIGN.md's layout rule, information architecture, and component behaviour amend in the same change. The end-to-end suite now drives invitation and redemption through the interface rather than the bridge, which is the coverage whose absence hid the gap.
**Revisit when.** A second docked region is proposed — at which point the ≥55% rule decides it, not taste — or packaged builds make a join deep-link worth the URL handling.

## D-040 — Workspace configuration is TOML, shared in the repository with a machine-local override

**Context.** A worktree contains tracked files and nothing else, so a workstream cannot install, run, or verify anything until somebody says how. That knowledge is a property of the project, belongs in the repository where a team already reviews it, and must not be re-entered on every machine. But two things in it are irreducibly per-machine: where a local file lives, and which values are secret. One file cannot hold both without either leaking secrets into version control or forcing every teammate to reconfigure.
**Decision.** Two files under `.novus/`. `settings.toml` is committed, shared, and non-secret: one setup command, named run commands with a default, named verification commands, relative working directories, whether run commands may overlap, optional preview and health information, and shared plain environment values. `settings.local.toml` is gitignored, machine-local, and layered over the shared file key by key — it may override any command or working directory and may name which local files and secret values this machine supplies. A value present in both wins locally. Neither file may carry a secret value in the committed half; the gate greps for it. The format is TOML, parsed with `smol-toml` — a small, spec-complete, dependency-free parser — because this is a file humans edit and review, and comments and obvious nesting matter more here than the zero-dependency convenience of JSON. `.worktreeinclude` is a separate, existing-convention file listing the gitignored paths a worktree needs; it is an **input to a proposal**, never an instruction to copy.
**Alternatives.** JSON with no new dependency (rejected: no comments, and a config a team reviews is exactly where comments earn their keep); a single file with a secrets section (rejected: one careless commit leaks the lot); YAML (rejected: a larger parser and a spec with more ways to be surprised); storing configuration in the control plane (rejected: it is a property of the code, it must branch and review with the code, and the control plane never needs to know how to build anything).
**Consequences.** A new runtime dependency in the desktop application. Configuration is reviewable in pull requests and travels with a branch. A machine that has not been prepared is honestly unprepared rather than silently broken, which is what the *Workspace needs setup* state exists to say.
**Revisit when.** Cloud workspaces need the same configuration, at which point the shared half is already in the right place and only the local half needs a substitute.

## D-041 — Three separate execution environments; secrets never leave the machine that holds them

**Context.** Every child process the desktop spawns currently inherits the whole Electron environment. That is how a harness credential ends up readable by a project's test command, and how anything a project prints can contain something Novus then reports upward as evidence. The three kinds of process Novus runs want genuinely different environments, and conflating them is a disclosure boundary nobody chose.
**Decision.** The runner constructs three environments explicitly, and no process receives the parent environment wholesale. (1) **Harness**: a minimal operating-system base plus the harness's own credential path, so Claude Code keeps working under the user's existing local login — and nothing from the project's secret set. (2) **Project commands** (setup, run, verification): a minimal base, Novus workspace variables, shared non-secret settings, machine-local settings, and only those secret values the local configuration explicitly selects — never the harness credential. (3) **Interactive terminal**: the project environment, plus the user's own shell profile, because it is their machine and their shell. Novus workspace variables are `NOVUS_WORKSPACE_ID`, `NOVUS_MISSION_BRANCH`, `NOVUS_PORT`, `NOVUS_PORT_RANGE_START`, `NOVUS_PORT_RANGE_END`. `NOVUS_WORKSPACE_DIR` is set for the terminal only; a worktree's absolute path is a fact about someone's laptop and does not belong in a variable a project command might echo into evidence. Secret values are held in operating-system-backed storage, are never written to the control-plane database, never cross the renderer bridge, and never appear in an event, a diff, a transcript, a screenshot, or an operational log. The renderer learns filenames and variable *names*, never contents.
**Alternatives.** Keeping one inherited environment (rejected: it is the disclosure boundary this decision exists to draw); passing secrets through the control plane so both participants share them (rejected outright — it would make Novus a secret-distribution system, which is a non-goal and a liability); a per-project encrypted file in the repository (rejected: a committed secret is a committed secret, however encrypted).
**Consequences.** The existing single `PROBE_PATH` environment splits into named constructions with tests asserting what each one does *not* contain. A project that needs a variable must say so in its local settings; that is the point. Cloud execution will need its own secret path, which D-013 already anticipates.
**Revisit when.** Cloud workspaces ship and org-provisioned credentials need the same separation on a machine nobody owns.

## D-042 — Controlling a mission is not owning the host machine

**Context.** The control lease grants operating authority over a workstream. A workstream's workspace currently lives on one person's laptop. If the lease also granted an interactive shell, then accepting a handoff would hand a colleague unrestricted execution on a personal machine — filesystem, credentials, everything — and the product would have quietly turned a collaboration grant into remote access.
**Decision.** Interactive terminal access to a local workspace belongs to the person whose machine hosts the runner, and to nobody else. It is not lease-granted and not role-granted; the runner simply offers no remote shell channel, so the restriction is structural rather than presentational. What a remote controller may do is invoke **named commands the project itself declared** — the setup command, a saved run command, a saved verification command — enforced server-side by a new `workspace.command` capability held by Mission Admin, Operator, and the lease holder. The interface states the distinction in words rather than implying it: controlling the mission is not unrestricted access to the host machine. Remote interactive shells wait for cloud or customer-managed workspaces, where the machine is not someone's laptop, or for a delegation mechanism designed on purpose.
**Alternatives.** Granting the shell with the baton (rejected: nobody consented to that when they invited a reviewer); an owner-approves-each-session prompt (deferred: it is a real design, and it is not this slice); hiding the terminal button for remote participants (rejected outright — that is presentation-only enforcement, which AGENTS.md rule 13 forbids and which a crafted request would walk straight through).
**Consequences.** The runner exposes no shell command in its protocol, so there is nothing to authorize incorrectly. A remote controller who needs something not in the project's saved commands must ask the host — which is the honest answer while the workspace is a laptop.
**Revisit when.** Cloud workspaces exist, or a customer needs delegated shell access badly enough to design consent for it.

## D-043 — A name is authorized; a pinned snapshot runs. Finite commands carry the project's own deadline

**Context.** A participant opened the Run control, read `test — npm test`, and pressed it. The control plane authorized *a name*; the runner then re-opened `.novus/settings.toml` at execution time and ran whatever that name meant by then. The window between the two is not theoretical: workspace commands queue behind the running turn, the harness works in the same worktree under `--permission-mode acceptEdits`, and `settings.local.toml` is gitignored — so an agent could rewrite what a participant had already authorized and leave no diff, no checkpoint file, and no changed-file row behind it. Separately, every finite command shared one hidden 30-minute constant with no way for a project to state its own, no way for a person to see it, and an outcome indistinguishable from an ordinary failure. And a participant who was not at the host machine could not list the declared commands at all, because listing them read that machine's disk — so `workspace.command`, a capability PRODUCT.md grants them, had no surface.
**Decision.** The runner reads the project and **publishes what it declares** as a `workspace.declared` event: kind, name, command line, working directory, deadline, category, port, preview URL, readiness signal, and a digest over exactly those fields. The control plane stores that list verbatim on the workspace row — it still never parses TOML and still does not know how to build anything — serves it to every participant, and, when it authorizes a command, **hands that exact snapshot back with it**. The runner executes the snapshot and refuses a command that arrives without one, rather than resolving a name for itself. A configuration change therefore changes what the *next* command will be, visibly, because the published list changes too. Timeouts become project policy in the same shape: `timeouts.setupMinutes` and `timeouts.verifyMinutes` with stated defaults, an optional `timeoutMinutes` per command, a documented maximum of 240 minutes enforced by validation, and a named `timeout` ending distinct from `exit`, `signal`, `cancelled`, and `spawn_failed`. A run command has no deadline at all and no field to put one in; a coding-agent execution never touches this path (D-034).
**Alternatives.** Comparing a digest at execution time and refusing on mismatch (rejected: it turns an ordinary configuration edit into a command that cannot run, and the participant's authorization is still the thing that should decide); having the invoking client send the snapshot it saw (rejected: a remote participant has no worktree and no snapshot to send, so the case that most needs pinning is the one it cannot serve); keeping the hidden constant and documenting it (rejected: a policy nobody can see is a policy nobody can argue with when it halves a real build).
**Consequences.** ARCHITECTURE.md gains the published command list and the pinned payload in the runner protocol; PRODUCT.md's Workspace gains the declared-command list as durable state. The Run control reads from the mission rather than from disk, which is what makes it work for a participant who is not at the host machine. Suggestions still come from a local inspection, because only the machine holding a repository can read one — and a suggestion has never executed from that menu.
**Revisit when.** Cloud workspaces publish the same list from a machine nobody owns, or a project needs a command whose deadline depends on what it is doing.

## D-044 — A secret value is supplied at the machine that has it, and refused when Novus cannot redact it

**Context.** The encrypted local store existed and nothing could put a value in it: its writer had no caller, so every project declaring `secretNames` was permanently reported blocked, and redaction — which removes held values from anything a command printed before it is reported — was a no-op over an empty set. Two smaller faults sat underneath. Values shorter than six characters were skipped by the redactor entirely, so had one ever been stored it would have travelled verbatim into a check's recorded output, a workspace's setup error, and both participants' screens. And a machine whose operating system offers no encryption got a store that returned from its write silently, so a caller could not tell that nothing had been saved.
**Decision.** Three local IPC verbs — read the declared names with a supplied flag, supply or replace one value, forget one value — reachable only from the machine holding the repository, exactly like inspecting a project. Nothing reads a value back: there is no verb that could, and the state a person sees is a name and a boolean, never characters and never a mask, because a mask is still a length. The redaction floor becomes an **entry** constraint: Novus refuses to hold a value shorter than 8 characters, in the store itself as well as at the bridge, and says why — a value it cannot reliably remove from output is one it will not accept, rather than one it leaks quietly. A machine with no credential encryption is told so and offered nothing; the store fails closed with a named error rather than writing nowhere.
**Alternatives.** Redacting short values anyway (rejected: blanking every occurrence of a five-character word shreds the output without protecting anything); storing a hash and redacting on match (rejected: redaction needs the value, and a hash cannot find it in a line); accepting short values and warning (rejected: a warning at entry time is read once and the leak is forever); routing values through the control plane so both participants share them (rejected outright by D-041 — it would make Novus a secret-distribution system).
**Consequences.** A project that declares a secret can now be prepared, and `secretNames` stops reading as a permanent blocker. The 8-character floor is a stated storage constraint a person meets or works around, not a silent exception. Values still never reach the renderer, the control plane, an event, a diff, a log, or a test snapshot.
**Revisit when.** A real credential shorter than the floor turns up, or cloud workspaces need a secret path on a machine nobody owns.

## D-045 — Readiness is declared, previews open through a loopback-only bridge, and detailed output lives in a runtime dock

**Context.** Three separate things were being conflated. A run command that had spawned was reported *running*, which the room presented as an application being up — a process existing proves a process exists. A preview could not be opened at all, because Electron's window handler forwarded only `https:` while every local preview is an `http` loopback address; the same check would have forwarded `https://evil.example` from a `previewUrl` any repository can commit, so the one gate in place blocked the intended case and passed the dangerous one. And the output of setup, run, and verification had nowhere to be read: the activity stream carried milestones, the evidence panel carried a bounded result, and the full log existed only until the process ended.
**Decision.** (1) A run command may declare a readiness signal — `process`, an `http` health URL, or a `port` probe — with its own deadline and an explicit `stopOnFailure`. Until it answers the process is `starting` and the room says *Starting*; when it answers the process is `running`; when the deadline passes it is honestly `unreachable` and **keeps running**, because killing somebody's server over a wrong health URL is only Novus's decision to make when the project said so. (2) Preview URLs are validated at the contract boundary and again at the bridge: `http`/`https` only, a literal loopback hostname, no credentials in the authority, no whitespace or control characters, and — at the bridge — only an address a live process of that workstream actually reported. The URL is rebuilt from validated components and handed to the operating system's external-browser API; no shell command is involved. (3) The bottom dock becomes a **runtime dock** with four views: terminal sessions, setup, running, verification. It shows detailed local output for the machine that produced it and never travels to the control plane; the trace shows the milestone and the evidence panel shows the bounded result that supports a claim. A process that ended stays readable, with its exit code or its named termination reason.
**Alternatives.** Treating "the process started" as ready and letting people notice (rejected: it is the claim the product is built to not make); allowing any localhost prefix (rejected: an authority like `localhost@evil.example` is `evil.example`); resolving hostnames and allowing anything that lands on loopback (rejected: `localtest.me`, `nip.io`, and an attacker's own A record all resolve there, and resolution adds a second moment for the answer to change); streaming raw output to every participant (rejected: that is the unrestricted remote channel D-042 exists to not have).
**Consequences.** DESIGN.md's Terminal component becomes the runtime dock and gains its view switch; PRODUCT.md's *App running* overlay is now preceded by a genuine *Starting*. The wildcard bind address is refused as a preview host — it is where a server listens, not somewhere a browser goes, and the detector already rewrites it.
**Revisit when.** A project needs a readiness signal these three cannot express, or cloud workspaces make a preview something other than loopback.

## D-046 — The terminal renders through a maintained emulator

**Context.** The terminal drawer stripped escape sequences and printed the remainder as plain text, deliberately, to avoid a dependency. Audited against real PTY output it did not work at all: the backspace rule used an escape that means "word boundary" outside a character class rather than the backspace character inside one, so a fixpoint loop deleted the last character of every word — `hello world` rendered as a single newline. Underneath that, the approach could not have worked anyway: with no screen buffer and no cursor, an alternate screen never enters or leaves, a clear-screen does not clear, cursor addressing does nothing, and every repaint by `vim`, `less`, `top`, a pager, or a progress bar stacks instead of replacing. Colour was removed by design. The hand-written key map missed application cursor mode, function keys, modified arrows, and bracketed paste, so a multi-line paste auto-executed.
**Decision.** Render with `@xterm/xterm` and `@xterm/addon-fit` — the maintained emulator, not the older `xterm` package, which its own registry entry marks deprecated. It owns parsing, the screen buffer, the cursor, selection, and key encoding; Novus keeps the PTY, the environment, the process tree, and the authority rule. A **terminal palette** joins the token system: sixteen ANSI colours plus cursor and selection, muted and warm, defined in DESIGN.md and read into the emulator's theme from CSS custom properties so no literal colour appears in component source. This is the one place hues appear outside their semantic tokens, and the reason is stated: these are a foreign program's colours, not Novus saying anything about status.
**Alternatives.** Fixing the backspace rule and keeping the custom renderer (rejected: it makes the pane show text and still cannot run the programs people run); calling the feature a log viewer and renaming it (rejected: DESIGN.md and D-042 both contract an interactive terminal, and a workspace people cannot work in is the gap this slice exists to close); shipping the emulator's own default palette (rejected: a stock sixteen-colour scheme is exactly the neon the product's visual system refuses).
**Consequences.** Two runtime dependencies and one vendored stylesheet, whose own background is overridden from tokens so the pane sits on the product's surface. The custom text renderer and key map are deleted with the faults they carried. DESIGN.md#tokens gains the terminal palette; the theme moves with the rest of the product because it is read from the same variables.
**Revisit when.** The emulator stops being maintained, or a packaged build shows the addon needs different handling than the development one.

## D-047 — Contrast comes from a near-black ground; status is words; the dock stops saying "Verification"

**Context.** Four things were wrong on the rendered screens, and only looking at them showed it. The application background was graphite (`#141517`), so every surface above it — cards, dock, panel — sat in the same narrow band and nothing rose from anything; the product read flat rather than calm. Status dots were scattered across almost thirty places, each a small coloured circle carrying less than the text beside it and reliably the first thing the eye landed on, on a screen whose subject is a mission. The baton — a filled near-white squircle beside a name — was the loudest mark in the window and said nothing the sentence next to it ("You have the baton") did not already say. And the runtime dock used the word **Verification** for a raw local log while the evidence panel used it for the durable attributed record, so one word meant a claim in one place and a file in another.

**Decision.** (1) The dark ground drops to near-black (`--bg #08080A`), surfaces step up from it (`#131316`, `#1D1D21`), text brightens (`--text-1 #F7F5F2`), and edges and interaction states strengthen — a background that is already grey has nowhere to lift from. (2) Status is **text**, not a dot beside text: the `StatusDot` primitive and its rules are removed, and DESIGN.md's status rule becomes "status is stated in words, and never by colour alone" — which is the accessibility obligation the dot was there to satisfy in the first place. (3) The baton is removed as a mark. Control is named where it matters, in the words that were always there. (4) The dock's views become **Terminal · Setup · App · Checks**; only the evidence panel says Verification. (5) A terminal tab is a glyph, a name, and a close — the kind and the running state were words nobody reads twice, on the row with the least room. Showing the dock opens a session, because showing the terminal *is* the request and a pane offering a button that opens a terminal is a door in front of a door.

**Alternatives.** Keeping the dots and toning them down (rejected: the objection was that they exist, and a quieter version of a thing that carries no information is still a thing that carries no information); keeping the baton and shrinking it (rejected for the same reason — the sentence is the signal); renaming the *panel's* section instead of the dock's (rejected: "Verification" is the product's word for attributed evidence and belongs to the ledger, per PRODUCT.md's VerificationCheck); leaving the background and raising only text (rejected: contrast is a relationship, and lifting one side of it just makes text glare).

**Consequences.** DESIGN.md loses `StatusDot` from its primitive list and its status-semantics section is rewritten; signature element 1 (the baton) becomes a naming convention rather than a mark; the Terminal component becomes the runtime dock's Terminal view with the renamed siblings. The light theme's tokens move with the dark set. Screenshots taken before this entry show the old palette and are superseded.

**Revisit when.** A surface genuinely needs a non-textual status indicator — a dense list where words would not fit is the case to watch — or the light theme is proven on rendered screens and the contrast relationships have to be re-checked there.

## D-048 — The workspace's files are readable in the room, and a file takes the canvas

**Context.** A workstream has a real worktree on a real machine and the room could not show a single file in it. Changes showed a diff of what a turn touched; nothing showed what the project *is*. Reading a file meant leaving for an editor, which is the moment the mission stops being the thing you are in. The obvious answer — a file tree as the main event — is the one PRODUCT.md refuses by name: the window's subject is parallel agent work, never code files, and a permanent tree is how a mission room becomes a worse IDE.

**Decision.** Files live in the **evidence panel**, as its first section, beside the work rather than over it. Opening one **takes the room's canvas** for as long as the reader wants it, and closing it returns the trace exactly as it was; the composer stays, because reading a file is not a reason to stop being able to direct. Three local IPC verbs — list a directory, read a file, write a file — with no control-plane route and no runner command, exactly like the terminal: the worktree is on this machine and browsing it is an act by the person sitting at it. Every path is resolved against the worktree through `realpath` and refused if it leaves, because a symlink inside the worktree pointing at `~/.ssh` is an ordinary-looking relative path right up until it is followed. `.git` and `node_modules` are never listed. Reading is bounded to 1 MB and a non-text file says so rather than being rendered as mojibake. Writing only ever overwrites a file that is already there and already text — creating files and replacing binaries are things a harness does under direction with a checkpoint behind it, and an editor pane is not that.

Markdown gets **Preview** and **Edit**, because documentation is the file people most often open and most often want to fix one line of. Preview renders to React elements and **never builds a markup string from the file's content**: a README is repository content, anyone who can push can write it, a harness turn can write it with no human reading it first, and `dangerouslySetInnerHTML` would put attacker-authored markup in the one window that holds `window.novus`. The content-security policy does not help there — the bridge is same-origin script the page is allowed to run. Links render as text carrying their destination rather than as something that navigates. A file's type is shown by a small tinted extension badge; like the terminal's palette this is a *fact about a foreign thing*, not Novus saying anything, which is why it is the second and last place hues appear outside their semantic tokens.

**Alternatives.** A permanent file tree in a third pane (rejected: it is the generic-IDE shape, and it makes files compete with the mission for the window every second of every session); opening a file in a modal (rejected: a file is read at full measure, and a scrim says "finish with this before continuing" about something a person may want open for an hour); `marked` plus a sanitiser (rejected: it is two dependencies and a correctly-configured allowlist standing between repository content and the bridge, where rendering to elements needs none of that to be right); a syntax-highlighted editor (deferred: highlighting is a large dependency and a font-and-palette question of its own, and reading unhighlighted source is not the gap — not being able to open the file at all was); allowing file creation and deletion (rejected: that is directed work with a checkpoint behind it).

**Consequences.** DESIGN.md's evidence inspector gains an *All files* section and the room gains a canvas state that is not the trace; PRODUCT.md's non-goal "a full IDE" stands and is now load-bearing rather than theoretical — the line is that Novus shows the project's files and edits its prose, and does not become the place you write code. A markdown subset is a maintained surface: what it does not support renders as its own source text, which is honest and visibly incomplete rather than silently dropped.

**Revisit when.** Someone wants syntax highlighting badly enough to take the dependency, or a second editable file type turns up and the "markdown only" rule has to become something more general.

## D-049 — The dock is the terminal, one plane, and a tab is named from the repository

**Context.** Pressing the terminal control opened a dock whose first row was a four-way switch — Terminal, Setup, App, Checks — and, when nothing was open yet, a pane whose only content was a button reading *New terminal*. So the request "show me a terminal" landed on a page *about* terminals, two clicks from a shell. The dock also read as a window inside a window: its chrome sat on `--surface-1` while the screen sat on `--term-bg`, with the tab row inset by the room's own padding, so a short dock spent its height on margin and its colour on a seam. The other three views had somewhere to be all along — setup is a dialog two surfaces already open, the app is the `Run ▾` control with Stop and Open preview, and a check's attributed result is the evidence panel's ledger — while the terminal had only this. Tabs were called `shell`, `shell 2`, which says a person opened a second one and nothing else, and a Rename control existed to fix a name that never should have needed fixing.

**Decision.** The dock carries terminal sessions and nothing else. The switch is removed; showing the dock opens a session, focuses it, and shows the screen immediately. Chrome and screen are **one plane** on `--term-bg`, with the only edge between the dock and the room. A tab's name is **derived, never typed**: the repository's own short name — the last segment of `owner/name` or of a folder's path — and the tab's number, from one: `branchwork 1`, `branchwork 2`, `robinhood-agentic 1`. `+` makes the next number and selects and focuses it. All renaming UI is removed; the main process keeps its `rename` verb, unreferenced by the interface, because a name is data the interface no longer asks a person to maintain.

**Alternatives.** Keeping the switch and making Terminal its default (rejected: the default was already Terminal — the cost is the row, not the ordering, and a switch above a shell is a navigation on the one surface where the request cannot be misread); moving Setup and App into the dock as a second dock (rejected: two docks for one room); naming tabs after the shell or the worktree path (rejected: `zsh 2` says less than `shell 2`, and a path is a fact about a laptop, not a label three characters wide); keeping Rename for people who want their own names (deferred: a derived name that is right nine times out of ten is worth more than a control everyone has to think about, and nothing prevents restoring it if a real case turns up).

**Consequences.** DESIGN.md's *Runtime dock* becomes *The terminal dock*, and it names where setup, the app, and checks are invoked instead. The process-output view (`ProcessLogView`) and its bridge verbs are untouched and still capture and keep every process's output on the machine that ran it — but that view has **no mounted surface** until each kind is given its own, which is the open question this entry leaves behind and which PROGRESS.md records as such. `WorkspaceTarget` gains a `repositoryLabel`, derived in `main.ts` where the repository record is already read, and the terminal manager numbers from one under that label rather than from the session kind. Screenshots taken before this entry show the switch and the old two-plane dock.

**Revisit when.** Setup or app output is wanted on screen again and the surface for each is decided, or a project wants tabs named for what they are doing rather than where they are — at which point a derived name and an explicit one have to coexist, and the rename verb the main process still has is where that starts.

## D-050 — Process output is read in the evidence panel, which is where inspecting already happens

**Context.** D-049 made the dock the terminal and was right to: the request "show me a terminal" should land in a shell, not on a four-way switch above one. But removing the switch left `ProcessLogView` — the full local output of setup, the app, and checks — captured, bounded, redacted, retained after a process ends, and mounted nowhere. D-049 named that as the open question it was leaving behind, and PROGRESS.md recorded it as a gap rather than pretending otherwise. It is still a gap: a check that failed with four thousand characters of output, a setup command that died on line two hundred, and a dev server logging its startup are exactly the things a person needs to read, and "it is in the main process" is not a surface.

**Decision.** The output is read in the **evidence panel**, as an *Output* section beside All files, Overview, Changes, and Verification, with a three-way switch for setup, the app, and checks. The switch that was wrong above a terminal is right here, and the reason is what each surface is *for*: the dock exists to answer one unambiguous request, so anything in front of the shell is in the way; the panel exists to inspect — the runner and environment, the diff, the ledger, now the log — so a switch between kinds of inspection is the shape it already has. The section renders only where the workspace actually is, alongside All files, because both read the machine holding the checkout and a participant elsewhere would get a refusal rather than a pane (D-042).

This changes nothing about what travels. The log is local, exactly as D-045 set out: the trace shows the milestone, the ledger shows the bounded attributed result that supports a claim, and this shows the detailed output on the machine that produced it, which never reaches the control plane.

**Alternatives.** Putting each kind on the surface that invokes it — setup output in the setup dialog, app output in the `Run ▾` menu, check output in the ledger row (rejected: the dialog is bounded and closes, the Run menu is a popover and a build log is not a menu item, and the ledger's reveal is the *reported* four-kilobyte extract rather than the full local one; three different homes for one thing also means three places to look and three to maintain); a fourth dock (rejected by D-049 already — two docks for one room); leaving it unmounted and calling the capture sufficient (rejected: that is the state this entry exists to end, and a capture nobody can read is dead code with a comment on it).

**Consequences.** `InspectorSection` gains `output`; the panel takes a `hostedHere` flag, which also correctly hides *All files* from a participant whose machine does not hold the checkout — a refusal that was previously only discovered by clicking. DESIGN.md's inspector section list and its terminal-dock entry both say where output is read. The E2E asserts it on screen rather than at the bridge, which is what D-049's own test had to fall back to while the surface was missing.

**Revisit when.** A fourth kind of process appears, or the panel's section list grows past what a single row can carry — at which point the question is the panel's information architecture rather than this section's existence.

## D-051 — Two verbs that were written and never called

**Context.** Two faults reached a real session on 2026-08-03, and they are the same fault twice.

The first: every direction submitted after the first half-hour of a mission sat at *"Waiting — no one holds the baton"* and never ran. `sweepLeases` expires a lease whose holder has been silent past its time to live, and `touchLease` renews that silence clock — and `touchLease` had **no caller anywhere in the codebase**. So the heartbeat never beat. Every lease expired thirty minutes after it was created, however present its holder was, and the room then correctly reported that nobody held control and correctly queued direction behind a controller who no longer existed. `reliability.test.ts` proved the sweep, which was true; nothing proved that anything renewed a heartbeat, which was the half that mattered. PROGRESS.md called the row **Implemented** on the strength of the tested half.

The second: opening a terminal, reading a file, or running a command in the *second* mission on a GitHub repository failed with `fatal: invalid reference: novus/m-…`. The runner decided whether to fetch by asking `isClonePresent` — whether this machine held the **repository** — when the question a worktree actually asks is whether it holds **this workstream's branch**. The first mission cloned; every mission after it was skipped, so its branch was never fetched and `git worktree add` had nothing to point at. `workspace-clone.test.ts` already covered *"fetches a branch the server allocated after this machine cloned"* — the clone module was right the whole time. Nothing called it.

**Decision.** The lease's heartbeat is renewed where the holder's client is actually observed: reading the mission. The room polls that endpoint while it is open, so a controller who is watching keeps their lease and one whose machine is closed stops keeping it, which is what ARCHITECTURE.md always said the TTL was the grace period *after*. Only the holder's own read counts — a second participant with the room open must not keep somebody else's lease alive, or a TTL would never expire in any room with two people in it. The write is skipped when the heartbeat is already less than a minute old, because a two-second poll against a thirty-minute TTL does not need the precision.

Whether to fetch is decided by asking git for the branch — `rev-parse --verify` against `refs/heads/{branch}` — rather than by the presence of a `.git` directory. The answer is remembered per mission for the life of the process, so it costs one `rev-parse` per mission per run rather than one every fifteen seconds forever.

**Alternatives.** A dedicated heartbeat endpoint the client calls on a timer (rejected: it is a second thing to keep alive that means exactly what the poll already means, and a client that stops polling has stopped watching); touching the lease on every authorized command instead (rejected: a controller who is reading rather than acting is still there, and this is the case the bug was actually about); fetching unconditionally on every discovery pass (rejected: a network round trip every fifteen seconds per mission to answer a question that changes once); checking for the ref file under `.git/refs` (rejected: refs pack, and a packed ref would read as absent).

**Consequences.** PROGRESS.md's runner-heartbeat row stops claiming Implemented on the strength of a sweep nothing fed, and says what is now true and what proves it. Both fixes get a test that fails without them: a lease backdated past its TTL that survives its holder's read and does not survive a bystander's, and an agent that fetches a second workstream's branch into a repository it had already cloned.

The lesson is worth keeping separately from either bug, because this is the third time this slice has hit it — `SecretStore.put` was the first, with no caller and a workspace permanently reporting itself blocked. **A verb with no caller is not a feature, and a test that calls it directly does not prove it is wired.** Where a unit test exercises a function the product must call, something has to prove the product calls it.

**Revisit when.** Presence exists as its own concept — the connection state PRODUCT.md describes is a better heartbeat than a poll, and this moves onto it — or the poll is replaced by the persistent connection D-021 chose.

## D-052 — One credential policy, and redaction reaching the transcript

**Context.** Two protections against a credential leaving the machine already existed and neither covered the surfaces that had grown since it was written.

The first is a **path** policy — `isSecretPath`, a list of patterns naming files that hold credentials. It was written for checkpoints, where its job is to keep an agent's `.env` out of a commit, and at the time a checkpoint was the only way a file's contents could leave. Then the file browser landed (D-048): it lists the worktree, reads a file into a pane, offers a button that copies it to the system clipboard, and writes one back. None of those three asked the policy. Every credential file in a worktree was listable, readable, and overwritable — including through a direct bridge call, and including the `.env` that Novus itself had copied in at mode 0600 for the project to use (D-041). Two features that were each correct composed into the disclosure D-041 exists to prevent. The list also had holes independent of the browser: `.pypirc`, `*.key`, `*.pfx`, `.git-credentials`, and service-account JSON were absent, so checkpoints were sweeping them in.

The second is a **value** policy — `redact`, which removes values this machine holds from text about to be reported. Process output has passed through it since D-044. The harness transcript never did: it was path-masked only, so a turn that ran `env`, quoted a config file it had just read, or printed a failing request put the value into a durable event, distributed to every participant, projected into receipts, and written to the operational log. The transcript is the surface that talks the most and it had the weakest protection. Separately, `HTTP_PROXY` and its siblings are forwarded to all three environments because a managed machine cannot reach the network otherwise, and such a URL conventionally carries `user:password@` — a value nobody supplied, that the redactor therefore never held.

**Decision.** One path policy, in `secret-paths.ts`, asked by checkpoints, evidence, and all three file verbs. Templates — `.env.example` and its spellings — are exempt by name, because a repository commits one so that people can read it. Enforcement is in the main process at the single chokepoint every route already passes through, so a renderer that asks for a protected path directly is refused rather than merely not offered it; a protected file is absent from the listing, because a filename is itself a disclosure about a project.

Value redaction moves up to cover the transcript: paths are masked, then held values are removed, in one function every emit already called. The values are read per emit from the machine's store through a function that returns strings and never the store, so the turn path can *remove* a secret without gaining a way to put one anywhere. Proxy passwords are harvested from the forwarded variables and folded into the same set — forwarded whole, since stripping the credential breaks the proxy, and never reported. Host, port, and username are left alone: an error naming which proxy refused is worth keeping.

**Alternatives.** Listing protected files and refusing only to open them (rejected: the name is disclosure, and the panel's job is to be a way to read the worktree, not a catalogue of what it will not show); a second list inside the file browser (rejected outright — two lists drift, and the drift is silent and toward disclosure); content inspection to decide sensitivity (rejected: it requires reading the file to decide whether it may be read, and entropy heuristics fire on minified source and lock files); stripping credentials out of forwarded proxy URLs (rejected: the proxy then refuses and the machine has no network); a wall between the harness and any worktree file (rejected: the agent must work in the worktree, and the project's own `.env` is why it works).

**Consequences.** Six file classes newly withheld from checkpoints, which is a live fix and not only a browser one. Two defects found by audit and fixed alongside: `writeWorkspaceFile` gated its "text only" check behind its size check, so a binary too large to *show* was small enough to truncate to nothing; and `.git`, skipped when listing, was readable as a file in a linked worktree, where its one line is the absolute path of the repository. File-verb errors now pass through the path sanitizer like every other reported string.

**The exact limit, which is not a detail.** Both halves are lists, and neither is detection.

The path policy recognises conventional *names*. A credential in `notes.txt` is invisible to it, and a template filled in with real values is exempted by name with its contents never read. Value redaction removes literal occurrences of values Novus was explicitly given, at least `MIN_SECRET_LENGTH` characters long. It therefore cannot remove a secret Novus was never handed — one inside a supplied `.env` *file* rather than supplied as a value, one a project prints, one an agent mints mid-turn — nor an encoded, quoted, escaped, or line-wrapped form of a value it does hold, nor one split across two delivery chunks. **Novus does not detect arbitrary secrets and no part of this claims to.** The protections that carry the weight are the ones that keep credentials out of the reported path entirely: three constructed environments (D-041), checkpoint withholding, and now the file policy.

**Revisit when.** A secret is supplied as a file rather than a value often enough that its *contents* should seed the redactor at preparation time; or the harness gains a way to declare what it is about to print, making redaction a boundary rather than a filter.

## D-053 — Stop reaches the harness, and a terminal execution stops changing

*Written 2026-08-04, after the change it describes shipped. The slice was committed citing this number and the entry itself was never appended; six files referenced a decision nobody could read. Reconstructed from that commit and its tests rather than re-litigated.*

**Context.** `stop_execution` never interrupted anything. The runner agent chains commands per workstream so one turn runs at a time, and only `stop_command` bypassed that chain — so a stop queued behind the very turn it was meant to interrupt. Worse than late: the chain resolves only *after* the turn has been removed from the active set, so when the stop finally ran there was nothing left to stop. It acknowledged successfully, and the room went on saying *Running* with a live Stop button until the turn finished on its own and reported *Completed*. Nothing failed loudly because, as far as every component could tell, nothing had failed.

Separately, execution *state* was already monotonic — `setExecutionState` refuses to move a terminal execution — but the transcript, the harness session pointer, and checkpoints did not go through it. A stopped execution could go on talking, could overwrite the workstream's resume point with the session it had just been killed in, and could commit a checkpoint after the participant had stopped it.

**Decision.** `stop_execution` bypasses the per-workstream chain exactly as `stop_command` always has. Three things become necessary only once the stop can actually arrive:

- It is **matched to the execution it names**, so a stale stop re-offered after a relaunch cannot kill whichever turn is running now.
- It is **remembered** in a per-execution set consulted before a turn spawns, so a stop that lands before its turn exists prevents the turn instead of being swallowed while the harness runs anyway.
- A stopped execution's **queued direction is discarded with it**, rather than starting a second harness process in the same worktree after the participant asked for it to end.

A terminal execution accepts no further projection at all: the event is still recorded, because the log is the honest record, but it no longer changes anything the room reads.

The room gains `agent_stopping`, a transient state like `agent_starting`, so it does not go on saying *Running* — and offering a Stop that has already been pressed — while the interrupt is in flight.

**Alternatives.** A universal turn deadline (rejected outright: D-034 says execution lifetime is not Novus's to cap); making the stop take over the chain rather than bypass it (rejected: whatever was already queued would lose its place); polling for a stop flag inside the turn loop (rejected: it only helps between lines, and a turn blocked in a tool call is exactly the case that matters).

**Consequences.** Graceful-then-forced termination of the harness process *group*, so the agent's own child tools die with it; terminals and project processes are untouched, because a dev server a participant started is not part of the turn. Stop is refused server-side for a role without `execution.stop`, with no state change and no command enqueued. Two of the five tests added for this fail against the previous code — verified by restoring the bug and watching them go red.

**Revisit when.** The harness offers an in-band interrupt. D-056 has since found that it does: Claude Code's control protocol carries `{"subtype":"interrupt","cancel_queued":true}`, which would stop a turn without destroying the resumable session. The process-group kill should become the fallback rather than the mechanism.

## D-054 — No unused-export gate; production-path tests instead

**Context.** Three faults reached real sessions and all three were the same shape: a verb that existed, was correct, was tested, and was never called. `SecretStore.put` — a workspace permanently reporting itself blocked. `touchLease` — every lease expiring thirty minutes after it was created, so every direction after that queued behind a controller who no longer existed. The mission-branch fetch — every mission after the first failing to open a terminal or read a file. D-051 recorded the lesson and left the question of a gate open. This answers it.

A detector was built and measured rather than argued about. It reads every `export function` / `export const … = (`, counts callers outside the declaration, and reports the ones with none. Two variants were run against `865496b`, the commit where `touchLease` had no caller, and against HEAD.

**What it actually catches.** Of the three historical faults, **one**.

- `touchLease` — caught by the broad variant, and only that one. At `865496b` it had **zero** references anywhere: no production caller *and no test*. The narrower "tested but never called in production" variant therefore misses it entirely, which is worth stating because that variant sounds like the more precise tool and is in this case the more useless one.
- `SecretStore.put` — invisible. It is an interface method, not an exported function; no export-shaped scan sees it.
- The mission-branch fetch — invisible, and not an orphan at all. `isClonePresent` was called on every pass. The bug was that it answered the wrong question — whether this machine held the *repository*, when a worktree needs to know whether it holds *this workstream's branch*. There is no static shape that distinguishes a correct guard from a wrong one.

**What it costs.** The broad variant reported **10** candidates at `865496b` and **9** at HEAD. One is a genuine wiring bug; the rest are ordinary dead code, and one — `osCrypto` — is a false positive of the scan itself, used as a default parameter value on a line the scan skips because that line begins with `export`. A gate that fails the build on this list fails it nine times out of ten for something that is not the fault it was built to catch, and the cost of a gate that cries wolf is not the noise, it is that the tenth case gets waved through with the rest.

**Decision.** No unused-export gate. Each critical side-effecting verb gets at least one test that enters through the boundary the product enters through — the runner agent, the bridge, the HTTP route — rather than by importing the function and calling it. That is the check that would have caught all three: a test that drives the real agent finds a heartbeat that never beats, a fetch that never happens, and a store that is never written, because in each case the *observable* outcome is wrong even though every unit is right.

The detector is kept in the scratchpad as a diagnostic to run deliberately, not as a gate. It found one real orphan at HEAD — `uncommittedChanges`, the record of what changed when a checkpoint could not commit, which had tests, had no caller, and meant the room was told "nothing changed" about a turn that had changed things and could not save them. It is now called from both commit-failure paths and withholds credential files exactly as a successful checkpoint does (D-052). Seven genuinely dead exports were removed rather than left to dilute the next reading.

**Alternatives.** `ts-prune` or `knip` (rejected for the same reason as the hand-rolled version, with the added cost of a dependency and its configuration; the measurement above is a property of the *question*, not of the implementation); failing only on a hand-maintained list of critical verbs (rejected: the list is the thing that goes stale, and a verb absent from it is exactly the verb nobody thought about); a coverage threshold on the agent and route modules (rejected: coverage counts lines a test *reaches*, and every one of these three faults had full coverage of the unreachable-in-production function).

**Consequences.** PROGRESS.md carries a critical-verb table naming, for each verb, the test that enters through production. A verb added to that list without such a test is a review failure, enforced by reading rather than by a script — stated plainly, because a rule a human enforces should not be dressed up as one a machine does.

**Revisit when.** A fourth fault of this shape lands and the broad variant would have caught it, making the ratio two of four rather than one of three; or the codebase grows a dependency-injection seam that makes "is this wired" a type error instead of a runtime absence.

## D-055 — Missions belong to the rail; the room is one mission

**Context.** Two surfaces rendered the same list. The projects rail disclosed a project's missions as rows; the room drew a tab row across the top from the same array. Same order, same truncated labels, both writing the same selection — so every mission was on screen twice, and the tab row carried none of what made the rail useful (the count, the attention lens, reach across projects). Selecting a project always discloses it, so both were always visible together.

Worse than the duplication was the naming. Every one of those tabs was a **Mission** and every control around them said *workstream*: the row's label, its `aria-label`, the `+` button's tooltip, the draft tab, the empty states, the sentence under a new room. A workstream is a different thing — a mission contains exactly one in V0, and nothing in the interface can create a second — so the word that named the room's most prominent control named nothing the reader could act on. DESIGN.md#component-behavior had said since the beginning that one workstream means no workstream chrome at all; the code drew that chrome in exactly the case the document forbade it.

**Decision.** Missions are the rail's, and only the rail's. A project row discloses its missions and ends with **New mission**, which is where creating one belongs: a row in the list it joins, in the place that already reads *this project, and its missions*. `⌘T` is the same act and is now written down.

The strip across the top of the room is for **files** (D-048). With none open there is no strip, so a single mission has no chrome above it. Open one and the room takes the first tab — the way back to itself, which is what the mission tabs had been doing incidentally and what nothing else did.

Everything that named a mission a workstream now names it a mission, in labels, tooltips, empty states, test ids, and comments. `Workstream` continues to mean the workstream: every value of that type was always correctly named, and the fault was one-directional — labels applied to mission variables.

**Alternatives.** Keeping a one-tab row for the single-mission case (rejected: DESIGN.md#component-behavior forbids it in as many words, and a tab row with one tab is a control that cannot be used for anything); moving mission creation to a floating `+` in the rail header (rejected: it would create into whichever project happened to be selected, which is a guess the row does not have to make); leaving the tabs and removing the rail's list (rejected: the rail carries the count, the attention lens, and every other project, and the room by construction cannot); renaming the tabs to *Mission* and keeping both (rejected: it fixes the word and leaves the duplication, and the duplication is the part that costs a reader something).

**Consequences.** `ws-tab` becomes `mission-row`, `new-tab` becomes `new-mission`; `draft-tab` had no test and no purpose once the strip is file-only, and is gone. Five end-to-end assertions move from the tab row to the rail, which is where they should have been — the relaunch-reconstruction test in particular was proving that a *tab* came back when what it cared about was the mission. A new test covers two missions in one project: listed once, independently selectable, no strip in the centre, and no occurrence of the word *workstream* anywhere in the room.

Not built, and deliberately: multiple workstreams inside a mission, the lane headers DESIGN.md specifies for that case, the Decision Room, and approach comparison. This slice makes one mission read correctly; it does not add a second workstream.

**Revisit when.** A mission can actually hold more than one workstream, at which point the lane headers in DESIGN.md#component-behavior become real and this decision is what says they are lanes *within* the room rather than tabs above it.

## D-056 — Approval routing is possible with the installed Claude Code, over stdio

**Context.** `needs_approval` has existed in the execution and mission state models since the beginning, in PRODUCT.md, in DESIGN.md, and in the renderer's own state copy. Nothing has ever entered it. Novus runs Claude Code with `--permission-mode acceptEdits`, so the harness never asks — which makes every claim about supervised autonomy in this product currently false, and made it the largest honesty gap in the harness boundary.

Whether it *could* ask was an open question, and one that documentation cannot settle. So it was probed against the installed binary — `claude 2.1.221`, `/Users/kj16/.local/bin/claude` — in a throwaway git repository, four short runs, with `--dangerously-skip-permissions` never used.

**What was observed, verbatim.**

*Today's flags ask nobody.* Under `acceptEdits` no permission is ever requested. Under the plain default mode the request is not surfaced either — it is **auto-denied**, and appears only after the fact: the tool result comes back `"Claude requested permissions to write to …, but you haven't granted it yet."` with `"non_execution_kind":"user-rejected"`, and the final `result` event carries `permission_denials: [{tool_name, tool_use_id, tool_input}]`. The file was not written and the session did not pause. There is no `permission_request` event kind in the stream.

*`--permission-prompt-tool` exists but is undocumented.* It is absent from `--help`; invoking it bare returns `error: option '--permission-prompt-tool <tool>' argument missing`. Pointed at an MCP tool it works end to end: the server received `{"method":"tools/call","params":{"name":"approve","arguments":{"tool_name":"Write","input":{…},"tool_use_id":"toolu_…"}}}`, replied `{"behavior":"allow","updatedInput":{…}}`, and **the file was created**, with `permission_denials: []`. The CLI blocks on that call — which is the pause Novus needs. One trap: a name that is not an MCP tool does **not** fail at startup; validation is lazy, so a misconfiguration surfaces mid-turn at the first permission request.

*The stdio control protocol is better, and needs no MCP server.* With `--input-format stream-json --output-format stream-json --permission-prompt-tool stdio`, the CLI wrote to **stdout**:

    {"type":"control_request","request_id":"21740bb3-…","request":{"subtype":"can_use_tool",
     "tool_name":"Write","display_name":"Write","input":{…},"description":"PROBE.md",
     "permission_suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}],
     "tool_use_id":"toolu_…"}}

and blocked until this was written to **stdin**:

    {"type":"control_response","response":{"subtype":"success","request_id":"21740bb3-…",
     "response":{"behavior":"allow","updatedInput":{…}}}}

The file was created, `permission_denials` was empty, the run ended `result/success`, and the transcript persisted at `~/.claude/projects/…/<session>.jsonl` — so `--resume` is unaffected and sessions stay resumable exactly as `execution.ts` already relies on. The request carries typed tool name and input, which is what an approval card needs to say what is being asked.

**Decision.** Approval routing is **feasible and will be built on the stdio control protocol**, not on an MCP permission-prompt tool. Both are proven; stdio wins because it needs no second process, and because the same channel carries `{"subtype":"interrupt","cancel_queued":true}` — an interrupt that stops a turn without killing the process or losing the session, which is strictly better than the SIGTERM of the process group D-053 currently uses for Stop.

**Not built.** Nothing of this is implemented. `needs_approval` is still never entered and the flags are unchanged. This entry records a probe, not a capability, and PROGRESS.md must keep saying so.

**One thing that will bite, recorded now.** In the MCP probe the model also ran `Bash: ls` and it never reached the permission tool — the operator's own `~/.claude/settings.json` allowed it. `harnessEnv` forwards `HOME` and every `CLAUDE_*` variable so the person's local login works, which also means their settings govern Novus turns. **Which tool calls reach an approval router therefore depends on whose laptop it is.** If approval routing is to be a product guarantee rather than a default, the slice that builds it must pin the setting sources and the permission mode explicitly instead of inheriting them.

**Alternatives.** An MCP permission-prompt tool (proven, kept as the fallback if driving stdin conflicts with something; costs a second process and gains no interrupt); polling `permission_denials` after the fact (rejected: the work has already been refused by then, so it is a report and not an approval); asking the model to request permission in prose (rejected: unenforceable, and an approval the harness can route around is not an approval).

**Revisit when.** The slice is built — at which point this entry becomes the record of why stdio, and the interrupt finding should be reconsidered against D-053's process-group kill.

## D-057 — A check is run again from the row that failed

**Context.** A failed check was a dead end. The ledger recorded that `failing` exited 1 against a particular revision and offered nothing to do about it: the only way to run a check again was `Run ▾`, which is a menu of what the *project* declared rather than of what has already been tried, and *Run verification*, which runs every check and buries the one being asked about. A person who has just fixed the thing a check caught had no way to ask that check.

Stale results have the same shape and are more common. A check that passed against an earlier revision dims and says what it proved (D-045), which is honest and also terminal: the row states that the answer is out of date and provides no way to get a current one.

**Decision.** The ledger row carries **Run again**, and only where there is a question left to re-answer — a check that failed, errored, or proved a revision the worktree has moved past. A row that passed and still proves the current revision offers nothing, because nothing is being asked.

It is the same declared command it was the first time, invoked by name through the same route, authorized by the server against `workspace.command`, and run against the snapshot the control plane pinned when it authorized it (D-043). Nothing about re-running is a second mechanism: the only new thing is the affordance.

Every run produces a **new record**. The failure that prompted it stays in the ledger with its own attribution, its own revision, its own exit code, and its own output — a ledger that overwrote a failure with a later pass could not answer "did this ever fail", which is the question a verification record exists to answer. One run at a time per check, so a second click while one is in flight does nothing rather than queueing a duplicate.

**Alternatives.** Re-running every check from the row (rejected: the reader asked about one, and the tally already offers *Run verification* for all of them); replacing the failed row with its newer result (rejected outright, for the reason above); a *Retry* on the mission state line (rejected: the state line names the mission's next step, and one check among several is not it); offering Run again on every row including passing ones (rejected: an action that is always available stops meaning anything, and re-running a green current check answers a question nobody asked).

**Consequences.** Remote participants get the same control, subject to the same server-side capability, and read the same bounded evidence; the full local output stays on the machine that produced it, under Evidence → Output (D-050). Proven in the app: a failed check is run again from its own row, a second record appears with its own attribution and revision, and both remain on screen.

**Revisit when.** CI results are ingested as a second attributed source, at which point a row may have an origin that Novus cannot re-run, and the control has to say so rather than be absent.

## D-058 — One worktree preparation per mission at a time

**Context.** `workspace-clone.test.ts` had failed intermittently for two sessions and survived both because nothing ever captured its output: the repository gate ran every step into `/dev/null`, so a failure named the command and nothing else, and the only way to see more was to run the suite outside the gate — unloaded, after nothing else — which is exactly the condition it does not fail under. That gate defect was fixed first; this is what the output then said.

Reproduced one run in three with three other agents loading the machine:

```
fatal: cannot change to '.../worktrees/msn_second00000000000': No such file or directory
```

Not `invalid reference`, so not D-051 returning. The directory had been created and then removed while its creator was still using it.

`ensureWorkspaceWorktree` read "is it already there", and if not, **deleted whatever was there** and ran `git worktree add`. Two callers ask for the same worktree routinely and by design — the runner's turn path, and whatever the person at the machine just did: open a terminal, list files, run setup, all of which resolve a worktree first. Unserialised they interleave destructively:

1. Caller 1 runs `git worktree add`; it succeeds; it returns the path.
2. Caller 2, which read `.git` before that add was visible, sees no worktree.
3. Caller 2 deletes the directory caller 1 has just created and returned.
4. Caller 1's next git command fails, or caller 2's own `worktree add` fails on a path git still believes is registered.

The user-visible form of step 4 is the error string this codebase already had: **"This workspace could not be created"**, which is what a person sees when they direct a mission and open its terminal a moment later. It was reported from a real session and read as a GitHub problem, because the mission that showed it happened to be a GitHub one.

**Decision.** Preparation is serialised per worktree path, in this process, with the promise-chain pattern the runner agent already uses for per-workstream commands. Keyed by the path rather than the mission id, because the same mission under a different user-data directory is a different worktree and must not queue behind this one. The destructive `rmSync` stays — a directory with no `.git` is debris from a preparation that did not finish, and `git worktree add` refuses a path that exists — but it is now only reachable while holding the lane, which is what makes it safe.

**Alternatives.** A lock file on disk (rejected: it must survive a crash, so it needs an expiry, and an expiry is a second race; the contention is between callers in one process); making the second caller wait for the first by polling for `.git` (rejected: a preparation that legitimately fails would make every other caller wait out a timeout); dropping the `rmSync` and letting `git worktree add` fail on debris (rejected: it converts a recoverable state into a permanently broken workspace).

**Consequences.** The intermittent failure is a bug that was always in the product and only ever showed up in a test that happened to run two callers at once. The test that now covers it asks six callers for one worktree simultaneously and requires that they all get the same real worktree on the right branch. Proven by seeding the failure: with serialisation bypassed the test fails with "This workspace could not be created"; with it restored the file passed four consecutive runs, having failed one in three before.

**Revisit when.** More than one Novus process can share a user-data directory, at which point in-process serialisation is no longer sufficient and the lock has to become one the operating system arbitrates.

## D-059 — A cited decision must exist

**Context.** D-053 was cited by six files — two canonical documents, three source files and a test — for an entire session before anyone noticed it had never been written. The slice it named shipped; the entry did not. `runner.ts` cited D-038, which has never existed either. Nothing caught either one, because nothing looked: the repository gate checks frontmatter, links, anchors, banned language, gradients, raw colours and untracked files, and had no opinion about whether a decision reference resolves to anything.

This matters more here than it would elsewhere. The whole working contract in AGENTS.md rests on decisions being the place a reader goes to find out why something is the way it is, and a dangling `(D-0NN)` in a comment is worse than no comment — it tells a reader that the reasoning exists and has been recorded, and sends them to look for it.

**Decision.** The gate fails when any `D-NNN` appearing in the canonical documents, `apps/`, `packages/` or `scripts/` has no `## D-NNN ` heading in DECISIONS.md.

Deliberately the narrowest check that catches the failure. It does **not** police numbering, ordering, or gaps: D-038 has never existed and never will, and a sequence with a hole in it is not a defect. It asks one question — does this reference resolve — which is the same question the existing link and anchor checks ask about Markdown.

D-054 rejected a broad unused-export gate because it caught one of three historical failures and produced nine false positives. This one is the opposite shape and is worth having for exactly that reason: it caught two real dangling references the moment it was written, has no false positives by construction, and its scope is one line of grep.

**Alternatives.** A lint rule over comments only (rejected: PROGRESS.md and DESIGN.md cite decisions too, and those citations are the ones a reader is most likely to follow); requiring the sequence to be contiguous (rejected: it would demand inventing a D-038 that never happened, which is the failure this exists to prevent, in a more expensive form); doing nothing and relying on review (rejected: review is what missed it, six times, in six files).

**Consequences.** Two dangling references are repaired in the same change: D-053 is written from the commit and tests that shipped it, and `runner.ts`'s citation of a decision that never existed is removed, because none covers what it claimed — the sentence states its own reason instead. PROGRESS.md's decision-record row stops naming a range that was already stale.

**Revisit when.** Decisions are ever split across more than one file, at which case the check needs to look in all of them.

## D-060 — A mission whose branch is not on this machine is not announced

**Context.** `fatal: invalid reference: novus/m-…` was reported from a real session and attributed to D-051, which had fixed a different cause of the same message: the runner decided whether to fetch by asking whether this machine held the *repository*, when the question a worktree asks is whether it holds *this workstream's branch*. That fix was correct and this is not a regression of it. There is a second path to the same message, still live, and it is the one a fresh mission can still take.

The runner's discovery pass fetches what it needs and then announces what the project declares. Announcing is not a read — publishing creates the worktree, because it must read the project's files to know what it declares. So `git worktree add -- <worktree> <branch>` runs against a repository that may not have the branch.

`ensureCheckout` fails loudly the first time: it throws, and the pass ends before announcing. Then it records a retry time and, on **every** subsequent pass inside that backoff window, **returns silently**. Discovery fell straight through to the announce with no branch on the machine. The backoff runs 15 s → 30 s → 60 s, capped at five minutes, while discovery runs every fifteen seconds — so one transient fetch failure produced a stream of `invalid reference` for minutes. Any ordinary cause will do: an expired installation token, a rate limit, a branch the provider has not propagated yet, a laptop that slept.

`announceCommands` swallows what publishing throws and warns once per distinct reason, so this never became an event, never reached the room, and never failed a test. What a person saw was a mission that would not build a workspace, with the same words D-051 had already been blamed for.

**Decision.** Discovery announces nothing for a mission whose branch this machine does not have. The runner already tracks exactly that — it re-checks after fetching and records the mission as fetched only if the branch actually arrived — so the guard is that record, consulted one line before the announce.

**Alternatives.** Making `ensureCheckout` throw during backoff instead of returning (rejected: the backoff exists so a failing fetch does not abort discovery for every *other* mission on the machine, and throwing restores that); announcing anyway and swallowing the error more quietly (rejected: it is the same silence that hid this, and the worktree attempt is real work against a real repository); retrying the fetch immediately rather than backing off (rejected: a rate limit is precisely the case where that is wrong).

**Consequences.** A mission whose branch cannot be fetched now waits, silently and correctly, until it can be — which is what the backoff was always for. Proven by seeding the failure: with the guard bypassed the test observes `could not read this project's configuration: This workspace could not be created: fatal: invalid reference: novus/m-later003` on the second discovery pass, and with it restored there is nothing. The test needed two passes to reproduce, because the first one throws and never reaches the announce — which is why a single-pass test, and a session of manual checking, both missed it.

**Revisit when.** Discovery gains per-mission error state the room can see, at which point "this machine cannot fetch your branch" should be a state a participant reads rather than a silence.

## D-061 — A window-level working set of open missions, which is not the rail

**Extends D-055; does not revert it.** D-055 removed a tab row from inside the room because it drew `project.missions` — every mission of one project, in the same order and with the same labels as the rail beside it. That row was a second copy of a list that already existed, and removing it was right. This adds something the rail cannot be.

**Context.** With missions living only in the rail, a person working across two of them navigated by hunting: open the project, find the row, click; then hunt back. Nothing on screen said *which rooms am I in* — only *which rooms exist*. Those are different questions, and the second one has a different answer for every person and every hour. A mission from one project and a mission from another could not be held side by side at all, because the rail is organised by project and selection was a single value.

**Decision.** A window-level strip above both the rail and the room carries the **working set**: the missions this person currently has open. The rail remains the canonical list of every mission, once, next to the project that owns it — a project with nine missions and none open puts nothing in the strip, which is the property that makes this not a second list.

Opening from the rail opens a tab or selects the one that mission already has; a mission is open at most once. Missions from different projects sit in the strip together, and a tab names its project only when more than one is open — with everything from one project the rail already says so, and repeating it on every tab is the duplication D-055 objected to.

**Closing a tab closes a tab.** It does not stop an execution, discard a change, archive a mission, or forget history. A harness that was working goes on working, and the rail goes on reporting it — which is why the shell now re-reads the mission list on a timer instead of once at mount, since the attention lens was previously frozen for any mission nobody had selected.

**Restoration.** The open missions and the selected one come back after a relaunch. Drafts do not: a draft is unsent local text with no mission behind it, and restoring one would put an empty room back on screen that nobody asked for. Every restored mission is checked with the server before anything opens, and one that is gone — deleted, or no longer visible to this person — is dropped from local state quietly. `offline` is explicitly not "gone": dropping tabs on a network failure would empty someone's working set the moment their connection went.

**Creation, in the two places a person looks.** A repository row reveals `+` on hover *and* on keyboard focus, labelled `New mission in {repository}`, and it does not select or collapse the row it sits on. The strip ends with `+`, which opens a draft in the current repository or the project chooser when there is none. `⌘T` is the same act. A draft is local until its first direction creates the mission, and `+` pressed twice in one repository is the same draft twice rather than two rooms nobody can tell apart.

**Mission tabs and file tabs are different levels and look it.** Mission tabs are the window's, above everything. File tabs (D-048) are the room's, inside the selected mission, and appear only while a file is open — there is never an empty file strip. Each mission keeps its own open files and canvas, restored on return. Closing a mission tab discards that local view state, which is stated in the code and tested: the files are still on disk and the panel still lists them, and the alternative is a store that only grows.

The room's own "way back" tab now reads **Mission** rather than repeating the goal. With the strip naming the mission above and the rail naming it to the left, a fourth copy answered no question; the only thing that control is for is *what do I return to*.

**Alternatives.** Restoring D-055's row (rejected: it is the duplication, and this is not); a single "recently viewed" list with no close (rejected: a working set you cannot curate is a history, and history is what the rail already is); persisting the working set on the server (rejected: which rooms are open on *this machine* is not a fact about the mission, and syncing it would make two laptops fight); keeping selection a single value and adding a back-stack (rejected: it answers "where was I" and never "what am I holding open").

**Consequences.** The strip is a new surface DESIGN.md#information-architecture now describes. `slice.spec.ts` names the mission it wants rather than relying on "the first mission is selected at launch", which restoration correctly changed. `working-set.ts` is pure, so the rules that matter — open at most once, closing does nothing else, a refused mission is dropped rather than fatal — are proven without a window.

**Revisit when.** A mission can hold more than one workstream, at which point a tab may need to say which lane it is in; or the strip grows past what one row can hold and needs an overflow menu rather than only scrolling.

## D-062 — Approval routing, and pinning the permission policy away from the machine

**Context.** `needs_approval` had existed in the state model, in PRODUCT.md, in DESIGN.md and in the renderer's own copy since the beginning, and was never entered. Claude Code ran under `--permission-mode acceptEdits`, so it never asked. Every claim this product made about supervised autonomy was false, and PROGRESS.md said so. D-056 established by probe that the CLI can be made to ask. This builds it.

**Decision — the wire.** Claude Code runs with `--input-format stream-json --output-format stream-json --permission-prompt-tool stdio`, stdin held open for the life of the turn. The CLI writes `control_request` / `can_use_tool` to stdout and blocks; Novus writes back a `control_response` naming the same `request_id`. The direction is no longer an argv element, because stdin is the channel the answer and the interrupt travel on. Control messages are lifted off the transcript in the parser and never become harness prose.

**Decision — the policy, which is the part that matters.** D-056 found that the harness inherits `HOME` and every `CLAUDE_*` variable, so the operator's own settings could decide what gets asked. A guarantee that depends on whose laptop hosts the runner is not a guarantee. Two flags pin it, both verified against `claude 2.1.221`:

- `--setting-sources ""` — loads none of user, project, or local. Measured: with a worktree `.claude/settings.json` saying `{"permissions":{"allow":["Write"],"defaultMode":"acceptEdits"}}`, the same Write was **silently performed** without this flag and **routed to Novus** with it. It also stops settings-defined hooks, which run *before* the permission check.
- `--permission-mode manual` — states the asking mode outright, and overrode a settings file saying `acceptEdits` on its own.

Not passed: `acceptEdits` (the gap), `bypassPermissions`, `dontAsk`, and no `--allowedTools`. An allowlist is a standing grant; this issues one approval for one act. Claude's `permission_suggestions` are parsed and **discarded** — the CLI offers `setMode acceptEdits (session)` and `addRules … localSettings`, and acting on either turns one answer into a policy. There is no "always allow", and `--dangerously-skip-permissions` is never used.

The decisive reason project settings cannot be an input: **the agent can write them.** A turn under supervision that creates `.claude/settings.json` grants itself standing permission for the next turn. Reading the file the harness may edit, to decide what the harness may do, is not a boundary.

**The cost, stated plainly.** `--setting-sources ""` also stops the repository's **`CLAUDE.md` from loading** — measured with a file naming a codeword the model could repeat unpinned and could not pinned. That is a real capability loss and it is not hidden anywhere: a project's own instructions no longer reach the agent. The remedy does not require re-admitting settings, because the CLI has `--append-system-prompt-file`; Novus can read the repository's own instruction file and pass it directly. That is the next slice and is not built here.

**Which actions ask** is Claude Code's own read-only classification, unchanged by Novus: `ls` never reaches the router, `echo hi > NOTE.txt` and `Write` always do. Novus neither widens nor narrows it — it makes it the only thing deciding, on every machine.

**A pending approval is a safe boundary**, which PRODUCT.md already said and nothing implemented. The runner declares one when it asks. Without it, accepting a control handoff waits for a boundary that can never arrive, because a turn blocked on stdin never exits — so the transfer would stall until the old holder answered the very question the new holder was meant to answer. Two more things were needed and are built: the `boundary_request` command ARCHITECTURE.md always specified now has a sender, and it is dispatched out of band rather than queued behind the blocked turn.

**Authorization.** `approval.respond` is a lease capability and appears in no role list, exactly as PRODUCT.md's table has always had it. A Mission Admin who is not holding the baton may revoke it and then answer — visible and logged — but may not reach around it. Settlement is a compare-and-swap on `state = 'pending'`, so a second answer is refused rather than delivered twice.

**Durability.** One row per request, keyed `(execution, harness request id)` so a replayed report is one row. **No raw tool input is stored**: the summary is composed from named fields, path-masked and value-redacted through the same policy every reported string uses (D-052), and bounded twice. A `Write`'s file body never leaves the machine that read it. This is possible because `{"behavior":"allow"}` with no `updatedInput` is accepted — Novus never needs to hold the input to say yes.

**Stop.** The protocol interrupt is preferred, so a turn stops without destroying the resumable session, with the process-group kill from D-053 as a bounded fallback. Which one ended the turn is recorded (`protocol_interrupt`, `forced`, or `never_started`). A Stop settles any pending approval, and a late answer cannot resume a stopped execution because the execution only returns to `running` while it is still live.

**Alternatives.** An MCP permission-prompt tool (proven in D-056, rejected: a second process, and no interrupt on the same channel); `--setting-sources project` with `manual` mode, which did still route a Write despite a project allow rule (rejected: it rests on undocumented precedence and re-admits hooks that run before the permission check); degrading to unsupervised when the flags are unavailable (rejected outright — every way of running without the control channel is a way of running unsupervised, so a CLI that rejects these flags fails the execution by name).

**Consequences.** `needs_approval` is entered for the first time. Proven live against real `claude 2.1.221`: a real Write request reached the room, the card rendered it, **Approve once** was clicked in the window, the harness was unblocked, the file was written and committed, and the next turn resumed the same session. Proven deterministically in two clients: the non-controller sees the question, is told who can answer, and is refused by the server when their client asks anyway; control moves while the harness is blocked; the new holder answers; and a denial leaves the file uncreated and the execution completed rather than failed.

**Revisit when.** `--append-system-prompt-file` carries the repository's instructions, closing the cost above; or a second harness needs routing, at which point the control channel becomes an adapter concern rather than Claude Code's.

## D-063 — Missions are filed away, never deleted

**Context.** Missions accumulated and nothing ever removed one. A project that had been worked on for a week showed every failed attempt beside the one that mattered, and the only way to make the rail readable was to stop using the project. PROGRESS.md has recorded "no terminal mission lifecycle" as a gap since the beginning.

The obvious answer is a delete button, and it is the wrong one. A mission is the record of what an agent did to a repository under whose authority — directions, checkpoints, verification, and now who approved which act. That record is the product's reason to exist, and enterprise use means somebody will eventually need to answer "what happened here" about work everybody has forgotten. Deletion also cannot be undone by the person who most regrets it.

**Decision.** Archival: one column, set and cleared. Everything the mission is stays exactly where it was, and the mission stays readable to anyone who could read it before. What changes is one thing — it leaves the ordinary list, and appears under **Archived**, from where it is restored by one control.

There is no delete verb. Not hidden, not admin-only, not behind a flag: absent. A test asks for one and requires a 404, because "we chose not to expose it" and "it does not exist" are different guarantees and only the second one survives a future contributor.

**What archival is refused for.** An archived mission must not be one that is still doing something, so it is refused while an execution is live or an approval is waiting. Two separate refusals, because they are two different things for a person to go and do — and the waiting question is checked **first**, even though such an execution is also "active", since *answer it* is the useful instruction and *stop the execution* is not.

**What it deliberately does not touch.** No repository branch is deleted. No worktree is removed. The mission branch is the record of the work and lives in the user's own repository; a filing decision inside Novus does not reach into git. Worktree cleanup remains the separate, unbuilt concern PROGRESS already names.

**Where it takes effect, which is one query.** The mission list filters on the column and the Archived view is the same query with the filter inverted, so the two lists cannot disagree about where a mission is. Reading a mission does **not** consult it — filed away is not hidden, and the room opens exactly as it did. One consequence worth stating because it is load-bearing and easy to miss: the runner discovers work through that same default list, so an archived mission stops being enrolled, cloned, fetched and worktree'd. That is only safe because archival is refused while an execution is live.

**Capability.** A new `mission.archive`, held by Mission Admin and **not** lease-granted: filing a mission away is a decision about the mission's place in the product, not an operating verb on a running workstream, so holding the baton does not confer it. PRODUCT.md's `mission.close` is deliberately left alone and still unimplemented — closing a mission would *end its work*, which is a different act on a different lifecycle, and conflating the two to save a table row would have been improvising product truth.

**Alternatives.** Reusing `mission.close` (rejected above); a soft-delete with a retention timer (rejected: a timer turns "filed away" into "deleted later", which is the thing this exists not to do, and nobody would find out until the record was gone); hiding archived missions from the room as well (rejected: then archival is deletion with extra steps, and a receipt over a mission nobody can open is not a receipt); per-project Archived sections (rejected for now: one list is simpler and the case that motivates this is a handful of old failures, not hundreds).

**Consequences.** Closing a tab and archiving a mission are now visibly different acts and are proven to be: closing a tab leaves the mission running and in the rail (D-061), archiving takes it out of the rail and is refused if it is running. Archiving a mission whose tab is open closes that tab — a consequence of the rail no longer offering a way back, not a second meaning for the act.

**Revisit when.** Archived missions are numerous enough that one flat list stops working, or a mission genuinely must be destroyed for a legal reason — at which point the thing to build is a documented, audited erasure of a *named* mission, not a delete button.

## D-064 — The project's instructions, handed over explicitly

**Context.** D-062 pinned the harness's permission policy with `--setting-sources ""`, because a `.claude/settings.json` in the worktree is a file the agent can write, and reading it to decide what the agent may do is not a boundary. That was right and stands. It cost something real, which D-062 recorded rather than buried: the repository's `CLAUDE.md` stopped loading, so a project could no longer tell the agent its own conventions.

Measured against `claude 2.1.221`, with tools disabled so that auto-loading into context is the only way to know: a repository whose `CLAUDE.md` names a codeword is answered correctly with settings unpinned, and **not** answered with them pinned — the model goes looking for the file instead. (With tools available it often finds it, which is why this was easy to miss; a tool call that might discover the instructions is not the same as the instructions being in context, and it spends a turn.)

**Decision.** Novus reads the worktree's own `CLAUDE.md` and passes it with `--append-system-prompt-file`, which needs no setting source at all. Same measurement, same repository, pinned: answered immediately.

**Why this is safe while settings stay pinned — the distinction the whole thing rests on.** Both files are things the agent can write. They differ in what they can do.

A settings file grants **authority**: allow-rules, and hooks that run *before* the permission check. A supervised turn that writes one widens what the next turn may do without asking anybody, which is the escalation D-062 closed.

`CLAUDE.md` grants **nothing**. Every tool call still reaches the permission router; an agent that writes "you may always write files" into it has written a sentence, not a grant. The worst it can do is mislead the model — which is true of every file in a repository the agent reads, and is not a new power.

**What is checked before it is passed.** The file is resolved through `realpath` and must land inside the worktree: a `CLAUDE.md` symlinked to `~/.ssh/config` is an ordinary relative path right up until something reads it. Symlinks are *followed*, because this repository's own `CLAUDE.md` is one — pointing at `AGENTS.md` beside it — so refusing links outright would break the common case. It must be a non-empty regular file under 100 KB, so a generated file cannot become the whole prompt. It is read per attempt, because a turn that edits the project's instructions is describing how the next turn should work.

**Alternatives.** Re-admitting `--setting-sources project` (rejected: it is the hijack vector, and it also re-admits hooks); inlining the file into the direction text (rejected: it would appear in the room as something a person said, and the transcript would carry it every turn); reading the nested `CLAUDE.md` files Claude Code itself walks (rejected for now: one file at the worktree root is what a project uses, and a directory walk is a bigger surface to contain).

**Consequences.** The one thing D-062 made worse is undone. PROGRESS's gap on it closes, with the measurement stated rather than the claim.

**Revisit when.** Projects nest instructions per directory often enough that the root file is not enough, or a harness other than Claude Code needs the same treatment through a different flag.

## D-065 — The reply leads; the apparatus recedes; the columns move

**Context.** Looked at rather than reasoned about: a room where somebody had typed *hi* and Claude had answered was hard to read, and the reason was that nothing in it led. The direction, the reply, the speaker's name and "Technical activity 2 steps" were all 13–14px, and the direction and the reply were both `--text-1`. A vertical rule ran down the left of every turn. The eye landed on the rule, then on whatever was longest.

The room's whole purpose is one question — *what did the agent say back* — and the surface gave that answer no more weight than the machinery around it.

**Decision.** Three things, all subtractive except one.

**A step for speech.** `--type-speech` (15/25) is added to the scale for what the agent said, and it is the only text at `--text-1` inside a turn. The direction someone wrote drops to `--text-2`: you wrote it, you know what it says, and the answer is what you came back for. Everything *about* the turn — the speaker's name, model and effort, technical activity, the checkpoint line — goes to `--type-meta` at `--text-3`. Speech is content; the rest is apparatus. This is a scale addition, so it lands in DESIGN.md#typography in the same change.

**The rule goes.** Grouping is the indent of speech under its speaker and the space between blocks. A line beside every turn repeats what the spacing already says, and it competed with the only mark on the surface that carries meaning — the speaker's.

**Diff arithmetic is coloured.** `+3` and `−0` take `--ok` and `--danger` as text, the same pair the diff body already uses as backgrounds, so one change reads identically in the trace and in the panel. This is not colour-alone: the sign says which way it goes and the colour agrees with it.

**And the columns move.** The rail and the evidence panel were both fixed — 240px and 420px — which made a developer's working width somebody else's decision. Project names run past 240px routinely, and a diff's readable width is a property of the code being read. Each column now has a hairline handle that takes no layout width, widens to a real target under the pointer, is keyboard-operable (arrows step, Home resets), double-clicks back to its default, and remembers its width. Bounded at both ends so neither can be dragged to nothing or made to swallow the room. Remembered locally, because how wide a person keeps their panel is a fact about them and not about the mission — the same reason the working set is local (D-061).

**The archived dialog is composed rather than assembled.** It had a title, a paragraph, rows and a footer as four unrelated blocks with no shared inset; it read as a list dropped into a box. It now uses the dialog's own head/body/actions composition, and each row has one primary value (the mission), its context beneath it (project, who filed it), and the one action at the end. Restore is *not* hidden behind hover there, unlike Archive in the rail: hiding an action is right where it sits beside work nobody is filing away, and wrong where restoring is the only reason anyone opened the surface.

**Alternatives.** Making the direction quieter by indenting it instead of recolouring it (rejected: indentation is how speech is attached to its speaker, and using it for emphasis too would make both meanings mushy); keeping the rule and lightening it (rejected: a line that has to be nearly invisible to be tolerable is a line that is not doing anything); a splitter with a visible grab affordance (rejected: chrome that announces itself on every pass across the window).

**Consequences.** Every screenshot in `e2e/evidence` is regenerated. The type scale gains its first new step since the beginning, which is why this is a decision and not a stylesheet edit.

**Revisit when.** A turn can contain more than one speaker — a second harness, or a participant interjecting mid-turn — at which point attaching speech by indent alone may stop being enough.

## D-066 — One top row, a rail with two fixed ways out, and a panel that is not a menu

**Context.** Looked at side by side with a tool that does this well. The window had two chrome edges where it needed one: a top row holding Run and two toggles with most of its width empty, and a band of mission tabs underneath it. The top of the window — the part a person's eye reaches first — was doing almost nothing, and the tabs sat below it as if they were content.

Four more things, all of them the same fault in different places: something present that says nothing.

**Decision.**

**One top row.** The mission tabs move into the window's own row, level with its controls: rail toggle at the far left where the rail is, tabs immediately after it, the room's controls at the right. The wordmark is gone — the window is the product, and a label saying so is a label. `+` sits directly after the last tab, inside the scroller, because it makes the next one and belongs where the next one will be.

**Every tab names its project, always.** It used to appear only when two projects were open. A label that arrives and leaves as siblings come and go makes a tab's meaning depend on its neighbours; closing an unrelated tab should not change what the remaining ones say.

**The rail is a thing you can put away**, at any width, from a switch at the edge it moves — separate from the narrow-window overlay, which is the window's decision rather than the person's. Above its lists, fixed and not scrolling with them, are the only two things that are not a list: **Home** and **Search**. Search finds a mission by name across every project, deliberately not code — the rail's job is getting to a room, and a box there that searched file contents would be a different feature wearing the same control. Files are filtered where the files are, which is now a box above the tree.

**The panel is three sections, not five.** Five equally-weighted tabs made it a menu: nothing in the row said which you were likely to want. The split is what the *work* is — All files, Changes, Checks — against what the *workspace* is: Overview and Output, in their own region at the foot, under their own edge. The first three are read while working; the last two are consulted.

**And the panel loses its identity header.** Who holds the baton is the room's sentence, said once beneath the mission title. A second copy at the top of the panel competed with the panel's own subject, and the participant marks beside it duplicated the list in Overview.

**Alternatives.** Keeping the tab band and shrinking the top row (rejected: two edges is the problem, not the height of either); a project label only on hover (rejected: a tab has to be readable without being pointed at); folding Overview into the room header (rejected outright — DESIGN.md forbids machinery in the mission header, which is why Overview exists); a real code search in the rail (rejected for now: it needs the worktree indexed, which is a feature and not a box).

**Consequences.** Three end-to-end assertions changed because they pinned the old behaviour: the project label being absent with one project, the strip overflowing at a width it no longer overflows at now that it has the window's full width, and the panel carrying a controller line and participant stack in a header that no longer exists. Each was rewritten to assert the new truth rather than deleted — the participant assertion in particular moved to Overview, where the list actually is.

**Revisit when.** A fourth thing genuinely belongs beside All files / Changes / Checks, at which point the split needs rethinking rather than a fourth tab; or the rail's search needs to find something other than a mission.

## D-067 — Verification follows the size of the change

**Context.** The repository gate runs the build, type checking, linting, and every deterministic test. Requiring that full run after every small visual adjustment made UI iteration take many minutes, encouraged test edits made only to satisfy an intermediate layout, and pulled attention away from inspecting the actual screen.

**Decision.** Verification is proportional during development. Visual-only work is inspected in the app and does not require a full test run. A focused behavior change runs its focused test. Contract, runner, persistence, security, or cross-package work runs the affected package tests. The full gate remains required before merging a coherent slice, pushing a shared branch, or preparing a release or demo build. End-to-end tests are required when the user-facing workflow changes or at release checkpoints. No test may be weakened merely to make a visual iteration pass.

**Alternatives.** Run the full gate after every task (rejected: too slow for iteration); skip verification entirely (rejected: it hides regressions); make the gate incremental (deferred: useful later, but does not solve the immediate workflow problem).

**Consequences.** Claude can move quickly through small UI refinements while still producing strong evidence at slice and release boundaries. Intermediate work may be explicitly marked as not fully verified, and a final gate remains a hard requirement for shared or release-ready code.

**Revisit when.** The gate becomes incremental and fast enough that the full run no longer interrupts normal iteration, or CI can provide reliable slice-level verification automatically.

## D-067 — The top row starts after the window's own buttons, and a tab is a word

**Context.** Two things visible the moment the previous change was run rather than reasoned about. The rail's switch had been put at the far left of the top row, which on macOS is where the window's own close, minimise and zoom buttons are — so it sat on top of them. And the tab strip, moved into that row, had kept the surface and bottom border it needed when it was a band of its own: a filled plane a few pixels under the window's own edge, with every tab a filled shape inside it. A panel in a panel, and eight shapes asking for attention when only one had anything to say.

**Decision.** A `--traffic-inset` token, and everything Novus puts in the top row starts after it. The strip loses its background and its border: it is in the window's row, so the window is its surface. Tabs lose theirs too — a tab is a word, at `--text-3`, brightening on hover — and only the one being read takes a plane. Labels tighten so more of them fit before the row has to scroll, and the horizontal scrollbar goes: the strip is one row tall, so any thumb is a third of its height and sits under the tabs looking like debris, while the selected tab is scrolled into view for you and a trackpad scrolls the rest.

**Alternatives.** Keeping a lighter surface on the strip (rejected: the reason it had one was to separate it from the room, and in the window's own row there is nothing to separate it from); an underline on the active tab instead of a plane (rejected: it reads as a second border a few pixels below the window's, which is the thing being removed).

**Consequences.** Four end-to-end assertions matched tab text at lengths the tighter labels no longer reach, and were shortened to the part that survives truncation. One hover assertion was made to re-place the pointer on each poll: the rail re-reads the mission list on a timer, and a row replaced under a stationary pointer does not always re-acquire `:hover` — which is a property of the test environment, not of the product, and had been failing intermittently before this change made it constant.

**Revisit when.** Novus is packaged for a platform whose window controls are not at the top left, at which point the inset is a per-platform value rather than a constant.

## D-068 — The rail is the whole left column

**Context.** Run and looked at: the rail's right edge started below the top row while the evidence panel's ran the full height of the window, so the two columns disagreed about what they were. The rail's switch, moved to the far left of the top row, was still crowding the window's own buttons. And the tabs began at the window's left edge — inside the width the rail occupies — so opening one drew it over the column beside it.

All three are the same mistake: treating the top row as a band across the window rather than as the room's own header.

**Decision.** The rail is the full left column, top to bottom, and the top row belongs to the room. The rail carries its own strip at the top, inset past the window's buttons, with its switch at the rail's right edge — the switch belongs to the column it moves, at the edge that moves. The room's row starts where the room starts, so tabs begin after the rail rather than over it. When the rail is put away the switch reappears in the room's row, which then takes the inset itself: two switches for one thing is one too many, and a switch that hides with the thing it reveals cannot bring it back.

**Alternatives.** Keeping the row full-width and giving the rail a top border to match the panel (rejected: it makes the columns agree by adding a line rather than by being right); putting the switch in the room's row permanently (rejected: it is the rail's control, and reaching across the room's header to move the rail reads as backwards).

**Consequences.** `.project-shell` is now the whole window below nothing at all. The `--traffic-inset` introduced in D-067 moves from the top row to the rail's strip, and applies to the top row only in the case where the rail is not there to hold it.

**Revisit when.** The room needs a header of its own *and* a tab row — at which point the tabs and the room's controls stop sharing a line.

## D-069 — Search is a command surface for missions

**Context.** Search was presented as another framed form, which made a global navigation action look like a settings dialog and gave every result the same visual weight.

**Decision.** Search opens as a compact command surface from the rail. The input is the surface's title-level control, results are one selectable list with a clear active row, and each result names the mission first with its project as context. Empty and no-match states remain inside the same surface. Keyboard navigation and an explicit listbox relationship are required; search remains mission navigation, not file-content search.

**Consequences.** The search surface shares the dialog and palette tokens, keeps one content axis, and remains usable without a pointer. The rail stays responsible for finding rooms; files continue to be filtered in the files panel.

**Revisit when.** Search needs to query code, transcript content, or another indexed resource, at which point those scopes need an explicit product decision rather than being added to this command surface implicitly.

## D-070 — A command this machine began is never begun twice

**Context.** The runner remembers the commands it has settled, so a command re-offered after a relaunch is completed rather than repeated. It wrote that memory *after* the work returned, which left the case in between unhandled: a machine killed mid-turn — a crash, a force quit, a laptop closing — came back, polled, and was offered the same `start_execution` it had already been running. It ran the whole turn again, from the top, against a worktree the first attempt had already changed, with the first attempt's own record nowhere. PROGRESS.md has carried this as a known gap since D-053.

**Decision.** The memory records a command as **started** before the work begins and **settled** when it ends, and both survive a relaunch. A command the file says this machine began and never settled is not run again: it is acknowledged as failed with that reason, and — when it named an execution — reported as `execution.interrupted`, which is the state whose action is Restart. The person decides whether to run it again, which is what D-034 already says about a lost host. At-most-once per machine is now the property the memory carries; the control plane's idempotency keys remain the property the *transport* carries, and neither substitutes for the other.

**Alternatives.** Re-running the command and relying on the harness to notice (rejected: the harness has no idea a previous process existed, and the second turn's checkpoint would silently contain the first turn's work); marking the command settled *before* running it (rejected: a command that fails to start would then be reported as done); waiting for the runner-liveness sweep to end the execution (rejected: it is right and it is ninety seconds late, and it cannot stop the returning machine from picking the command back up in the meantime).

**Consequences.** A crash mid-turn now ends that execution honestly and quickly rather than duplicating it. The memory file gains a version and two states; the old array of settled ids still reads, as settled. Everything that was already covered stays covered: a graceful quit still reports `execution.interrupted` on the way out, and a command that ran to completion is still a no-op on replay.

**Revisit when.** Cloud runners exist, where "this machine" is not one laptop and a replacement runner may legitimately continue a turn another one began.

## D-071 — What a turn cost, and the harness's own workers

**Context.** Two things the CLI says on its own stream were being dropped. It reports what a turn spent — tokens, cache, dollars, wall clock — on its final `result` line, and Novus discarded it, so a person watching a long unattended run had no way to see what it was costing and a receipt could never say. And Claude Code can spawn its **own** subagents: by default nothing they say is forwarded, so a `Task` that runs for four minutes was one tool row followed by silence, which reads like a wedged turn. `--forward-subagent-text` forwards their text tagged with the tool call that spawned them (measured against `claude 2.1.223`).

**Decision.** Both are carried, and both are carried as what they are.

**Usage is an opaque claim.** `harness.usage` reports the harness's own figures per turn and they are summed onto the execution. Nothing is billed from them, nothing is stopped by them, and no ceiling is derived from them — ARCHITECTURE.md has said "opaque optional metadata" since before there was an implementation, and D-034 forbids a Novus-imposed limit. A figure the harness did not report stays **null**, never zero: "not reported" and "free" are different facts, and a zero would be Novus asserting one of them.

**A subagent's activity is activity, not speech.** `--forward-subagent-text` is passed, and text carrying a `parent_tool_use_id` goes into the turn's technical disclosure, indented under it — not into the speech position. The reply that leads a turn stays the harness's own (D-065), and a worker is never given a branch, a checkpoint, a controller, or a workstream. Novus groups what the stream exposes and invents nothing: PRODUCT.md's harness boundary gives internal subagents to the harness, and a room that drew lanes for them would be claiming a structure the product does not have.

**And an optional flag degrades where a pinned one fails.** `--forward-subagent-text` is a nicety; a CLI that has never heard of it refuses by name, and Novus retries once without it. The permission flags are deliberately not in that set: a CLI that will not route approvals still fails the execution outright (D-062), because every way of running without the control channel is a way of running unsupervised. The retry reads the refusal by flag name, so the two can never be confused.

**Alternatives.** Deriving cost ourselves from token counts and a price table (rejected: prices are the vendor's and change without us; a number Novus computed would look like a bill); rendering subagent text as harness speech (rejected: it makes the room's central question — what did the agent say back — answered by whichever worker spoke last); probing `claude --help` for the flag before every turn (rejected: it spawns the binary an extra time for a nicety, and the refusal already names itself); not forwarding at all (rejected: the silence during a long `Task` is indistinguishable from a stall, which is the fault the next slice exists to make visible).

**Consequences.** The execution row carries seven nullable figures and the trace's machinery line states them at the meta step — apparatus beside the model that ran it, never a tile or a chart (DESIGN.md prohibited pattern 16). `RunnerEvent` gains `harness.usage` and a `parentToolUseId` on harness text and tool events. Proven live against `claude 2.1.223`: real figures arrive through Novus's own turn path.

**Revisit when.** A harness reports usage in a shape these fields cannot hold, or an organization budget becomes real — at which point cost stops being only a claim and needs a decision of its own about what it may stop.

## D-072 — Project skills stay outside the pinned boundary, and this is why

**Context.** Pinning `--setting-sources ""` (D-062) is what stops a `.claude/settings.json` in the worktree deciding what the agent may do. D-064 restored the repository's `CLAUDE.md` through `--append-system-prompt-file`, which needs no setting source. The open question was the next one: a project's `.claude/skills` — the folder a team uses to teach an agent its own procedures.

**Measured, against `claude 2.1.223`, in a directory carrying `.claude/skills/zephyr-codes/SKILL.md`.** The session's own `system/init` line enumerates what it loaded. With settings pinned: 16 skills, 45 slash commands, no `zephyr-codes`, no MCP servers. With `--setting-sources project`: 17 skills, 46 slash commands, `zephyr-codes` present in both — **and three MCP servers appeared with it**. So project skills genuinely do not load under the pinned policy, and the flag that loads them loads more than them.

**Decision.** Novus does not load a project's skills in this slice, and does not reach for the two channels that could.

`--setting-sources project` is refused for the reason D-062 gave and the probe above confirms: it re-admits hooks, which run *before* the permission check, and MCP servers, which are tool surface nobody in the room authorized. A file the agent can write must not decide what the agent may do, and skills arrive through the same door as the things that would.

`--plugin-dir` is refused *for now* for a subtler reason: it is explicit, bounded, and session-scoped, which is the right shape — but a Claude Code plugin is not only skills. It can carry hooks and MCP servers too, so pointing it at repository content re-opens the same door with better manners. The version of this that could work is Novus **composing** a directory containing only skill files it copied out of the worktree, under the same containment `CLAUDE.md` already has — resolved through `realpath`, inside the worktree, regular files, bounded — and that is a slice with its own path handling, not a flag.

**What a project can do today** is state its conventions in `CLAUDE.md`, which is carried, and which grants nothing: every tool call still reaches the permission router (D-064).

**Alternatives.** Inlining every skill body into the appended system prompt (rejected: skills exist to be loaded on demand, and pasting them all into every turn spends the context they were meant to save); inlining only their descriptions (rejected: it tells the model about procedures it has no way to invoke, which is worse than silence); shipping `--plugin-dir` now with a note that hooks are a risk (rejected outright — "we know it can escalate and we shipped it anyway" is not a boundary).

**Consequences.** A team whose procedures live in skills gets none of them through Novus yet, and PROGRESS.md says so rather than leaving the impression that pinning the settings was free. The measurement above is the reference for whoever builds the composed-directory version.

**Revisit when.** The CLI gains a way to load skills alone from a named directory, or the composed skills-only directory is built with its own containment and evidence.

## D-073 — A quiet turn is a sentence, not a limit; and a waiting question outlives its answerer

**Context.** Two failures in the same family: the room could not say that nothing had happened. A harness turn that wedges — a tool call that never returns, a process waiting on something that will not arrive — looked exactly like a turn that was working, for ever, because the only thing the room reported was `running`. And when a control lease expired while the harness was blocked on a permission question, the question stayed pending with nobody holding `approval.respond`; the state was recoverable, since any participant may claim an unheld lease, but nothing said so and nothing explained why the mission had gone quiet. PROGRESS.md has carried both as known gaps.

**Decision — the stall is stated, never enforced.** PRODUCT.md's *Execution stalled* overlay is implemented as what it always said it was: an observation. A running execution that has reported nothing for **ten minutes** carries the overlay, and the state line appends *no progress reported since {time}*. Nothing is stopped, no authority moves, no execution is ended, and no ceiling is imposed — D-034 forbids one and this does not smuggle one in. The threshold is deliberately generous, because the most common quiet turn is a legitimate one: a twenty-minute test suite inside a single tool call reports nothing while it runs, and the sentence the overlay produces — nothing has been reported for this long — is true and useful in that case too.

**A harness waiting on a person is never stalled.** It is waiting for a human, which the room already says in words, and however long that lasts it is not a fault. Silence from an execution that is `needs_approval` produces no overlay at all.

**And the recovery action is the one that already exists.** A wedged turn is ended with **Stop**, which any non-viewer participant already holds, which already prefers the harness's own interrupt and escalates to the process group (D-053), and which is already recorded. `force_interrupt` stays unimplemented as a distinct verb: it would do what Stop does, and two verbs for one act is how a capability table starts lying.

**Decision — the question survives.** A lease that expires while an approval is pending settles nothing and kills nothing: the request stays `pending`, the harness process stays alive, and the execution stays in *Needs approval*. What changes is that it is now **said**. The expiry event records that a question was waiting, so the history explains the moment; the state line adds *no one holds the baton — claim it to answer*; and the approval card already offers Request control to anyone whose role carries it. Claiming an unheld lease is fulfilled immediately, the claimant answers, and the previous holder is refused — because authority is read from current durable state at command time, not from who was asked.

**Alternatives.** Killing a stalled turn automatically (rejected outright: it is a wall-clock ceiling wearing a watchdog's clothes, and the first thing it would kill is somebody's long test run); a short threshold with a gentler word (rejected: a sentence that appears every few minutes on healthy turns is one people learn to ignore); reassigning the lease to another participant when it expires (rejected: Novus does not choose who is responsible — a claim is an act, and an unheld lease is claimable by design); settling pending approvals when the lease expires (rejected: it answers a question nobody was asked, and denial-by-timeout is the silent auto-decision this whole slice exists to not make).

**Consequences.** `MissionOverlay` gains `execution_stalled`. The room's suffix says what is true and offers nothing new to press. A person walking into a mission whose controller vanished mid-question now reads what is wrong and what to do about it in the state line.

**Revisit when.** Runners can report liveness *within* a turn — a heartbeat while a tool call runs — at which point a stall can be told from a long tool call and the threshold can drop.

## D-074 — An approach is a sibling workstream with an intent, and nothing ranks it

**Context.** D-006 settled the shape years of prototype drift got wrong: an approach is a *flag on a deliberately created sibling workstream*, not a fifth object, and comparison chrome may not render over one lane. The flag has existed in the schema since the beginning with nothing able to set it, a `workstreams_one_per_mission` unique index underneath it making a second lane impossible, and a runner that assumed `detail.workstream` was singular. So "competing approaches" was a documented idea with a database column and no product.

**Decision.** Creating an approach is one explicit act, `approach.create`, held by Mission Admin and Operator and **not** lease-granted — forking the work is a decision about the mission, not an operating verb on the lane being forked, and the baton over one workstream must not confer the power to spawn another.

**Three things are required of every approach**, because without them a comparison is theatre:

- **An intent.** One sentence saying how this attempt is meant to differ. Empty is refused by the server, not just by the form. An approach nobody can distinguish from its sibling is a retry, and PRODUCT.md has always said a retry is a continuation rather than an approach.
- **An origin.** It forks from a recorded checkpoint of the workstream it is created beside, and that revision is stored. Two approaches are comparable *because* they started from the same commit; without a recorded origin, a comparison is between two different problems.
- **Its own everything.** Its own branch allocated beside its sibling's, its own worktree, its own lease, its own direction queue, its own executions, its own runner enrolment and credential. Isolation is structural: there is no shared filesystem for two approaches to collide in, and no code path where one lane's turn can see the other's worktree.

**Nothing ranks them.** No score, no total, no ordering by outcome, no recommended column, no synthesis of one approach into another. PRODUCT.md's non-goals have forbidden automatic ranking from the first draft and this is where that becomes load-bearing rather than theoretical: the surface presents each approach's own evidence in the same shape and stops. Where evidence is missing the row says so — *not verified* is a finding, and a blank would let a reader assume the opposite.

**Alternatives.** Approach as its own object with its own lifecycle (rejected again, for D-006's reason: a fifth concept whose default presence invites the comparison-chrome-over-nothing failure); one worktree shared by both approaches with branch switching (rejected outright: two agents and one checkout is a corruption waiting to happen, and it makes "isolated" a promise the filesystem contradicts); scoring approaches on checks passed (rejected: it is the automatic ranking the product forbids, and a green tick count is not a judgment about which change is right); allowing an approach with no intent (rejected: it is how a comparison surface fills with lanes nobody can tell apart).

**Consequences.** The one-workstream-per-mission index is dropped and a mission may hold several lanes. The runner enrols per workstream rather than per mission, and worktrees are keyed by workstream — an existing mission's worktree is recreated from its branch under the new key, which is safe because the branch is the record and a checkpoint commits at every turn boundary. `MissionDetailResponse` carries `workstreams` and per-lane state; the room shows lane chrome only when more than one exists (DESIGN.md#component-behavior). PROGRESS.md's "one workstream per mission" constraint closes.

**Revisit when.** More than a handful of approaches per mission turns out to be real, at which point the comparison axis stops being columns; or two approaches need to be run on two different machines, which the per-workstream runner enrolment already permits and nothing yet exercises.

## D-075 — A decision is a judgment with a rationale, and choosing is not applying

**Context.** The product could produce competing results and had no way to record which one a team chose or why. PRODUCT.md's Review object covered comments and acceptance in the abstract; nothing carried the things that make a choice defensible six months later — what was accepted despite being unverified, and what risk somebody knowingly took.

**Decision — the record.** A `Decision` names the chosen workstream, the exact checkpoint chosen, the person who chose, a **rationale that cannot be empty**, the risks they wrote down, and the ids of the checks that were unresolved at that moment, captured *at* that moment rather than recomputed later. It is recorded under `review.approve`, which PRODUCT.md's capability table has always defined as "accept result, request revision" — the verb existed and had no implementation; this is it. A later decision supersedes an earlier one and neither is erased: reversals are part of the record.

**Rationale is required and is a person's own words.** Not a dropdown, not a template, not a generated summary. The one sentence a reviewer most needs in a postmortem is why a human chose this, and a field that can be skipped is a field that is skipped.

**Decision — choosing is not applying.** Recording a decision moves the mission to *Decision recorded*, whose whole job is to say that nothing has been published. Novus then **prepares** a pull request — title, body assembled from the goal, the rationale, the accepted risks, the unresolved checks and the changed files, plus base and head branch — and shows it read-only with a copy action. Nothing contacts GitHub, nothing merges, and no state pretends otherwise. The prepared request is a **projection** over durable state rather than a stored draft, so it cannot go stale against the decision it describes; a tracked `PullRequest` row starts existing when one is actually opened, which is a later slice.

**Unresolved checks are shown before the decision, not after.** The recording surface lists what was never verified while the person is deciding. A product whose principle is evidence over claims cannot let somebody accept a result without seeing what it does not have.

**Alternatives.** Completing the mission on a decision (rejected: it is the exact conflation this entry exists to prevent — the work is not applied and the PR does not exist); a decision without a checkpoint (rejected: "we chose this approach" without a revision is a claim about a moving target); computing the unresolved checks when the receipt is read (rejected: it would rewrite history every time verification changed, and the honest question is what was outstanding *then*); storing the prepared pull-request body (rejected for now: a stored draft drifts from the decision it was made for, and nothing yet edits it).

**Consequences.** PRODUCT.md gains the `Decision` object and the *Decision recorded* state; DESIGN.md gains the Decision Room, the recording surface, and the receipt with its prepared pull request. `review.approve` stops being an unimplemented row in the capability table. Live GitHub publication remains deliberately out of scope, and PROGRESS.md says so rather than letting "prepared" read as "opened".

**Revisit when.** Pull requests are actually opened and tracked, at which point *Decision recorded* hands over to *Pull request open* and the prepared projection becomes a real row.

## D-076 — Quiet chrome: one button size, a hairline focus, one plane per dialog

**Context.** Looked at rather than reasoned about, on a real screen. The *Try another approach* dialog showed three faults at once, and all three are elsewhere in the product too. **Cancel** was 28px tall beside a 32px **Start it**, because `.btn` set one size and `.btn-primary` quietly overrode it — two buttons on one row rendering as two unrelated objects. The focused textarea wore a 2px near-white ring at 2px offset, which on a dark ground is a white slab stuck to whatever you touched, and which appears the instant the dialog opens because the field is autofocused. And the dialog was three stacked planes — a bordered box containing a hairline-separated head, a bordered input, and a hairline-separated foot — which is the cards-in-cards shape prohibited pattern 5 already forbids, arriving one hairline at a time.

The user's words for the result were "cheap" and "not the design you'd expect from a coding agent", against a reference of tools that keep it simple and clean. That is a standing correction, not a one-off, so it is written into DESIGN.md's product feeling rather than only fixed here.

**Decision.**

**One button size.** `.btn` is 32px minimum height with one padding, and no variant overrides it. 32px is also the pointer-target floor DESIGN.md#density already asked for, which the 28px default had been quietly failing.

**A hairline focus ring, and none at all on a text field.** `:focus-visible` becomes 1px at 2px offset. An input shows focus on **its own edge** — the border it already has, brightened — because a ring around a bordered box is that border drawn twice. Focus stays visible everywhere and is still never removed; what changes is that it stops shouting.

**One plane per dialog.** The head and the actions lose their hairlines and separate by space; a field inside a dialog sits on `--surface-1` with no border of its own. One bordered container, nothing bordered inside it.

**And every dialog closes the two ways people expect** — `Esc`, and a click outside — which DESIGN.md has specified from the first draft and which three dialogs shipped without because each was hand-written. That is what the `Dialog` primitive on DESIGN.md's list is for, and it now exists: scrim, escape, focus restored, in one place.

**Alternatives.** Keeping the 2px ring for accessibility (rejected: the obligation is that focus is *visible*, not that it is loud, and a 1px ring plus a brightened field edge is visible at a glance); removing the focus ring on mouse interaction only (already true — the rule was `:focus-visible` before this change, and the ring was simply too heavy); leaving the hairlines and lightening them (rejected for D-065's reason: a line that has to be nearly invisible to be tolerable is not doing anything).

**Consequences.** Every button in the product grows to one height, which is most visible in dense rows where a text button now has a real target. The Add project dialog, the setup dialog and the archived dialog inherit the quieter composition without being touched individually. DESIGN.md gains the standing correction in *Product feeling*, so the next agent reads it before drawing anything.

**Revisit when.** A surface genuinely needs a larger primary — a first-run action, a destructive confirmation — at which point the size becomes a named variant rather than a per-component override.

## D-077 — Starting a mission is a question; a project row is a disclosure; the heading reads as one

**Context.** Three faults in one screenshot of the rail, all judged against how Conductor and Codex handle the same moments. A permanent **New mission** row sat at the foot of every project's list dressed as a mission, and the `+` beside a project opened a *draft tab* — a "New miss…" tab in the strip that was always reachable and looked like an open room with nothing in it. Clicking a project's name did two different things on two clicks: the first *navigated* — selected the project and moved the room to one of its missions — and the second collapsed the list. And a project's name rendered identically to the missions beneath it, so the rail had no visible hierarchy; selecting a mission also washed its project's heading grey, which read as the whole project being pressed.

**Decision.** Three changes, one per fault.

**Creation is a question, not a place.** `+` on a repository row, the strip's `+`, `⌘T`, the empty-room control, and the landing after Add project all open one small dialog: *What should Claude do?* Enter with words creates the mission — goal derived from them, the words becoming the first direction — and opens its room. Enter with nothing, `Esc`, or a click outside closes it and **nothing happens anywhere**: no draft, no tab, no row. This is Conductor's `+`-popover and Codex's compose-or-nothing in one surface. The permanent rail row and the draft tab are gone; the draft machinery in the working set remains beneath (a restored draft still dies quietly), but no surface creates one.

**A project row is a disclosure and nothing more.** Click opens the list, click again closes it, and the room never moves. Landing somewhere is what clicking a *mission* does. One target, one behaviour — a row that navigated on its first press and toggled on its second was two controls wearing one label. Opening the app with nothing open no longer force-opens anything either; the empty state already offers the obvious next step.

**The heading reads as one.** The project name takes weight 600 and `--text-1`; its missions sit at `--text-2`, lifting on hover and selection. The parent row never takes the selected wash or the hover wash — selection belongs to the mission row alone.

**Alternatives.** Keeping the New mission row but styling it fainter (rejected: however faint, it is a non-mission living in a list of missions); creating the mission only on the composer's first message, Codex-style but in a full room (that was exactly the draft-tab flow being removed — the tab it required is the complaint); a first-click-selects, second-click-toggles compromise (rejected outright: it is the current behaviour).

**Consequences.** The rail is nouns again. `openDraft` loses its last caller and stays only for restored state. Several end-to-end assertions in `e2e/navigation.spec.ts` and `e2e/runtime.spec.ts` pin the removed flow — the `new-mission` rail row, the draft tab, drafts surviving in the strip — and must be rewritten to drive the ask-dialog instead; this entry is the discussion AGENTS.md requires before those tests change. PROGRESS.md records them as stale until that happens.

**Revisit when.** Mission creation needs more than words — a base-revision picker, criteria up front — at which point the dialog grows fields rather than the rail regrowing a row.

## D-078 — The ask-dialog is the composer wearing a dialog; mission rows are inset chips

**Context.** Two adjustments on sight of D-077's first build, both toward Conductor's shapes. The ask-dialog had a title, a subtitle, and a bordered box — a form about creating rather than the thing itself — where Conductor's is the project's name over one large prompt with the model and the Create action on its foot. And the rail's selected mission was a full-bleed sharp bar, which the standing radii rule mandated; the user wants the highlight rounded and the row a touch smaller.

**Decision.** The ask-dialog is rebuilt around the **real Composer**: project name across the top, the composer's textarea as a large borderless body, and the composer's own foot — model chip, effort chip, send control — as the Create row. This is reuse, not resemblance: the model and effort chosen there are the same persisted choices the room's composer uses, Enter submits the same way, and the composer's border comes off inside the dialog because the dialog is already the container (D-076). The composer gains two narrow props to serve it: a placeholder override, and an empty-Enter handler — the room ignores an empty send; the dialog closes on one, because an empty ask is a dismissal (D-077).

The radii rule is amended rather than broken: in the rail, **headings are full-bleed and sharp; mission rows are inset chips** — 28px tall, set in from the rail's edges, 6px-rounded highlight. What the old rule was protecting against — floating capsules with shadows, accent bars — stays prohibited.

**Alternatives.** A look-alike foot with static model text (rejected: chips that look interactive and are not are dead controls, and a second copy of the model picker would drift from the real one); rounding every rail row including headings (rejected: the heading is the container's own line, and rounding it makes the rail a stack of pills).

**Consequences.** DESIGN.md's radii rule and the D-077 creation paragraph are amended in the same change. Model/effort selection now genuinely works at creation time, which the hardcoded-default version of D-077 quietly did not offer.

**Revisit when.** The dialog needs Conductor's remaining furniture — create-from-branch, create-more — at which point the foot grows controls rather than the header growing menus.

## D-079 — An approach forks from the shared checkpoint, shown before it is used

**Context.** D-074 recorded that an approach forks "from a recorded checkpoint of the workstream it is created beside", and the implementation read that as *the latest checkpoint of the source lane*. For the mission's first lane those are the same thing. For a lane that is itself an approach they are not: forking beside an Alternative that had checkpointed its own work would seed the new lane with commits that exist only in the Alternative — a continuation wearing a sibling's name, and a comparison between two lanes that did not start from the same place. Separately, the creation dialog showed a checkpoint the route did not enforce, so the revision a person read and the revision they got could drift apart between the look and the click.

**Decision.** Three rules, one of them computed in exactly one place.

**The fork point is the shared checkpoint.** A new approach created beside lane X starts from the last checkpoint X *shares* with its own origin lineage: X's recorded origin where X is an approach, X's latest checkpoint where X is the lane the mission started with. Work that exists only in X stays in X. `sharedForkPoint` computes this once; the creation route enforces it and `ApproachSummary.forkPointSha` reports it, so the dialog and the route cannot disagree.

**The revision shown is the revision used, or nothing.** The creation input carries `expectedOriginSha` — the checkpoint the dialog displayed. When the computed fork point differs (the lane checkpointed again between the look and the click), creation is refused with `origin_moved`, naming where it moved, and nothing is created. When no shared checkpoint exists, creation is refused with `nothing_to_fork` and the dialog says so with a disabled action rather than guessing.

**Lanes are named for what they are.** The lane a mission starts with is **Current work** (it was `main`, a git word wearing a lane's name, migrated idempotently); a fork defaults to **Alternative**, then **Alternative 2**. Names identify, never rank.

**Alternatives.** Forking an approach from its own head (rejected: it inherits work unique to the lane being read, which is the exact leak this entry closes); letting every approach fork only from the mission's very first origin (rejected: it would freeze all comparison at the first fork and forbid forking from the baseline's later progress); resolving an origin race by silently re-forking from the newer checkpoint (rejected: "never guess or silently fork from an unrelated later revision" is the rule — the person re-reads and re-decides).

**Consequences.** `CreateApproachInput` gains `expectedOriginSha`; `ApproachSummary` gains `forkPointSha`; the dialog states the mission goal, the exact shared checkpoint, and that changes made only in the current lane stay there. PRODUCT.md's origin-revision sentence is restated in these terms.

**Revisit when.** Approaches need to fork from a *chosen* historical checkpoint rather than the shared one, at which point the dialog grows a revision picker and the pinning input already exists to carry it.

## D-080 — The active lane is the room's address, and everything follows it

**Context.** D-074 made a second lane possible and nothing made it *operable*: `MissionDetailResponse` was always the first lane's — its control, its capabilities, its state — the room rendered the mission's pooled ledgers, every workspace verb resolved to the first lane's worktree, and a direction submitted with no lane named landed on lane one however hard a person was looking at the Alternative. The Decision Room could compare lanes nobody could actually work in. DESIGN.md's sketch for this moment ("a slim lane header per workstream") predates the working set and the room's own file strip, and a header is not a way to *be in* a lane.

**Decision.** The lane a person is reading is an explicit address, carried end to end.

**One lane per response.** `missions.get` takes the lane being read; `missionAccess` resolves it, so control, capabilities, runner, workspace, **state and overlays** come back computed for that lane — a fresh Alternative reads as its own empty room, never as its sibling's finished work. A lane that is not the mission's answers "no such mission", never the default lane's data under the wrong name. The renderer's `laneView` filters the mission-wide ledgers (directions, executions, checkpoints, checks, approvals, events, processes) to the same lane for the trace, while the Decision Room keeps reading them across lanes.

**Lanes are the room's own tabs.** The room's strip — the one that already carries file tabs — grows one tab per lane (a 7px identity dot and the name), a Compare tab, and nothing anywhere else: no second mission row in the rail, no lane in the window's mission strip. The rail says "2 approaches" under the mission's single row, a count and nothing more. A compact switcher (*Approaches 2 ▾*) beside *Try another approach* states the shared checkpoint and each lane's own facts in creation order, with Open — the same no-ranking rule as the comparison.

**The composer targets the lane on screen, always.** Every direction carries the active lane's id explicitly; the composer's foot says "Directing Alternative"; workspace verbs — files, terminal, setup, secrets, checks, run, preview, output — carry the lane and act in its worktree. The selected lane is part of the tab in the working set, so a relaunch restores the lane and the composer's target with it.

**Identity is a token pair, not a violet edge.** `--alt` is replaced by `--lane-current` (muted slate blue) and `--lane-alt` (muted amber): identity dots on tabs and switcher rows, plus the approach column's 1px edge. Identification only — the tokens' meaning forbids reading either as quality.

**Alternatives.** Lane headers stacked in one room (rejected: two live traces in one scroll is a merged transcript, and the composer would need a target picker anyway); approaches as tabs in the window's mission strip (rejected: they are not missions, and the rail/strip contract says missions only — D-061); a global "active approach" per mission shared by all participants (rejected outright: which lane *you* are reading is client state, like which file you have open); inferring the direction's lane server-side from "the most recently active" (rejected: that is the silent routing this entry exists to forbid).

**Consequences.** `Mission` gains `workstreamCount`; `MissionEvent` and `WorkspaceProcess` gain their lane; workspace/terminal IPC and the workspace command route accept a lane and resolve authority against it (ARCHITECTURE.md#authorization). DESIGN.md's lane-header sketch is replaced by the tab model, and the token table swaps `--alt` for the lane pair. The needs-attention lens still reads the default lane's state for missions nobody has open; a background Alternative that needs approval is visible in the room but not yet in the lens, and PROGRESS.md carries that as a gap.

**Revisit when.** More lanes than fit a tab row turn out to be real — the switcher already scales, the tabs would need to collapse; or two people need to *share* a lane focus, at which point presence, not navigation, is the tool.

## D-081 — A fork inherits its sibling's workspace, and consent is remembered, not re-invented

**Context.** Creating an approach gave it its own everything (D-074) — including its own *nothing*: a bare worktree with no `.env`, no secrets context, and setup never run, so every fork opened on "Workspace needs setup" and the person who wanted to compare two solutions first re-performed the ceremony they had already done once. The secrets half was already right — values are keyed by repository, so every lane resolves them — but consented Git-ignored files and the setup run were per-worktree acts with no memory.

**Decision.** On the machine that holds the checkout, a fork starts prepared, using only authority that already exists.

**Consent is remembered per repository.** When a person approves copying Git-ignored files into a worktree, the successfully copied paths are recorded in a machine-local store (bounded, 0600, never leaving the machine). A new lane's worktree gets those same paths copied again through the same chokepoint — every per-file validation re-runs, so a path that stopped being ignored is refused now, and no consent is ever invented, only replayed.

**Setup runs itself, as an ordinary authorized command.** After the fork's branch is cut, the desktop waits for the runner to enrol the lane and publish the declared list, then issues the same `workspace.command` a person's click would — authorized server-side, pinned to the published snapshot, attributed to the person who forked. The dialog says so before they click. No new trust path: a lane on a machine that does not hold the checkout gets nothing, exactly as before.

**Alternatives.** Copying files worktree-to-worktree from the sibling (rejected: the user's checkout is the single consented source, and a second source is a second policy); auto-running setup from the runner without a control-plane command (rejected: it would bypass the authorization pinning D-043 exists for, when the ordinary path costs one poll); asking again per fork (rejected: it is the ceremony this entry removes — the person already answered, and the answers are replayable facts).

**Consequences.** The fork dialog states the carry-over; PRODUCT.md's approach bullet carries it; "Workspace needs setup" on a fresh fork becomes the exception (no setup declared, machine elsewhere, or the run failing) rather than the rule.

**Revisit when.** Forks are made from machines that do not hold the checkout, at which point the hosting runner — not the forker's desktop — must replay consents and setup, and the consent store's machine-locality becomes the constraint to redesign around.

## D-082 — Declared checks run themselves at the checkpoint

**Context.** Verification ran on a click. In practice nobody clicked after every turn, so the product's most common terminal state was *Work finished — nothing verified*, and the Decision Room — the surface whose entire purpose is comparing evidence — routinely rendered *Not verified — everything* in both columns. A product whose first principle is evidence over claims was structurally starving itself of evidence.

**Decision.** When a harness turn ends with a committed checkpoint that changed files, the runner runs the project's declared verification commands itself and reports each result with origin **`automatic`**.

**The honesty is in the origin.** `automatic` is a fourth origin beside harness-observed, participant-run, and external — never collapsed into them, rendered in words ("Run by Novus at the checkpoint"), with `requested_by` null because nobody asked. The wire shape admits only `participant` and `automatic` from a runner, so a runner cannot claim a check was harness-observed or external.

**Sequencing and bounds are the existing ones.** The checks queue on the lane's own chain *behind* the turn's terminal report — the room hears the turn end first, and the checks can never touch a worktree the next turn holds. Each command runs against the snapshot the runner just republished, under the project's own declared deadline. A stopped turn triggers nothing: the participant asked for quiet. Setup and run kinds never auto-run.

**Projects can decline.** `autoVerify = false` in `.novus/settings.toml` (or the local override) switches it off. Default is on, because a turn that landed work unverified is the state this exists to prevent.

**Alternatives.** Leaving verification click-only (rejected: the evidence-starved Decision Room is the measured result); running checks inside the harness turn (rejected: the turn's end must be reported first, and a slow suite would silently stretch every turn); a server-side scheduler commanding `run_verification` after each checkpoint (rejected: the runner already holds the snapshot, the worktree, and the chain — a command round-trip adds an authorization actor for an act nobody performed); attributing automatic checks to the last person who pressed Run (rejected outright: it is a fabricated actor on evidence).

**Consequences.** `CheckOriginSchema` gains `automatic`; the `verification.completed` wire payload carries its origin with a backward-compatible default; the ledger renders the fourth origin in the same quiet meta style; staleness, re-running, and the Decision Room's tallies treat automatic checks exactly like any other. PRODUCT.md's VerificationCheck origins and ARCHITECTURE.md's runner behavior say all of this canonically.

**Revisit when.** Projects with slow suites want a subset ("run lint always, tests on demand"), at which point the declared command shape grows a per-command auto flag rather than the global boolean growing cases.

## D-083 — A session is a parallel conversation inside a lane, and the workspace takes turns

**Context.** A workstream has exactly one conversation. `workstreams.harness_session_id` is a single resume point, every direction lands in the same thread, and a person who wants to implement, write tests, and review inside one approach must either interleave one transcript or fork a whole approach — a branch, a worktree, a runner credential and a baton for what is only a second conversation. The need is real and narrower than approaches: several threads of direction against **one** checkout on **one** branch. Separately, the routing audit for this slice found four places where a request that names a lane through a *row* — a queued direction, a pending approval, a stop, an enrolment-time dispatch — was resolved against the mission's **first** lane instead of the row's own, which D-080's rule ("the active lane is the room's address") already forbids in spirit.

**Decision.** A **Session** is a durable, titled conversation with the harness inside one workstream. Four rules carry it:

- **A session is words-first.** Nothing creates an empty session: the `+` opens an empty conversation surface, and the first direction typed into it creates the session in the same transaction the direction lands in, titled by those words. `Esc` or switching away leaves nothing anywhere — D-077's creation rule applied one level down. There is consequently no `session.create` capability: creating a session *is* `direction.submit`, and a Viewer who cannot direct cannot create one.
- **Sessions share everything but the conversation.** One branch, one worktree, one workspace, one runner, one control lease per workstream, unchanged. A session owns its direction thread, its executions, and its own harness continuity — `harness_session_id` per session — so switching sessions never loses a conversation's context and resuming one never replays another's. A session has no branch, no worktree, no lease, and no workspace of its own, and the runner does not know sessions exist: the control plane picks the resume point when it starts the turn, which is where the rows are.
- **The workspace takes turns.** At most one live harness turn per workstream stays enforced by the existing partial unique index. A direction for the session whose turn is running steers that turn, exactly as before. A direction for a *sibling* session queues, visibly, with the running session named in the reason — and when a turn **completes**, the oldest queued direction authored by the current baton holder dispatches on its own. After a stop, a failure, or an interruption nothing auto-starts: a stop asked for quiet, a broken lane must not chain-fire, and both are states a person can read and act on.
- **A row names its lane, and the lane names the authority.** The fixes the audit demanded land with this entry: resolving, cancelling, or applying a queued direction is judged against the *direction's* lane; answering an approval is judged against the *approval's* lane; stopping names the lane on the wire; enrolment-time dispatch resolves the enrolled lane. None of these is a new rule — they are D-080's rule applied to requests that arrive through a row instead of a mission id.

**Alternatives.** A session as a sibling workstream (rejected: that is an approach — a branch and a worktree for what is only a second conversation, and D-074's isolation exists for competing implementations, not parallel chats). Two harness turns writing one worktree concurrently (rejected outright: two agents in one checkout is the corruption D-074 already refused once, and a checkpoint commits every dirty file, so one turn's commit would swallow the other's half-written work and attribute it to the wrong conversation). A lease per session (rejected: the baton answers "who operates this workspace", and a workspace with two batons has two answers). A creation dialog with a title field (rejected: D-077 — creation is words, and an empty titled session is the draft row the product just finished removing). A `session.create` capability (rejected: it would be a verb that only ever fires as a side effect of `direction.submit`, and the capability table lists separately enforceable verbs). Auto-dispatching after a stop or failure (rejected: quiet after a stop is the point of a stop).

**Consequences.** PRODUCT.md gains the Session object; ARCHITECTURE.md gains the `csn_` identifier (`ses_` was already the auth session's), the `workstream_sessions` row, `session_id` on directions and executions, per-session continuity, and the turn-taking rule; DESIGN.md gains session tabs, the Sessions switcher, and the attention words. `workstreams.harness_session_id` becomes a legacy mirror of the first session's. Every existing workstream is migrated with one session holding its history, so nothing that never uses the feature changes. Renaming a session, per-session verification, and two sessions running simultaneously on one worktree are deliberately absent, and PROGRESS.md names them.

**Revisit when.** A lane genuinely needs two simultaneous turns — at which point the answer is explicit file-ownership contracts or a second approach, never two agents in one checkout; or titles need to outgrow their first words, at which point a rename verb is the change.

## D-084 — The rail is the tree: a mission's structure nests where its project does

**Context.** Looked at on a real screen with two approaches, a decision, and sessions shipped (D-083), the room's control row had become five flat text controls — *Try another approach*, *New session*, *Approaches 2 ▾*, *The decision*, the baton — and one mission's structure was scattered across three surfaces: a count in the rail, lane and session tabs in the room's strip, and two switcher popovers repeating what the tabs already said. The user's words: confusing, wants it nested "as a branch inside projects", and the decision chrome shown differently. D-080 had deliberately kept lanes out of the rail; on sight of the built result, the owner reversed that presentation.

**Decision.** The rail maps the **active mission's** structure, and the room stops carrying structure chrome.

- **One tree, one place.** Under the active mission's row — and only the active one, so the rail never becomes every mission's tab soup — the rail nests one row per approach (identity dot, name), the **selected approach's** sessions one level deeper (title, in words), and a **Compare** row at the mission level once two approaches exist, carrying *· decision recorded* when one is. Rows are navigation: clicking an approach or session row is what the tabs used to be. A mission with one approach and one session grows no tree at all — the ordinary case stays exactly as it was.
- **A parent's `+` creates its child.** The project row's hover `+` already creates a mission (D-077); the selected approach's row gains the same quiet hover `+` for a new session, opening the words-first draft (D-083) — which also appears in the tree, as an untitled row, while it is being asked. *Try another approach* stays in the room's controls: it needs the fork dialog and its shared-checkpoint sentence, and it was never the crowding problem.
- **The room sheds what the rail now carries.** Lane tabs, the Compare tab, session tabs, the Sessions switcher, the Approaches switcher, and the *New session* control are gone; the strip is file tabs again. With them go the tab-era **open/closed session subset** — the tree lists the selected approach's sessions, so nothing closes — and its persistence.
- **A decision is a sentence and a surface, not three buttons.** The state line keeps *Decision recorded — {who} chose {approach} — not published yet* with no button of its own; *The decision* and *Open the decision* are removed; the way in is the rail's Compare row, where comparing and deciding already live.
- **What D-080 keeps.** Everything below the paint: the lane as the room's address, lane-scoped reads, directions carrying their lane and session, per-lane control — unchanged. This entry reverses where structure is *shown*, not how it is routed.

**Alternatives.** Every mission's tree always disclosed (rejected: the rail becomes the tab soup relocated); a structure column inside the room (rejected by the owner on sight of both options: a fourth column, and the rail is where nesting already lives); sessions as sibling branch rows beside approaches (rejected outright: an approach is an isolated worktree and a session shares one — rendering them as the same kind of branch lies about isolation, which is why sessions nest *inside* their approach); keeping the switchers alongside the tree (rejected: two surfaces answering "what lanes are there" is the redundancy being removed).

**Consequences.** DESIGN.md's information architecture, Workstreams, Sessions, and Decision Room presentation are rewritten in the same change; `e2e/decision.spec.ts` and `e2e/sessions.spec.ts` are deliberately rewritten from tabs to tree rows under this entry (the AGENTS.md-required discussion); `working-set` drops the open-session subset and keeps the selected session per tab. At 900–1200px the rail is an overlay, so the tree is one toggle away rather than always on screen — accepted, and the specs assert it open. PRODUCT.md and ARCHITECTURE.md need no change: nothing about the domain or the wire moves.

**Revisit when.** Two missions genuinely need their trees visible at once — at which point the answer is the second window the working set already implies, not a rail that discloses everything; or approaches multiply past what indented rows hold calmly.

## D-085 — The working set holds views, not missions: a lane opens as its own tab

**Context.** D-061 fixed "a mission is open at most once", and D-084 made lanes rail rows that retarget the mission's single tab in place. Watching it, the owner read a lane click as "it just renames the tab": the room swapped under one tab instead of the thing he opened arriving as its own tab, the way files now do in the room's strip. The mental model he keeps reaching for is an editor's: everything you open is a tab, side by side, coloured by where it lands.

**Decision.** The window's strip carries **views**: one tab per (mission, approach) a person has open. Clicking an approach row in the rail opens that lane's own tab — or selects the one it already has — beside the mission's other tabs, never replacing them. A tab whose mission holds competing approaches leads with its lane's identity dot (`--lane-current` / `--lane-alt`), so blue and amber tabs sit side by side and the colour says where each lands. Uniqueness moves down one level: a *view* is open at most once — (mission, lane) still never duplicates — and every per-tab fact (selected session, open files, canvas mode) stays per tab, which the working set's shape already carried. Sessions stay rail rows selecting within their lane's tab; if they ever earn tabs of their own, this entry is the precedent, not the permission.

**Alternatives.** Keeping one tab per mission with the rail as its switcher (rejected by the owner on sight — the click reads as a rename, not an opening); a tab per session as well (deferred: the ask named lanes and colours, and a strip of every conversation would crowd before it clarifies); dots on every mission tab regardless (rejected: a mission with one lane has nothing to tell apart, and the dot would be decoration — D-080's tokens identify, never decorate).

**Consequences.** `working-set` gains `openLane` and dedups restore by (mission, lane); the rail's approach rows and a file tab's lane-jump open tabs instead of mutating one; `MissionTabs` renders the dot from the mission's own lane count. D-061's other rules stand untouched: closing a tab closes a tab, drafts die quietly, restore drops what the server refuses. DESIGN.md's information architecture is amended in the same change. Existing specs keep their meaning — none pinned single-tab-per-mission — and per the owner's standing no-tests call the new opening behaviour is unpinned, which PROGRESS records.

**Revisit when.** Sessions want tabs of their own, or two tabs of one lane are asked for (which is a second window, not a second tab).

## D-086 — One mission on top; its approaches are the sub-row, colour-coded beside its files

**Context.** D-085 opened each approach as its own top-level tab, dot-marked. On sight, the owner said the point was missed: the top strip should hold **just the mission**, and the level *below* it — the row where an open file already appears — should hold the approach tabs, colour-coded, side by side with the file tabs: "the top level is just the mission, right below it tabs indicated by what approach."

**Decision.** Two levels, each owning one thing. The window's strip returns to **one tab per mission** (D-061's uniqueness, restored). The room's strip below it is the mission's whole working row: **one tab per approach** — the 7px identity dot and the lane's name, always present once the mission holds more than one — then Compare while it is open, then every open file, each file tab leading with the dot of the worktree it was opened from. Clicking an approach tab switches the room to that lane in place; clicking a file tab shows that file and moves the room to its lane; the colours are the thread that ties a lane's tab to its files. The rail's tree stays exactly as D-084 built it — the map, the sessions, the Compare row, the hover `+` — the strip is the quick hand, the tree is the structure.

**Alternatives.** Keeping D-085's per-lane top tabs (rejected by the owner on sight: two dot-marked copies of one mission's name in the window strip read as two missions); approach tabs only while a file is open (rejected: the owner asked for the row to be the mission's standing anatomy, and D-080 originally shipped exactly this presence rule); removing the rail tree now that lane tabs are back (rejected: the tree carries what tabs cannot — sessions, nesting, attention words, creation — and the owner approved it standing).

**Consequences.** `working-set` returns to mission-keyed tabs (`openLane` retired, `selectLane` restored as the rail's and the strip's shared in-place switch; the stored active lane still restores the view being read); `MissionTabs` loses its dot; the room's strip regains lane tabs under D-080's original condition (`multiLane || files || compare`), with the Mission back-tab only where no lane tabs exist to be the way back. D-085's per-view session/file memory narrows back to per-mission-tab, which is what it was. Specs keep their meaning; the strip's regained lane tabs are unpinned per the standing no-tests call, and PROGRESS says so.

**Revisit when.** A third level of tab (sessions) is asked for by name — the rail already holds them, and the strip should not grow species faster than the eye can tell apart.

## D-087 — Sessions join the working row: open side by side, closable, first one anchored

**Context.** D-086 settled the two levels — missions on top, the mission's working row beneath: approach tabs, Compare, files. Sessions stayed rail rows only, one conversation on the canvas at a time with no way to hold several open or put one away. The owner then asked for exactly the third species D-086's revisit clause anticipated by name: sessions open side by side in an approach, with the ability to close them.

**Decision.** The working row gains **one tab per open session of the selected approach**, between the approach tabs and Compare: the conversation glyph and the session's first-words title — no lane dot, because a session tab sits under its approach's own dotted tab and colour belongs to approaches. The open set is explicit and per mission tab: a session opens from its rail-tree row (or by being created words-first), closes from its tab's `×`, and the **lane's first session is the anchor** — always present while session chrome shows, never closable, the way back when everything else is put away. Closing the session being read falls back to the anchor; closing never touches the conversation itself — the rail's tree still lists every session, open or not, with its attention words. The set survives a relaunch beside the selected session, and returning to a lane restores the tabs it had open. This resurrects D-083's session-tab mechanics, deleted by D-084, into D-086's strip — the tree remains the structure, the strip remains the quick hand.

**Alternatives.** Every session always a tab (rejected: the owner asked to *open* and *close* — an inventory that cannot be put away is the tab soup the tree replaced); session tabs wearing lane dots (rejected: they sit beneath their approach's dotted tab, and a second dot per tab makes the colour mean less); closing the anchor too (rejected: a strip whose last session closes strands the canvas, and the first conversation is the lane's own way back).

**Consequences.** `working-set` regains `openSessionIds`, `openSession`, `closeSession`, and their persistence — with their unit coverage restored, since the gate runs it; the rail's session rows open rather than only select; the room renders the third tab species with the D-083 glyph and the never-truncate attention words; the Mission back-tab appears only where no lane and no session tabs exist to be the way back. The e2e specs keep their meaning and the tab interactions stay unpinned per the standing no-tests call, recorded in PROGRESS.

**Revisit when.** Sessions from *different* approaches are wanted open at once — which is two lane tabs away today, and side-by-side panes, not more tabs, if it ever means simultaneously.

## D-088 — Session tabs wear their approach's colour, stay open across lanes, and move by hand

**Context.** With sessions on the working row (D-087), the owner named three gaps on sight: a session tab carried no mark of the approach it belongs to, so "part of that" was invisible; switching to another approach hid the tabs he had open, when they should stay side by side like anything else he opened; and the row's order was fixed, where he wants to arrange it. He also flagged the craft: tab content sits off-centre.

**Decision.** D-087 amended in three ways, and one repair.

- **The dot extends to session tabs.** Each session tab leads with its approach's identity dot — blue under the lane the mission started with, amber under an alternative — the same token pair, still identity and never quality. D-087 withheld the dot because a session sat under its own approach's tab; once tabs from several approaches share the row, the colour is what says whose each is.
- **Open is open, whatever lane is showing.** The open set spans the mission: switching approaches hides nothing, and choosing a session tab from another approach moves the room to that approach and that conversation — the same rule file tabs already follow, colour and content never disagreeing. The anchor stays per selected approach: its first session is always present and never closable; every other open tab closes by hand.
- **The row is the person's order.** Open session tabs drag to reorder; the order is theirs, stored with the open set, and never rewritten by the product.
- **The repair:** tab content centres — the base tab becomes a centred flex row, and a tab without a close control regains the right padding the close was occupying, so nothing reads pushed to one side.

**Alternatives.** Grouping session tabs under their approach's tab positionally (rejected: the owner asked to arrange them himself, and a forced grouping fights the drag); hiding other lanes' session tabs behind their approach tab (rejected by the owner on sight — "don't make those files go away"); a dot only when tabs from two approaches are actually open (rejected: a mark that comes and goes as siblings open reads as the tab changing meaning — D-066's rule for project labels).

**Consequences.** `working-set` stores the order (`reorderSession`, unit-covered); the room sources session tabs mission-wide and routes a foreign lane's tab through the same lane-jump file tabs use; the strip's base tab is a centred flex row, which also fixes the lane tabs' dot alignment. E2e stays unpinned on the new interactions per the standing no-tests call, recorded in PROGRESS.

**Revisit when.** Reordering is wanted for file tabs too — the same stored-order shape lifts; or dragging between levels (a session onto another approach) is asked for, which is a product act, not a reorder.

## D-089 — An approach lands on its overview, and only the person opens tabs

**Context.** Three faults on sight of D-088. Clicking an approach tab dropped the reader into its first session's transcript, where the owner wanted a landing: "a brief on what this is doing and the list of chats which I can click to open" — the approach as a page of linked conversations, the way Notion links pages. Switching approaches conjured the new lane's first session into the tab row uninvited — the anchor rule swapping tabs nobody touched. And dragging a tab did nothing at all: Chromium will not start an HTML5 drag when the press lands on a child button unless the wrapper opts in with `-webkit-user-drag: element`.

**Decision.**

- **The approach tab is a page, not a shortcut.** Selecting an approach with more than one conversation lands on its **overview**: the intent (or that it is the work the mission started with), one quiet line of its own facts — conversations, files changed, checks — and the list of its sessions, each row a link that opens that conversation as a tab. A lane with one conversation keeps landing in it directly: the ordinary mission gains no page between a person and the words.
- **No implicit tabs.** The anchor is gone. The row holds exactly the sessions a person opened, in their order, whatever approach is showing; switching lanes adds nothing, removes nothing, and swaps nothing. Every session tab closes, and closing the one being read falls back to its approach's overview — which is now the way back, so nothing needs to be unclosable.
- **The drag works.** The wrapper declares `-webkit-user-drag: element` and its buttons decline the drag, which is the difference between a reorder and a dead gesture — verified by driving a real drag, not by reading the code.

**Alternatives.** Keeping the first session as the landing with the overview behind a control (rejected: the owner named the landing he wants); an overview for single-conversation lanes too (rejected: a page between a person and their only conversation is ceremony); auto-opening a session's tab when its approach is selected (rejected by name — "don't do that unless I do it myself").

**Consequences.** `sessionId: null` on a tab now means the approach's overview where the lane holds several conversations, and the conversation itself where it holds one; the working set is untouched — the anchor was always a rendering rule. The sessions spec's tab counts are rewritten under this entry (creation opens exactly the one tab it made). The overview is composed from data the room already holds; nothing new is fetched.

**Revisit when.** The overview wants evidence beyond the lane's own facts — at which point it is growing into the Compare column for one lane, and reusing that shape beats growing a second.

## D-090 — Tabs reorder under the hand, not under the drop

**Context.** D-089's drag passed its driven probe and still did nothing under the owner's own mouse. Two admissions in that sentence. First, the probe drove Chromium's debug protocol, which synthesizes a drag more willingly than macOS delivers one — it proved the handlers reachable, not the gesture usable. Second, the shipped gesture demanded precision no one owed it: nothing moved while dragging, and the reorder happened only if the release landed exactly on another session tab. And the owner's "let me move them around" had named the *file* tabs in the first place, which could not be dragged at all.

**Decision.**

- **The reorder happens during the drag, not at the drop.** While a tab is in hand, crossing a sibling past its midpoint moves the tab there at once, the way every browser's own tab strip behaves: the tabs shifting *are* the feedback, and the release needs no aim — wherever the hand lets go, the order is already what the drag made it. The whole working row accepts the release, so letting go over a gap or another species' tab ends the gesture where it stands instead of animating a snap-back.
- **File tabs drag the same way.** Sessions reorder among sessions, files among files, each in the person's own order; the species never interleave.
- **The dragged tab is known by a ref, not by the payload.** Chromium hides a drag's data until the drop, so live reordering carries the dragged id in component state set at dragstart and cleared at dragend; the dataTransfer payload remains for the drop's own bookkeeping.

**Alternatives.** Keeping drop-targeting and adding an insertion indicator (rejected: an indicator is instruction for a gesture that should need none); pointer-event tracking instead of HTML5 drag (kept in reserve — it is the escape hatch if native drag initiation itself proves unreliable on a child button under a real mouse).

**Consequences.** A reorder is applied and persisted continuously while dragging; an abandoned drag leaves the order wherever it was last carried, which is what the hand said. Verification is owed honestly: the synthesized-input probe was retired as evidence for gestures, the deterministic suites stay green, and the gesture itself is proven only by a person's hand on the running build — recorded in PROGRESS as exactly that.

**Revisit when.** A real hand still cannot lift the tab — then the reserve applies: pointer-tracked reordering with no HTML5 drag at all.

## D-091 — Presence is a projection over the participant's own read

**Context.** PRODUCT.md has always required per-participant connection state — connected, reconnecting, offline — and DESIGN.md has always had the rendering rule waiting for it (dim to 40%, never disappear). The 2026-08-08 multiplayer-UI audit recorded the gap plainly: the `Participant` view carried no connection field, so the rule had nothing to render. Meanwhile the product already had two liveness mechanisms, both projections over a last-seen time: the runner's (its polling) and the lease's (the holder's read of the mission).

**Decision.**

- **The signal is the participant's own read of the mission** — the same read that is already the lease heartbeat, throttled to one write per ten seconds onto a `last_seen_at` column on the participant row. No new verb, no client change: a client that is in the room is polling, and a client that is polling is present.
- **The state is projected at read time, never stored as a word:** connected while seen within 30 seconds, reconnecting to 90 seconds — the same recovery window after which the runner sweep declares a machine gone, applied to a person's machine for the same reason — offline past it, and offline for a participant who has never read the mission at all, because never-arrived and departed are equally absent.
- **Presence stays out of the record.** The column is overwritten in place; no event, no receipt, no history. ARCHITECTURE.md's "presence lives in memory only" is amended to say exactly this: ephemeral in meaning, one timestamp of storage because a projection needs somewhere to read from.

**Alternatives.** An in-memory map in the control plane (rejected: a restart would flicker every participant to offline for no reason a user could see, and a second source of truth grows sideways); client-declared presence over a new verb (rejected: self-reporting is the one liveness signal that can lie); reusing the 30-minute lease TTL thresholds (rejected: presence distinguishes seconds, the lease distinguishes minutes — one number cannot serve both).

**Consequences.** `ParticipantSchema` gains a required `connection` field, so every fixture and client states it. The Overview list dims disconnected people to 40% with the state in words. A viewer reading the room is connected by construction — their read is the signal. Two clients comparing rooms agree on presence only after both have polled, which the two-client suite now does before comparing.

**Revisit when.** The control plane runs as more than one instance (the column already survives that; the throttle window may need tightening), or presence wants focus/typing, which this column deliberately cannot carry.

## D-092 — A handoff offer expires in ten minutes, and says so

**Context.** PRODUCT.md's HandoffOffer state machine has carried `expired` (TTL) from the start, ARCHITECTURE.md's row said "state, TTL", and DESIGN.md's *Handoff offered* overlay asks for an expiry countdown as text. None of it was real: `HandoffOfferSchema` had no expiry field, no sweep moved an offer, and an unanswered offer held the workstream's one live-offer slot forever — the 2026-08-08 audit's finding.

**Decision.**

- **Ten minutes.** An open offer is an interactive ask — "will you take this?" — not a durable grant. Ten minutes unanswered means the recipient is not there, and the controller deserves the slot back.
- **Only `open` expires.** An accepted offer is a durable grant that survives disconnection and completes at the boundary however long that takes (PRODUCT.md#control); expiring it would contradict the sentence that defines it.
- **Expiry is the offer's own fact, not the sweep's schedule.** `expires_at` is set at creation, carried on the wire, enforced twice: the reliability sweep lapses an overdue open offer (`control.offer_expired`, event-recorded so the controller learns it rather than finding the room silently reset), and the accept route refuses a lapsed offer the sweep has not reached yet.
- **The countdown is words in the meta style** — "expires in 7m", seconds under the last minute, nothing once past expiry (the feed's expired line takes over). Its cadence is the room's poll; it is a rough count-down, not a ticking clock.

**Alternatives.** No TTL, slot freed only by withdraw (rejected: it is the audited bug); expiring accepted offers too (rejected above); a shorter TTL like the 90-second recovery window (rejected: an offer can reasonably wait out a coffee; authority is not lost by it, only an unanswered question is).

**Consequences.** Rows created before the column read as `created_at` plus the TTL in every projection, so no offer reaches the wire without an expiry. `ControlRequest`'s own `expired` state remains unimplemented — a request is a standing ask the controller is meant to see whenever they look, and nothing in this decision starts its clock.

**Revisit when.** Real usage shows offers lapsing under people answering slowly on purpose — the number is a judgment, not a measurement.

## D-093 — The needs-attention row names the lane and the conversation

**Context.** Since the mission list's state became a per-lane projection (2026-08-08), the rail's lens surfaces a mission whose background lane waits on a person — but the row named only the mission. PROGRESS's Known gaps recorded the rest: the lane and the conversation were unnamed, opening the mission landed wherever the tab last was, and the tree's "· needs you" had to point the rest of the way.

**Decision.**

- **The list projection says where.** When a lane's attention-demanding state decides the mission's word, the same projection that decided it also names it: the lane's id and name, and — where the attention is an execution's fact (needs approval, needs direction, interrupted) — the conversation that execution belongs to, with its title. A failed workspace or failed verification is the lane's fact and names no conversation.
- **`Mission.attention` is the wire shape**, null whenever the mission demands nothing, null in the room's own detail response where the rail tree already points at the row itself. It rides the one lateral join the list query already makes for the lane's latest execution, so naming costs no second query.
- **The lens row renders it beneath the goal** in the meta style: the lane's name only while the mission holds more than one, the conversation's title when it has one — a one-lane mission whose only conversation is untitled has nothing further to name, and its row stays one line.

**Alternatives.** Deriving the location client-side from fetched details (rejected: the lens works from the list alone after a reconnect, and a detail-dependent name would appear and disappear); naming the session on workspace failures too (rejected: attributing a lane's infrastructure failure to whichever conversation last ran would be a small lie).

**Consequences.** Opening the row still lands on the lane the tab last read — the row now names the destination, and landing *on* the named conversation is deliberately left for the day the working set takes an "open at" instruction; PROGRESS keeps that honest. `MissionSchema` gains a required nullable `attention`, so builders and fixtures state it.

**Revisit when.** Sessions gain their own needs-attention states beyond the lane's (D-083 declined this), or the lens is asked to show more than one blocked lane per mission — the projection names the first in creation order, which is the precedence rule, not a ranking.

## D-094 — Every chat answers "what are you doing?" without being opened

**Context.** D-083 gave a lane parallel conversations and D-084–D-090 gave them rows and tabs, but a background chat said nothing about itself unless it was blocked ("· needs you"). Choosing where to type in a three-chat approach meant opening each one. The owner's Phase 2 direction names the felt problem: chats should read as a shared workspace, not as queued conversations — which begins with each one saying what it is doing, what it has touched, and when two of them are on the same ground.

**Decision.**

- **Four states, one word each, precedence by what a person must act on:** `needs you` (its turn is blocked — the existing warn-toned words, unchanged), `working` (its turn is live), `queued · {n}` (direction waiting for the shared workspace), and idle — which renders nothing, because ten quiet chats each announcing "idle" is apparatus. The words appear on the tree row, the session tab, and the overview link; the *selected* chat's row says nothing, its state being the room's state line. Warn tone only for needs-you; working and queued recede to `--text-3`.
- **A chat's footprint is what its turns committed.** Per-chat changed files are derived from checkpoints through the executions that belong to the chat — git's account, latest checkpoint winning per path — and rendered as `{n} files` on the overview link, with `last heard {time}` beside a working chat so "working" carries its freshness.
- **Overlap is warned from evidence, never predicted.** When two chats' checkpoint histories have changed the same file, the approach overview says so in one warn-toned sentence — the chats and the path, further overlapping files counted quietly. Nothing guesses what a direction *might* touch: a warning that can cry wolf teaches people to ignore the one that matters.

**Alternatives.** Predictive conflict detection from direction text or live tool activity (rejected: unverifiable claims in a product whose whole culture is evidence); a per-chat state dot (prohibited — status is words, DESIGN.md#status-semantics); announcing idle (rejected as noise); filtering the evidence panel's file tree per chat (rejected: the worktree is genuinely shared, and a filtered tree would say otherwise).

**Consequences.** `sessionActivity`, `sessionChangedFiles`, and `contestedAcrossSessions` are renderer derivations over the detail payload the room already polls — no contract change, no new fetch. The overlap sentence is also the groundwork for the concurrency slice: "serialize or confirm when edits conflict" needs exactly these facts.

**Revisit when.** Simultaneous execution inside one approach is attempted — that is its own slice, it reverses D-083's deliberate "one live turn per lane," and it must answer the checkpoint-attribution problem (a second writer in one worktree makes `captureCheckpoint`'s whole-tree commit attribute one chat's half-done edits to another) before any scheduler work begins.

## D-095 — A chat can run alongside the workspace's turn, read-only

**Context.** D-083 made the workspace take turns: one live execution per lane, every sibling chat's direction queueing behind it. Correct for writes — one worktree has one git index, and checkpoint capture commits the whole tree, so a second simultaneous writer would record one chat's half-done edits as another's evidence — but it made every conversation feel like a queue, which the owner's Phase 2 direction named as the thing to fix. The requirements as stated ("same worktree" and "simultaneous execution") are contradictory for writers; this decision resolves the tension at the only honest line there is.

**Decision.**

- **Writes stay exclusive; reads run alongside.** An execution carries `access: write | read`. The lane's partial unique index now guards write executions only, and a new per-session index guards one turn per conversation whatever its access — a session's turns share one harness transcript, and two at once would fork it.
- **Alongside is the baton holder's act.** Sending in a chat while another chat's write turn runs asks the controller once, inline in the composer: Queue (the default), or Run alongside · read-only. It spends the host machine's quota exactly as immediate dispatch does, and quota is what the baton already gates; anyone else's direction queues exactly as before. A question gone moot — the running turn ended while it was on screen — submits the ordinary way rather than swallowing the click (the sessions spec caught the swallow through the poll's two-second lag).
- **A read turn may look and speak, never act.** Every permission request it raises is denied at the runner the moment it arrives, with the reason on the harness's own channel — no card, no waiting, no baton involvement. It captures no checkpoint: committing the worktree mid-write-turn would be the exact fabrication that keeps writes exclusive. It declares no boundary from any source, and the control plane refuses one that arrives anyway — a waiting handoff must never complete on a read turn's word while the write turn is mid-tool-call.
- **The workspace's story stays the write turn's.** Lane and list state, the stall overlay, turn-taking dispatch, and idle-transfer checks all read write executions only; a read turn's liveness is its own chat's `working` word (D-094). Its completion still nudges the dispatcher, because a direction deferred behind its own chat's answer is waiting on exactly that moment — and the dispatcher re-checks everything, so the nudge can never start a second writer.
- **Stop names the conversation.** With two live turns in a lane, the wire carries the session: the state line's Stop still means the workspace's turn, and the chat answering read-only carries its own quiet Stop while on screen. The runner's active-turn map is keyed by execution now — workstream keying would let the second turn overwrite the first, and a stop or an approval answer would find the wrong turn.

**Alternatives.** Per-chat worktrees, Conductor's shape (rejected: the owner's constraint is one branch, one worktree per approach — that identity is the product); two writers with tool-event-attributed checkpoints (rejected: bash writes files no tool event names; unattributable evidence is fabricated evidence); session kinds chosen at creation ("review chat") (rejected: sessions are words-first, and the read/write question belongs to the moment of sending, not the chat's identity); auto-running alongside without asking (rejected: it spends quota and changes what "send" means — the person chooses).

**Consequences.** `ExecutionSchema.access` is required, so every fixture states it. A read turn advances its chat's harness session — the next write turn of that chat remembers the conversation, which is the point. The fake harness honors the deny path, so the whole story is provable deterministically: `alongside.test.ts` (dispatch, refusals, state, stop, boundary), `execution.test.ts` (deny-at-machine, no checkpoint, no boundary), and the approval spec's in-window run (a read turn answered beside a blocked write turn, one card, the file only after approval).

**Revisit when.** A non-controller wants a read turn (the baton gate is a quota judgment, not a safety one — the safety is the deny policy); or read turns want tools beyond the CLI's default-allowed reads, at which point the deny list becomes a policy surface rather than a constant.

## D-096 — A check is attributed to the chat whose checkpoint it ran at

**Context.** Checks are lane evidence: they run in the approach's one worktree and bind to the revision they proved (D-043, D-082). With several chats sharing that worktree, the owner asked for per-chat verification — "which chat produced which evidence." The naïve reading is a lie waiting to be recorded: Novus does not know which tests cover which files, and the worktree at any revision holds **every** chat's work so far, so "chat A's tests passed" would claim a scope no run ever had. D-083 declined per-session verification outright; this decision does the honest half of it.

**Decision.**

- **Attribution by trigger, never by content.** Every check already pins the revision it proved; every checkpoint belongs to one turn and every turn to one conversation. The join — check → `checkpointSha` → checkpoint → execution → session — names the chat *at whose checkpoint* the check ran. That sentence is the ceiling of what is knowable, and the words on screen say exactly it.
- **A renderer derivation, no wire change.** `sessionOfCheck` / `sessionChecks` compute the join from the payload the room already holds. Checks still *run* as lane evidence against the shared worktree — readiness, staleness, and re-running are untouched.
- **Two surfaces.** The approach overview's chat rows gain `{p}/{n} checks at its checkpoints`; the evidence ledger's provenance line gains `· "{title}"'s checkpoint` while the lane holds more than one conversation. A check with no recorded revision, or one whose revision no checkpoint claims, is attributed to nobody rather than to a guess.

**Alternatives.** Content-based attribution — mapping test files to changed files (rejected: Novus cannot know a project's coverage topology, and a wrong attribution is fabricated evidence); running checks in per-chat sandboxes at the chat's own revision (rejected: that is per-chat worktrees through the back door, and D-095 just drew that line); tagging checks with a session id on the wire (rejected for now: the revision join derives it losslessly, and a stored duplicate can drift).

**Consequences.** An automatic check (D-082) lands at the checkpoint that triggered it, so it reads as that chat's row — which is the intuition the owner named, made true by construction. A participant-run check attributes to whichever chat's checkpoint the worktree stood at, which is honest even when surprising. "Screenshot: captured"-style visual evidence stays out of scope until the artifact store (D-022) exists.

**Revisit when.** CI ingestion arrives (external checks bind to commits, so the same join works — but their revisions may be merge commits no checkpoint claims), or a project declares which checks cover which paths, at which point content-scoped attribution stops being a guess.
