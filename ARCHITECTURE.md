Purpose: Defines how Novus is built: the three planes, trust boundaries, data and event representation, the runner and harness protocols, workspace lifecycle, authentication and authorization enforcement, persistence, failure handling, deployment, observability, and testing. Concepts used here are defined in PRODUCT.md; this document defines their representation and mechanics only.
Authoritative for: system decomposition, trust and security boundaries, data model representation, event schema, runner protocol, harness adapter contract, workspace lifecycle mechanics, control-transfer mechanics, authentication and session mechanics, authorization enforcement, secret handling, persistence and retention, failure handling, deployment modes, observability, testing strategy.
Not authoritative for: what domain objects and lifecycle states mean (PRODUCT.md), how states are presented (DESIGN.md), current implementation status (PROGRESS.md), vendor selections (DECISIONS.md).
Update when: a protocol message, schema, boundary, or mechanism changes; when PRODUCT.md adds or renames a domain object or lifecycle state (same change); when a vendor decision lands in DECISIONS.md.
Last reviewed: 2026-08-01

# Architecture

## The three planes

Novus is three planes with three trust levels. The planes are an isolation contract, not a deployment diagram — two planes may share a process in development and must still respect the boundary.

- **Control plane** — the durable collaborative product state: identity, organizations, missions, participants, capabilities, leases, direction, events, receipts, PR state. It is the only party trusted with org-wide state. It stores, relays, and authorizes. It **never executes**: no repository code, no harness binaries, no user-supplied commands, no git operations against customer code. If the control plane ever runs customer code, the isolation story is dead.
- **Runner plane** — repositories, harnesses, commands, tests, and execution. A runner is **semi-trusted at best**: it executes model-generated code, so every runner is treated as potentially compromised from the moment an execution starts. Runners receive only short-lived, mission-scoped credentials and see nothing beyond their mission.
- **Client plane** — the desktop application (and, later, browser delivery of the same client). Untrusted input, period. Clients render from server state and submit commands; they decide nothing privileged.

## Trust and security boundaries

### Secret placement

| Secret | Lives in | Never reaches |
| --- | --- | --- |
| GitHub App private key, OAuth client secrets | Control-plane secret store | Runners, clients |
| Database credentials, event-store credentials | Control plane | Runners, clients |
| Runner-token signing keys | Control plane | Runners, clients |
| Repo access token (GitHub App installation token: ~1h, repo-scoped) | Issued per workspace, held by the **runner supervisor** | The harness process's readable environment |
| Harness/provider API credential | Scoped per execution where the harness supports it | Other missions, other orgs |
| Per-project environment secrets | Injected into the workspace encrypted-at-rest, decrypted at provision | Control-plane logs, events, receipts |

### The supervisor/harness boundary

The runner supervisor (the Novus runner daemon) holds the connection token and git credentials. The harness runs as a child process in a workspace where credentials are injected **per operation** (git credential-helper / askpass shim), not written to `~/.git-credentials` or exported into environment variables. Rationale: the coding agent can read any file in its sandbox, so anything on disk or in its env is disclosed-by-default. The boundary everyone skips is the one between the supervisor's secrets and the harness's filesystem view; Novus does not skip it.

Harness account credentials on shared cloud workspaces are an explicit policy question: V0 uses org-provisioned harness credentials scoped to the execution, never a participant's personal harness login on a shared machine — participant B must not be able to exfiltrate participant A's token through the agent. Recorded as D-013 in [DECISIONS.md](DECISIONS.md).

An accepted disclosure boundary, stated so it is never a surprise: per-project environment secrets are decrypted *into* the workspace, so anyone whose direction the harness follows can cause them to be read. That is inherent to giving the agent the environment it needs; the protections above are for secrets the agent does not need.

Because those files really are in the worktree, every surface that can carry a file's name or contents out of it asks one policy before it does: checkpoint capture, evidence, and the file browser's list, read, and write. A path that looks like a credential — `.env` and its variants, registry and git credential stores, private keys, service-account files — is refused, with `.env.example` and its spellings exempt because a repository commits one to be read. The refusal is enforced in the Electron main process at the chokepoint all five routes already pass through, so a renderer asking for the path directly is refused rather than merely not offered it; there is no control-plane route and no runner command for reading a file, so a remote participant has no path to one at all. Reported text is masked for machine-local paths and then redacted of values this machine holds, including passwords harvested out of forwarded proxy configuration — the harness transcript included, which until D-052 had only the first half.

