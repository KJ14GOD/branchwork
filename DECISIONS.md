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
