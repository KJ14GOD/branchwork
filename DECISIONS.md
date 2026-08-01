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
