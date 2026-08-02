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