Both halves are lists and neither is detection. Path patterns recognise conventional names, not a credential someone put in `notes.txt`; redaction removes literal occurrences of values Novus was explicitly given and cannot see one it was never handed, an encoded form of one it holds, or one split across two delivery chunks. **Novus does not detect arbitrary secrets.** The controls that carry the weight are the ones above, which keep credentials out of the reported path in the first place.

### What each plane may never do

- Control plane: execute anything (above).
- Runner: see other missions' workspaces, the control-plane database, org membership beyond its mission's participant list (display names and ids only), or any long-lived secret.
- Client: originate authority. Every capability check happens server-side ([Authorization](#authorization)); the client's capability list is a rendering hint.

Runner-reported facts are **claims**. Events carry their origin; verification results are recorded as "runner X in environment Y reported…" and presented that way ([PRODUCT.md](PRODUCT.md#principles), principle 3).

## Data model

Concepts are defined in [PRODUCT.md](PRODUCT.md#domain-model); this section fixes representation, keys, and invariants only.

Identifiers are globally unique, prefixed, opaque strings with a three-letter prefix per object (`msn_`, `wst_`, `exe_`, `evt_`, `dir_`, `lea_`, `rnr_`, `cmd_`, `ckp_`, `chg_`, `chk_`, `inv_`). All rows carry `org_id`; every query is org-scoped.

| Object | Key fields and invariants |
| --- | --- |
| User | `user_id`, auth identity refs. No org data on the user row. |
| Organization | `org_id`; owns repos, missions, members, policy, GitHub App installation id. |
| OrganizationMember | (`org_id`, `user_id`), org role. |
| Repository | `repo_id`, `org_id`, GitHub repo ref, installation ref. |
| Mission | `mission_id`, `org_id`, `repo_id`, goal, success criteria, primary state (a projection over workstream states, precedence per [PRODUCT.md](PRODUCT.md#the-mission-state-model)), `receipt_id?`. Primary state transitions are events. |
| Participant | (`mission_id`, `user_id`), role. Invariant: user is an OrganizationMember (V0). |
| Invitation | `inv_id`, `mission_id`, role, expiry, single-use token hash, `redeemed_by?`. |
| Workstream | `wst_id`, `mission_id`, name, `approach_flag` (default false), `base_ref`, immutable `base_sha`, unique `mission_branch`, observed `remote_head_sha`, `workspace_id?`. One active mission branch per workstream; branch names are server-allocated and org/repo scoped. |
| Execution | `exe_id`, `wst_id`, harness id, selected model and effort, `runner_id?`, `starting_direction_id?`, state, `started_by`, created/started/ended timestamps, `harness_session_id?`, `resumed_session`, exit outcome, failure reason, `last_origin_seq`, `latest_checkpoint_sha?`. Invariant: at most one non-terminal execution per workstream (partial unique index over the non-terminal states). |
| Runner | `runner_id`, `org_id`, `mission_id`, `wst_id`, owner, kind, label, `credential_hash`, expiry, `revoked_at?`, `last_seen_at?`. Only the hash is stored. Invariant: at most one live runner per workstream (partial unique index). |
| RunnerCommand | `cmd_id`, `wst_id`, `exe_id?`, expected `runner_id`, kind, payload, `idempotency_key` (unique per workstream), ordered `seq`, lifecycle `pending → delivered → acknowledged → completed \| failed`, timestamps, failure reason. |
| Checkpoint | `ckp_id`, `exe_id`, outcome (`committed \| clean \| failed`), `sha?`, `parent_sha?`, branch, file/addition/deletion counts, withheld-secret count, uncommitted flag, `runner_id?`, environment label, error. |
| Workspace | `wsp_id`, `wst_id`, execution location, provider id, provider ref, lifecycle state, `checkout_head_sha`, `last_synced_remote_sha`, dirty-state summary, latest checkpoint ref, readiness (`unconfigured | configuring | ready | failed`), an allocated port range unique per workstream on a host, and the **declared command list** the runner last published with the time it did (D-043). The list is stored verbatim and never parsed: the control plane still does not know how to build anything. At most one active workspace per workstream; a replacement workspace keeps the workstream and branch identity. |
| ControlLease | `lease_id`, `wst_id`, `holder_user_id`, state, TTL, heartbeat timestamp. Invariant: at most one lease in `held`/`releasing` per workstream (partial unique index); transitions by compare-and-swap on `lease_id` + state. Heartbeat = the holder's authenticated client-session liveness, renewed automatically; the TTL is the grace period after the last heartbeat. |
| ControlRequest / HandoffOffer | own ids, `wst_id`, actor, state, TTL. States per [PRODUCT.md](PRODUCT.md#control). |
| Direction | `dir_id`, `org_id`, `mission_id`, `wst_id`, author, body, state, monotonic `ordinal`, `submitted_at`, `applied_at?`, `resolution_reason?`, `consumed_by_execution_id?`. Drafted is client-local and has no row. Applied is written only on runner acknowledgement. |
| Event | see [Event model](#event-model). |
| FileChange | `chg_id`, `ckp_id`, path, `previous_path?`, state (`added \| modified \| deleted \| renamed`), additions, deletions, binary and truncated flags, and a bounded unified diff. Derived from git, never from a harness-reported file list. V0 stores the bounded diff inline; the artifact store (D-022) takes it when transcripts and exports arrive (D-037). |
| VerificationCheck | `chk_id`, `mission_id`, `exe_id?`, name, category (`test \| typecheck \| build \| lint \| diagnostic`), outcome (`passed \| failed \| skipped \| errored`), origin (`harness \| participant \| external`), `requested_by?`, the sanitized command, exit code, an `ending` (`exit \| signal \| timeout \| cancelled \| spawn_failed`), started/completed timestamps, duration, bounded redacted output, environment attribution, and the `checkpoint_sha` it proves. A check that ran out of time or was cancelled reached no verdict: its outcome is `errored` and its `ending` says which, never a pass and never a plain failure. Harness-observed checks come from a structured tool call correlated with its own tool result (D-037); participant-run checks come from a `run_verification` command the server authorized. A check is **stale** when the workstream's head has moved past its `checkpoint_sha` — derived, never stored. |
| Artifact | `art_id`, `mission_id`, kind, blob ref, origin attribution. |
| Review | `rev_id`, `mission_id`, author, kind (comment / revision-request / acceptance), body, refs. |
| PullRequest | `pr_id`, `mission_id`, GitHub ref, tracked state. |
| Receipt | `rcp_id`, `mission_id`, snapshot blob + the event-log range it projects. Immutable except under D-014 redaction, which re-projects and replaces the snapshot as a recorded event; always re-derivable from current events. |

## Event model

The event log is the mission's memory and the receipt's source. If a receipt needs data that is not in events, the event schema is incomplete — fix the schema, not the receipt.

**Durable (events):** direction lifecycle, all three control machines, execution lifecycle, workspace lifecycle, repository revision observations and sync attempts/outcomes, harness activity summaries (turn boundaries, tool activity, approval requests), file-change summaries, verification outcomes, review actions, PR state changes, participant joins/role changes, receipt snapshots.

**Ephemeral (never events):** presence, typing, cursor position, live token streams. Full harness transcripts are stored as Artifacts referenced by events, not inlined per-delta into the log.

Every event carries:

```
event_id, org_id, mission_id, workstream_id?, execution_id?,
actor { kind: user | harness | runner | system | external, id },  // never ambiguous; external carries a source (github, ci)
cause { direction_id? , lease_id? , offer_id? },        // what authority it acted under
origin_seq,            // runner-assigned monotonic seq for runner-origin events
schema_version,        // per-event versioning; events are migrated forward, never rewritten
occurred_at, recorded_at
```

Ordering and idempotency: runners assign monotonic per-execution sequence numbers; the control plane persists and dedupes on (`execution_id`, `origin_seq`). Commands to runners carry idempotency keys; a retried command after a partition is applied once. Control-plane-origin events are ordered by a per-mission sequence. Reconnection resumes from the last acknowledged sequence in both directions.

Retention: org-configurable audit retention. Deletion requests are honored by **redaction** — payloads are removed, the event skeleton (id, kind, actor kind, time) remains so receipts stay structurally honest and say "redacted" rather than lying by omission. The receipt-vs-deletion tradeoff is recorded as D-014.

## Runner plane

### Connection model

**The runner always dials out.** Commands down, events up, over a connection the runner opens. Novus-managed cloud runners use the same protocol and direction as local and enterprise runners — no special cases, or there would be two protocols. The control plane never needs inbound access to any runner.

The shipped transport is **authenticated polling** (D-035): the runner asks for its own commands, acknowledges delivery, reports completion, and posts sequenced events. A persistent bidirectional stream (D-021) is the destination and changes the transport, not the semantics — idempotency keys, ordered delivery, per-execution sequence numbers, acknowledgement, and de-duplication are all defined here and carry over unchanged.

**Runner identity** (D-035). A runner registers for one workstream and receives a cryptographically random credential; the control plane stores only its SHA-256 hash, scoped to (organization, mission, workstream, runner), with an expiry and a revocation flag. Runner requests carry it under a `Runner` authentication scheme distinct from user sessions, so a session can never be mistaken for a runner and a runner can never act as a person. Only this credential may write harness-, runner-, execution-, workspace-, or verification-attributed records; the server chooses actor attribution, validates every payload against a closed union of event kinds, and bounds every field. Expired, revoked, wrong-workstream, and wrong-execution credentials are rejected by name.

Runners buffer events locally while disconnected in a bounded outbox: a monotonic per-execution sequence, retry with backoff rather than a hot loop, a flush at clean shutdown, and — on overflow — a **gap marker** event naming the dropped range, so receipts state gaps honestly rather than reading as complete.

### Runner protocol (shape, not wire format)

Commands (control plane → runner): `provision_workspace`, `sync_repository`, `checkpoint_workspace`, `start_execution`, `apply_direction`, `pause`, `resume`, `stop`, `force_interrupt`, `run_setup`, `run_command`, `stop_command`, `run_verification`, `respond_approval` (the controller's typed answer to an `approval_required` event), `report_boundary_request` (transfer pending — ack at next safe boundary), `destroy_workspace`. All carry idempotency keys. The three workspace-command kinds additionally carry the **pinned snapshot** of the command being authorized — the exact line, working directory, deadline, and digest the control plane published — and the runner executes that rather than re-reading the repository's configuration, which may have changed since (D-043); a workspace command arriving without one is refused rather than resolved. The commands realized so far are `start_execution`, `apply_direction`, `stop_execution`, `respond_approval`, `report_boundary_request`, `run_setup`, `run_command`, `stop_command`, and `run_verification`; there is deliberately **no shell command** in the protocol, so remote interactive access to a local machine is structurally absent rather than merely unauthorized (D-042); the rest are protocol surface with no implementation yet. `sync_repository` carries the expected local and remote SHAs plus the authorizing lease id; `run_verification` executes checks defined in repository-level configuration; mission success criteria may add manual confirmations, recorded as VerificationChecks attributed to the confirming participant.

Events (runner → control plane): workspace lifecycle transitions, the **declared command list** whenever the project's configuration says something different from what was last published, repository revision observations, checkpoint and sync outcomes, execution lifecycle transitions, harness activity summaries, `boundary_reached`, `approval_required` (opaque harness payload passed through), file-change summaries, process start / readiness / exit, verification outcomes, heartbeats, gap markers. There is no heartbeat *verb*: a runner's liveness is a side effect of the authenticated polling it already does, and the control plane's sweep reads the last-seen time that polling maintains.

The protocol is versioned from day one; version negotiation happens at connection time.

### Execution providers and workspace lifecycle

Novus does not build a microVM platform first. An **execution provider** is an adapter that can provision isolated workspaces on some substrate (Novus-managed cloud sandbox in V0; a customer VM, a third-party sandbox service, or an enterprise runner later). The provider interface owns only lifecycle; the control plane owns the state machine:

`requested → provisioning → ready → active → suspended → destroyed`, with `failed` reachable from any non-terminal state and carrying the provider's error verbatim. Retry after `failed` provisions a **new** workspace; there is no silent reuse. Providers report transitions; they never invent states.

Workspace contents at `ready`: repository checkout on a mission branch, dependency setup per repo configuration, scoped credentials via the supervisor boundary, harness installed. Network policy: egress restricted to an org-configurable allowlist (package registries, the repo host, the harness's model endpoint) — default-deny is the goal, default-logged is the V0 floor (D-015).

### Workspace configuration, environments, and processes

Configuration is two TOML files under `.novus/` in the repository (D-040): `settings.toml`, committed and non-secret, and `settings.local.toml`, gitignored and machine-local, layered over it key by key. The control plane never parses either; they describe how to build and run code, which is the runner's business and the repository's history. Novus may *propose* commands from package manifests, lockfiles, Makefile, justfile, Taskfile, development documentation, `.env.example` variants, and `.worktreeinclude` — a proposal is never executed without an explicit human confirmation that writes it to one of the two files.

**Local files.** A worktree holds tracked files only, so a project needing an ignored file is unprepared until a human supplies it. Preparation is explicit and bounded: only paths Git confirms are ignored, only after consent, never dependency directories or build output, rejecting any path that escapes the source repository or the destination worktree and any symlink resolving outside it, preserving safe permissions, and never entering a checkpoint, diff, event, transcript, screenshot, receipt, or log. The renderer and the control plane see filenames; contents stay on the machine.

**Three environments** (D-041), constructed explicitly, none inheriting the parent wholesale: the harness process gets a minimal base plus its own credential path and no project secrets; project commands get a minimal base, Novus workspace variables, shared settings, machine-local settings, and only explicitly selected secrets, and never the harness credential; an interactive terminal gets the project environment plus the user's own shell profile. Novus variables are `NOVUS_WORKSPACE_ID`, `NOVUS_MISSION_BRANCH`, `NOVUS_PORT`, `NOVUS_PORT_RANGE_START`, `NOVUS_PORT_RANGE_END`; `NOVUS_WORKSPACE_DIR` is set for the terminal only, because an absolute path is a fact about a laptop.

**Process supervision** lives in the runner, never the renderer. Setup commands are finite; run commands are long-lived; verification commands are finite and cancellable; terminals are PTY-backed. Every process is spawned into its own process group so stop, restart, and application shutdown reach the whole tree. Output is bounded and redacted before it can become shared evidence, and kept locally afterwards so a process that ended is still inspectable. Ports are allocated as a persisted per-workstream range so two workstreams on one host never collide. Nothing runs in the user's original checkout. After a relaunch the runner reports what is actually true — a recorded process is not presented as running unless the operating system still has it, and a process identifier recorded before the machine last booted is never signalled, because by then it may belong to somebody else.

**Deadlines** are the project's, stated in its configuration and bounded by validation (D-043): a default for setup and for verification, an optional per-command override, and a documented maximum. A finite command that passes its deadline is terminated with its whole process tree and reported as **timed out**, which is a different ending from a non-zero exit, a signal, a cancellation, and a failure to start. A run command has no deadline; neither does a coding-agent execution, which does not use this supervisor at all (D-034).

**Readiness** is declared, never inferred (D-045). A run command may name an `http` health URL or a `port` to probe, with its own deadline and an explicit `stopOnFailure`. Until the signal answers the process is `starting`; when it answers it is `running`; when the deadline passes it is `unreachable` and still running. Novus stops a process for a failed health check only when the project asked it to.

**Secret values** are supplied on the machine that has them, through local IPC that the control plane has no route to (D-044). Novus refuses to hold a value shorter than the length it can reliably remove from command output, and refuses outright on a machine whose operating system offers no credential encryption — a plaintext secret on disk is worse than an unprepared workspace, and unprepared is a state the product knows how to say. Nothing reads a value back: the renderer learns a name and whether it is supplied.

**Local previews** open through a narrow bridge: `http`/`https` only, a literal loopback hostname, no credentials in the authority, no control characters, and only an address a live process of that workstream actually reported. The URL is rebuilt from validated components and handed to the operating system's external-browser API. No shell command is involved (D-045).

### Repository and workspace synchronization

Git is the revision protocol between execution locations; it is not a claim that their filesystems are continuously identical. The control plane owns branch identity and expected revisions, the runner owns the checked-out working tree, and GitHub is V0's remote exchange boundary.

Provisioning contract:

1. The control plane resolves the requested base ref to an exact commit through the GitHub App and stores immutable `base_sha`.
2. It allocates one repository-unique mission branch for the workstream and creates it at `base_sha` with a compare-and-set request. Repeating the command is idempotent only when the existing branch points to the expected SHA.
3. The provider receives a short-lived, repository-scoped credential through the supervisor, checks out that branch, and reports `checkout_head_sha` and dirty state. The harness never receives the GitHub credential.
4. The workspace becomes `ready` only when the reported revision matches the control plane's expected branch head and repository setup succeeds.

Checkpoint contract:

- The runner snapshots the Git diff and repository metadata at each safe turn boundary, before suspension, and at execution termination. Diff content is stored as a mission-scoped artifact; its digest and the workspace/remote SHAs are durable events.
- A successful execution boundary with repository changes produces an attributed checkpoint commit and pushes it to the mission branch with an expected-old-SHA guard; a clean boundary records the unchanged revision without manufacturing a commit. The control plane advances `remote_head_sha` only from the observed GitHub result, never from the runner's claim alone.
- A destroyed workspace is reconstructed from the mission branch plus the latest verified checkpoint artifact when the artifact is newer than the published branch. Provider pause/resume is an optimization, not durability.

Inbound-update contract:

- GitHub webhooks and a pre-direction remote-head check detect movement of either the mission branch or its base. Detection emits `repository.update_available`; it never mutates the workspace.
- `workspace.sync` is controller-authorized and executes only at a runner-declared safe boundary. The command includes expected `checkout_head_sha`, expected `remote_head_sha`, and the target remote SHA so stale clients cannot synchronize a different revision than the one they reviewed.
- A clean, explicitly approved fast-forward records its actor and resulting SHA. Novus never silently rebases or merges. Divergence, force-push, dirty overlap, or conflicts emit `repository.sync_failed` with both SHAs and conflicting paths; the workspace remains inspectable and further direction may be queued.
- Uncommitted files in a developer checkout are outside the cloud runner's knowledge. A future local mirror uses a normal checkout of the mission branch and the same remote-head protocol; it does not introduce a second file-sync protocol.

Conformance tests cover idempotent branch creation, stale-SHA rejection, remote movement during a turn, clean explicit fast-forward, dirty divergence, force-push, checkpoint-before-suspend, provider loss and reconstruction, and two humans attempting sync concurrently.

**Local execution (D-032, the runner in embryo).** The desktop main process is the first runner: it keeps one worktree per mission created from the mission branch (the user's checkout is never touched), runs one direction as one headless harness turn under the user's own local harness login, parses the stream into `harness.*` events, and checkpoints changes as attributed commits at the turn boundary. Everything it tells the control plane arrives through the reported-events endpoint with the actor forced server-side — claims from the machine that ran the work, exactly the trust posture the runner protocol will formalize. Direction submissions and reported activity are the same append-only mission events the receipt projects.

The **repository provider boundary** (D-031) carries the control-plane side of this contract: `listRepositories`, `resolveBase(ref) → exact SHA`, and idempotent `ensureBranch(branch, fromSha)` — succeeding when the branch already exists at the expected SHA, failing with a named conflict when it exists elsewhere. Repository identity is the provider's stable id, never the name. The live implementation is the GitHub App adapter; a deterministic fake (including a transiently failing repository for retry paths) exercises the identical interface, and an unconfigured deployment refuses with a named error rather than degrading. Mission creation is end-to-end idempotent via a client-supplied creation key enforced by a unique index, so retried or duplicate submissions can never mint a second mission or branch; branch outcomes (`pending → created | failed`, with retry) are durable workstream state and events, never inferred.

### Control-transfer mechanics

[PRODUCT.md](PRODUCT.md#control) defines the states; the mechanics are: the control plane marks the lease `releasing` and sends `report_boundary_request`; the runner acks at the next safe boundary (`boundary_reached`); the control plane completes the transfer by compare-and-swap and emits the events. When the workstream has no non-terminal execution it is already at a boundary: the transfer completes control-plane-side with no runner round-trip. Timeout without a boundary → the stall is visible, `force_interrupt` becomes available to the lease holder or Mission Admin, and its use is a logged event. An un-acked transfer past its timeout reverts visibly; it never half-applies.

## Harness protocol

The adapter lives on the runner. It speaks the harness's native interface inward (CLI stream, ACP, whatever the harness offers) and the Novus runner protocol outward.

**Normalizable (the adapter contract requires):** start/stop; direction in (text with attribution context); event stream out — assistant summaries, tool activity, turn boundaries; exit status; diff extraction **via git**, never via harness-reported file lists.

**Not normalizable (passed through, never faked):**
- *Approval prompts*: a first-class approval event and a typed response channel. Novus routes it to the lease holder; it does not flatten harness permission models to a lowest common denominator. **Implemented for Claude Code** (D-062) over its stdio control protocol: the CLI is run with `--input-format stream-json --permission-prompt-tool stdio`, writes a `control_request` and blocks, and Novus answers on stdin. The payload is *not* passed through opaquely — the raw tool input is read and dropped on the machine that read it, and what becomes durable is a bounded, path-masked, value-redacted summary composed from named fields, because a `Write` carries the whole file in its input and a durable row is shown to every participant.
  The permission policy is **pinned by Novus, not inherited from the host**: `--setting-sources ""` and `--permission-mode manual`, so a `.claude/settings.json` in the worktree cannot decide what gets asked. The decisive reason is that the agent can write that file — a supervised turn that creates one grants itself standing permission for the next. The measured cost is that the repository's `CLAUDE.md` no longer loads; the remedy is `--append-system-prompt-file`, and it is not built yet.
  A pending approval **is** a safe execution boundary ([PRODUCT.md](PRODUCT.md#control)), declared by the runner when it asks. Without that, a control handoff accepted while the harness is blocked waits for a boundary that can never arrive, since a turn blocked on stdin never exits.
- *Pause/resume and session continuity*: harness-dependent. Where a harness cannot resume, "pause" degrades to stop-at-boundary + restart-with-context, and the adapter declares which semantics it provides. The product never promises uniform pause behavior ([PRODUCT.md](PRODUCT.md#the-harness-boundary)).
- *Mid-turn steering*: adapters declare `steer: mid-turn | at-boundary`. Direction "Applied" is control-plane state marked on harness acknowledgment, per [PRODUCT.md](PRODUCT.md#direction).
- *Token/cost reporting*: opaque optional metadata in V0. Nothing is billed from it.

Adapters declare a capability manifest (steer granularity, resume support, approval model, verification hooks) at registration; the control plane and clients render from the manifest instead of assuming. The manifest is re-validated at every execution start — a harness auto-update that breaks an adapter fails the start with a named error rather than producing undefined behavior.

## GitHub ingestion

The control plane ingests GitHub App webhooks — pull-request state, reviews, check runs — and normalizes them into mission events with `actor.kind: external`. This is data ingestion, not execution: payloads are parsed and recorded; nothing runs. CI check results arrive this way and are recorded as evidence claims attributed to the CI environment, exactly as runner-reported verification is attributed to its runner. Polling is the fallback when webhook delivery lapses.

## Authentication

- Users authenticate to the control plane; sessions are server-side with revocation (httpOnly cookie for browser, secure token store for desktop). Identity is GitHub OAuth with first-party sessions (D-019); the database stores only a hash of the session token.
- **Desktop sign-in flow (D-027):** the desktop app asks the control plane to start a flow, opens the authorization URL in the system browser, and polls a single-use claim endpoint keyed by the flow's state nonce. The browser leg completes at a control-plane callback; the claim hands the session token to the Electron main process exactly once. The token lives only in the main process — encrypted at rest with OS-backed storage (`safeStorage`), never written in plaintext, and never crossing the IPC bridge to the renderer.
- **GitHub access is two distinct things, never conflated:** a **GitHub App installation** (org admin installs; repo-scoped; mints short-lived installation tokens for runners) provides machine access to repositories. **User OAuth** provides identity and attributes human PR actions where desired. App = machine access; OAuth = who you are.
- Invitations: single-use, expiring, mission-scoped tokens; redemption requires an authenticated user and creates the Participant row ([PRODUCT.md](PRODUCT.md#domain-model)).
- Runners authenticate with credentials scoped to (org, mission, workstream, runner), stored only as hashes, expiring and revocable (D-035). The local runner enrolls explicitly: the host desktop registers for a workstream over its owner's authenticated session and receives the credential exactly once, into the Electron main process — never the renderer, never an event payload, never a log line. Cloud runners will receive their initial credential injected at workspace creation; the verification path is the same either way.

## Authorization

Capabilities are enforced in exactly one place: a server-side check on every mutating command — including approval responses — computed per the capability model in [PRODUCT.md](PRODUCT.md#roles-and-capabilities) (role ∪ lease), evaluated against current durable state (current lease id, mission state) at command time. Lease transitions are compare-and-swap on lease id + state. Per-mission commands are serialized through a per-mission ordering point so concurrent conflicting commands (two accepts, action during lease expiry) resolve deterministically: one wins, the loser receives an explicit rejection event. UI capability lists are advisory rendering data. Any code path where the client's claim decides a privileged action is a security bug, not a style issue.

## Persistence

- One relational database owns all control-plane state, including the event log (append-only tables). Presence lives in memory/ephemeral pub-sub only.
- Artifacts (transcripts, logs, screenshots, receipt exports) live in blob storage referenced by rows; blobs inherit mission scoping and retention.
- Receipts are stored as snapshots plus the projecting event range; regeneration must be deterministic over current event state (same events → same receipt). Redaction (D-014) cascades: affected snapshots are re-projected and replaced, and the re-projection is itself a recorded event.
- Vendor selection (specific database, blob store, realtime transport) is deliberately not made here; interfaces first, vendors in DECISIONS.md at implementation time (D-012).

## Failure handling

Named failure modes with defined behavior — these are contracts, not aspirations:

1. **Runner dies mid-execution** (crash/OOM): heartbeat lapse → execution `interrupted`; mission shows it; resume-or-restart is a human choice preserved in history.
2. **Control transfer during a partition**: lease transfer is control-plane-authoritative with runner ack; un-acked transfer times out and reverts visibly.
3. **Workspace provisioning fails**: terminal `failed` state with the provider error surfaced; retry = new workspace.
4. **Direction while the harness is non-receptive**: queued durably, applied at a receptive point, superseded explicitly — never silently dropped.
5. **Simultaneous conflicting commands**: per-mission serialization; losers get explicit rejection events (see [Authorization](#authorization)).
6. **Event overflow during a long disconnect**: gap marker; the receipt states the gap.
7. **Harness hangs** (endless tool call): watchdog → execution `stalled`; `force_interrupt` available and logged.
8. **GitHub token expiry/revocation or force-push to the mission branch**: repository-sync error state with human-visible remediation; no silent retry loops and no mutation from a stale expected SHA.
9. **Controller disconnects and does not return**: lease TTL expiry → the workstream has no controller and no privileged command can be issued until someone claims or is granted the lease. The already-authorized execution keeps running (D-034); authority lapsing is not a stop signal. Claim/revoke path per [PRODUCT.md](PRODUCT.md#control).
14. **Host desktop quits during a local execution**: in-flight turns are killed with their process trees, the execution is recorded `interrupted` with the reason, and the outbox flushes before exit — no orphan process, and no room left claiming "running" forever (D-034).
10. **Control plane unavailable**: the runner continues its current execution under the last applied direction, buffers events, and refuses privileged transitions (transfers, new executions) until reconnect.
11. **Workspace suspended or destroyed while a transfer or queued direction is pending**: the offer moves to `failed` visibly; queued direction stays queued for the workstream's next workspace and execution.
12. **Mission branch or workspace conflicts with a remote update**: repository-sync error state with both revisions and conflicting paths preserved; resolving the conflict is directed work, never a silent automatic rebase or filesystem overwrite.
13. **Invitation redeemed after the mission reached a terminal state**: redemption succeeds as read access — the participant joins as Viewer and sees history and receipt; no operational verbs.

## Deployment modes

- **Shipped first**: a Novus-hosted control plane, a downloadable desktop client (D-018), and the **host desktop as the runner** — registered per workstream, credentialed, and speaking the runner protocol against local repositories (D-032, D-035). Local execution is the first real surface, not a fallback.
- **Next, on the same protocol**: Novus-managed cloud runners on one sandbox provider (D-023), which is what makes a mission survive a closed laptop and remain the multiplayer default (D-002).
- **Kept-possible by the protocol**: enterprise runner (customer infrastructure dials out) and third-party sandbox providers behind the execution-provider interface. The conformance suite ([Testing strategy](#testing-strategy)) is what keeps these honest.

## Observability

- Every protocol edge (client command, runner command, runner event) is traced with mission-scoped correlation ids.
- Control-plane metrics: command latency, event lag (runner `occurred_at` → client visibility), lease-transition outcomes, transfer-timeout rate, reconnection/backfill counts, gap-marker rate.
- The event log is itself the primary audit surface; operational logging never becomes a second source of product truth.
- No customer code, secrets, or harness transcripts in operational logs.

## Testing strategy

- **Contract tests** on the runner protocol and harness-adapter manifest: a conformance suite any runner or adapter must pass — this suite, not optimism, is what "runner-agnostic" means.
- **State-machine tests**: exhaustive transition tables for lease/request/offer, direction, mission state, workspace lifecycle — including the race cases named in PRODUCT.md (simultaneous requests, expiry during action, accept-then-disconnect).
- **Deterministic replay tests**: receipt projection over recorded event logs; same log, same receipt, byte-for-byte.
- **Integration tests** with a fake harness adapter (scripted activity, boundaries, approvals) so multiplayer flows are tested without model calls.
- **Repository-continuity tests**: branch creation from an exact SHA, checkpoint/push guards, update detection, explicit sync at a boundary, conflict preservation, and reconstruction in a replacement workspace.
- **Live proof**: the Golden V0 workflow executed by two real clients against a real deployment is the only thing that marks M1 complete ([PROGRESS.md](PROGRESS.md)); deterministic suites never substitute for it.
