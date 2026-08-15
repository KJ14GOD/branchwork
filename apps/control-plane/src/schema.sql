-- Control-plane schema, V0 vertical slice.
-- Representation rules: ARCHITECTURE.md#data-model. Concepts: PRODUCT.md#domain-model.
-- Rerunnable: every statement is idempotent so `migrate` can be applied repeatedly.

create table if not exists users (
  user_id     text primary key,
  github_id   bigint not null unique,
  login       text not null,
  name        text,
  created_at  timestamptz not null default now()
);

create table if not exists organizations (
  org_id      text primary key,
  name        text not null,
  created_at  timestamptz not null default now()
);

create table if not exists organization_members (
  org_id      text not null references organizations(org_id),
  user_id     text not null references users(user_id),
  org_role    text not null check (org_role in ('owner', 'member')),
  created_at  timestamptz not null default now(),
  primary key (org_id, user_id)
);

create table if not exists sessions (
  session_id  text primary key,
  user_id     text not null references users(user_id),
  token_hash  text not null unique,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz
);

-- Desktop OAuth handshake state: one row per attempt, claimable exactly once.
-- Holds no credentials: the session token is minted at claim time (D-031 audit),
-- so an unclaimed flow row contains only the state nonce and the user it resolved to.
create table if not exists auth_flows (
  state         text primary key,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  user_id       text references users(user_id)
);
alter table auth_flows drop column if exists session_token;
-- Test-only: which deterministic identity the gated fake upstream should return.
-- Never read unless NOVUS_FAKE_GITHUB is on, which refuses production (D-027).
alter table auth_flows add column if not exists fake_login text;

create table if not exists repositories (
  repo_id           text primary key,
  org_id            text not null references organizations(org_id),
  provider          text not null,
  provider_repo_id  text not null,
  name              text not null,
  default_branch    text not null,
  connected_by      text not null references users(user_id),
  created_at        timestamptz not null default now(),
  unique (org_id, provider, provider_repo_id)
);
-- Provider set widened for local repositories (D-032); rerunnable.
alter table repositories drop constraint if exists repositories_provider_check;
alter table repositories add constraint repositories_provider_check check (provider in ('github', 'local'));

create table if not exists missions (
  mission_id        text primary key,
  org_id            text not null references organizations(org_id),
  goal              text not null,
  success_criteria  text not null,
  primary_state     text not null,
  created_by        text not null references users(user_id),
  created_at        timestamptz not null default now()
);
create index if not exists missions_by_org on missions (org_id, created_at desc);
-- Additive columns for the repository slice (schema.sql is rerunnable):
alter table missions add column if not exists repo_id text references repositories(repo_id);
alter table missions add column if not exists creation_key text;
create unique index if not exists missions_creation_key on missions (org_id, creation_key)
  where creation_key is not null;
-- Archival (D-063): filed away, not deleted. There is deliberately no delete
-- verb anywhere, so the only way a mission leaves the ordinary list is this
-- column being set, and the only way it comes back is this column being
-- cleared. Everything the mission is stays exactly where it was.
alter table missions add column if not exists archived_at timestamptz;
alter table missions add column if not exists archived_by text references users(user_id);
create index if not exists missions_active_by_org on missions (org_id, created_at desc)
  where archived_at is null;

-- A mission's presented primary state is a projection over its workstream and
-- execution state (PRODUCT.md#the-mission-state-model); the legacy column is
-- retained for existing rows and is never read as truth.

create table if not exists workstreams (
  wst_id         text primary key,
  mission_id     text not null references missions(mission_id),
  repo_id        text not null references repositories(repo_id),
  name           text not null,
  approach_flag  boolean not null default false,
  base_ref       text not null,
  base_sha       text not null check (base_sha ~ '^[0-9a-f]{40}$'),
  mission_branch text not null,
  branch_status  text not null check (branch_status in ('pending', 'created', 'failed')),
  branch_error   text,
  created_at     timestamptz not null default now()
);
-- A mission may hold several lanes: one to begin with, and a sibling for every
-- approach somebody deliberately forks (D-074). The index that made a second
-- one impossible is dropped rather than left as a comment about the past.
drop index if exists workstreams_one_per_mission;
-- What makes a fork an approach rather than a retry: a stated intent, the lane
-- it forked from, and the exact revision it forked at. Null on the lane a
-- mission starts with, required on every approach — enforced by a check so the
-- database cannot hold an approach nobody can tell apart from its sibling.
alter table workstreams add column if not exists intent text;
alter table workstreams add column if not exists forked_from_wst_id text references workstreams(wst_id);
alter table workstreams add column if not exists origin_sha text;
alter table workstreams drop constraint if exists workstreams_approach_needs_intent;
alter table workstreams add constraint workstreams_approach_needs_intent
  check (approach_flag = false or (intent is not null and length(btrim(intent)) > 0));
drop index if exists workstreams_branch_unique;
-- One branch name per repository — the invariant the audit demanded be real.
create unique index if not exists workstreams_repo_branch_unique on workstreams (repo_id, mission_branch);
-- The lane a mission starts with reads as the current work, and its name says
-- so (D-079). 'main' was a git word wearing a lane's name; idempotent because
-- nothing writes 'main' as a lane name any more.
update workstreams set name = 'Current work' where name = 'main' and approach_flag = false;
-- The harness session this workstream continues across executions. (Cited a
-- decision number that has never existed; the reason stands on its own.)
alter table workstreams add column if not exists harness_session_id text;

create table if not exists participants (
  mission_id  text not null references missions(mission_id),
  user_id     text not null references users(user_id),
  mission_role text not null check (mission_role in ('mission_admin', 'operator', 'contributor', 'viewer')),
  created_at  timestamptz not null default now(),
  primary key (mission_id, user_id)
);
-- When this participant's own client last read this mission. Presence is a
-- projection over this timestamp, never a stored word (D-091): connected /
-- reconnecting / offline are computed at read time against the same recovery
-- window the runner's liveness uses. Ephemeral in meaning, durable in storage
-- only because the projection needs somewhere to read from; it never appears
-- in receipts (PRODUCT.md#presence-and-connection).
alter table participants add column if not exists last_seen_at timestamptz;

create table if not exists events (
  event_id       text primary key,
  org_id         text not null references organizations(org_id),
  mission_id     text not null references missions(mission_id),
  seq            bigint not null,
  kind           text not null,
  actor_kind     text not null check (actor_kind in ('user', 'harness', 'runner', 'system', 'external')),
  actor_id       text not null,
  payload        jsonb not null default '{}'::jsonb,
  schema_version int not null default 1,
  occurred_at    timestamptz not null default now(),
  recorded_at    timestamptz not null default now(),
  unique (mission_id, seq)
);
create index if not exists events_by_mission on events (mission_id, seq);
-- Correlation and de-duplication columns (ARCHITECTURE.md#event-model).
alter table events add column if not exists workstream_id text references workstreams(wst_id);
alter table events add column if not exists execution_id text;
alter table events add column if not exists cause_direction_id text;
alter table events add column if not exists cause_lease_id text;
alter table events add column if not exists origin_seq bigint;
alter table events add column if not exists actor_login text;
-- A runner event replayed after a partition lands exactly once. The key is the
-- scope the report belongs to: an execution when there is one, the workstream
-- when the report is about the workspace itself. Keying on execution_id alone
-- would stop de-duplicating entirely for workspace reports, because Postgres
-- treats NULL keys as distinct from one another.
drop index if exists events_execution_origin_seq;
create unique index if not exists events_origin_scope_seq
  on events (coalesce(execution_id, workstream_id), origin_seq)
  where origin_seq is not null;

-- ---------------------------------------------------------------------------
-- Invitations (PRODUCT.md#domain-model). Single-use, expiring, mission-scoped;
-- only the token hash is ever stored.
-- ---------------------------------------------------------------------------

create table if not exists invitations (
  inv_id       text primary key,
  org_id       text not null references organizations(org_id),
  mission_id   text not null references missions(mission_id),
  mission_role text not null check (mission_role in ('mission_admin', 'operator', 'contributor', 'viewer')),
  token_hash   text not null unique,
  created_by   text not null references users(user_id),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  redeemed_at  timestamptz,
  redeemed_by  text references users(user_id),
  revoked_at   timestamptz
);
create index if not exists invitations_by_mission on invitations (mission_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Control: one lease per workstream, plus the request and offer machines
-- (PRODUCT.md#control). Transitions are compare-and-swap on (id, state).
-- ---------------------------------------------------------------------------

create table if not exists control_leases (
  lease_id     text primary key,
  org_id       text not null references organizations(org_id),
  mission_id   text not null references missions(mission_id),
  wst_id       text not null references workstreams(wst_id),
  holder_user_id text not null references users(user_id),
  state        text not null check (state in ('held', 'releasing', 'transferred', 'released', 'expired', 'revoked')),
  pending_recipient_user_id text references users(user_id),
  created_at   timestamptz not null default now(),
  ended_at     timestamptz
);
-- Exactly one current holder per workstream.
create unique index if not exists control_leases_one_current
  on control_leases (wst_id) where state in ('held', 'releasing');
-- When the holder last exercised their authority. A lease is a grant, not a
-- connection: it survives disconnection and lapses only on genuine absence.
alter table control_leases add column if not exists last_heartbeat_at timestamptz;

create table if not exists control_requests (
  req_id       text primary key,
  org_id       text not null references organizations(org_id),
  mission_id   text not null references missions(mission_id),
  wst_id       text not null references workstreams(wst_id),
  requester_user_id text not null references users(user_id),
  state        text not null check (state in ('open', 'fulfilled', 'declined', 'withdrawn', 'expired', 'superseded')),
  created_at   timestamptz not null default now(),
  ended_at     timestamptz
);
-- One open request per person per workstream; simultaneous requests from
-- different people all stay open and visible (PRODUCT.md#control).
create unique index if not exists control_requests_one_open_per_user
  on control_requests (wst_id, requester_user_id) where state = 'open';

create table if not exists handoff_offers (
  offer_id     text primary key,
  org_id       text not null references organizations(org_id),
  mission_id   text not null references missions(mission_id),
  wst_id       text not null references workstreams(wst_id),
  from_user_id text not null references users(user_id),
  to_user_id   text not null references users(user_id),
  lease_id     text not null references control_leases(lease_id),
  state        text not null check (state in ('open', 'accepted', 'waiting_for_boundary', 'completed', 'declined', 'withdrawn', 'expired', 'failed')),
  created_at   timestamptz not null default now(),
  accepted_at  timestamptz,
  ended_at     timestamptz
);
-- At most one live offer per workstream: a second offer must withdraw the first.
create unique index if not exists handoff_offers_one_live
  on handoff_offers (wst_id) where state in ('open', 'accepted', 'waiting_for_boundary');
-- When an unanswered offer lapses (D-092). Nullable only for rows created
-- before the column existed; the projection treats those as created_at plus
-- the same TTL, so no offer is ever without an expiry on the wire.
alter table handoff_offers add column if not exists expires_at timestamptz;

-- ---------------------------------------------------------------------------
-- Runners: the machine-side identity that reports harness-attributed activity.
-- Only the credential hash is stored; the usable credential lives exclusively
-- in the host desktop's main process (D-035, resolving D-033).
-- ---------------------------------------------------------------------------

create table if not exists runners (
  runner_id       text primary key,
  org_id          text not null references organizations(org_id),
  mission_id      text not null references missions(mission_id),
  wst_id          text not null references workstreams(wst_id),
  owner_user_id   text not null references users(user_id),
  kind            text not null check (kind in ('local')),
  label           text not null,
  credential_hash text not null unique,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  revoked_at      timestamptz,
  last_seen_at    timestamptz
);
create index if not exists runners_by_workstream on runners (wst_id, created_at desc);
-- One live runner per workstream: re-registering revokes the previous one.
create unique index if not exists runners_one_live_per_workstream
  on runners (wst_id) where revoked_at is null;

-- ---------------------------------------------------------------------------
-- Executions (PRODUCT.md#domain-model). At most one active per workstream —
-- enforced by the database, not by an in-memory map.
-- ---------------------------------------------------------------------------

create table if not exists executions (
  exe_id            text primary key,
  org_id            text not null references organizations(org_id),
  mission_id        text not null references missions(mission_id),
  wst_id            text not null references workstreams(wst_id),
  harness           text not null,
  model             text not null,
  effort            text not null,
  runner_id         text references runners(runner_id),
  starting_direction_id text,
  state             text not null check (state in (
                      'requested', 'starting', 'running', 'needs_direction', 'needs_approval',
                      'stopping', 'completed', 'stopped', 'interrupted', 'failed')),
  started_by        text not null references users(user_id),
  created_at        timestamptz not null default now(),
  started_at        timestamptz,
  ended_at          timestamptz,
  harness_session_id text,
  resumed_session   boolean not null default false,
  exit_outcome      text,
  failure_reason    text,
  last_origin_seq   bigint not null default 0,
  latest_checkpoint_sha text
);
-- What the harness said the work cost, summed over the execution's turns. An
-- opaque claim: Novus bills nothing from it and stops nothing because of it
-- (ARCHITECTURE.md#harness-protocol). Null means the harness reported nothing,
-- which is a different fact from zero.
alter table executions add column if not exists input_tokens bigint;
alter table executions add column if not exists output_tokens bigint;
alter table executions add column if not exists cache_read_tokens bigint;
alter table executions add column if not exists cache_creation_tokens bigint;
alter table executions add column if not exists cost_usd numeric(12, 6);
alter table executions add column if not exists harness_duration_ms bigint;
alter table executions add column if not exists harness_turns integer;
-- What the turn may do to the worktree (D-095). 'write' is the ordinary
-- exclusive turn; 'read' runs alongside it — denied every permission request,
-- capturing no checkpoint, never a transfer boundary.
alter table executions add column if not exists access text not null default 'write'
  check (access in ('write', 'read'));

create index if not exists executions_by_workstream on executions (wst_id, created_at desc);
-- Writing turns take the worktree by scope (D-095, D-097): unscoped turns are
-- exclusive, and scoped turns whose declared file sets are provably disjoint
-- run in parallel. That judgment reads the sessions table, which an index on
-- this one cannot, so the concurrency guard is the dispatch transaction under
-- the mission's advisory lock — the write-exclusivity index D-095 introduced
-- is retired by name along with its access-blind predecessor. The per-session
-- index below survives as the race backstop: one turn per conversation.
drop index if exists executions_one_active_per_workstream;
drop index if exists executions_one_active_write_per_workstream;
-- The matching per-conversation index lives with the sessions migration
-- below (D-083's block), because `executions.session_id` does not exist yet
-- at this point in a fresh database's first run.

-- ---------------------------------------------------------------------------
-- Direction (PRODUCT.md#direction). Attributed, ordered, durable; "applied"
-- is marked on runner acknowledgement, never on send.
-- ---------------------------------------------------------------------------

create table if not exists directions (
  dir_id       text primary key,
  org_id       text not null references organizations(org_id),
  mission_id   text not null references missions(mission_id),
  wst_id       text not null references workstreams(wst_id),
  author_user_id text not null references users(user_id),
  body         text not null,
  state        text not null check (state in ('submitted', 'queued', 'applied', 'superseded', 'rejected', 'cancelled')),
  ordinal      bigserial,
  submitted_at timestamptz not null default now(),
  applied_at   timestamptz,
  ended_at     timestamptz,
  resolution_reason text,
  consumed_by_execution_id text references executions(exe_id)
);
create index if not exists directions_by_workstream on directions (wst_id, ordinal);
-- The model and effort the author chose, so a direction dispatched later runs
-- as it was written rather than under whatever the last execution happened to use.
alter table directions add column if not exists model text;
alter table directions add column if not exists effort text;

-- ---------------------------------------------------------------------------
-- Durable command transport, control plane → host runner (D-035). Ordered per
-- runner, idempotent per key, never silently dropped.
-- ---------------------------------------------------------------------------

create table if not exists runner_commands (
  cmd_id       text primary key,
  org_id       text not null references organizations(org_id),
  mission_id   text not null references missions(mission_id),
  wst_id       text not null references workstreams(wst_id),
  exe_id       text references executions(exe_id),
  runner_id    text not null references runners(runner_id),
  kind         text not null check (kind in ('start_execution', 'apply_direction', 'stop_execution', 'boundary_request')),
  payload      jsonb not null default '{}'::jsonb,
  idempotency_key text not null,
  state        text not null check (state in ('pending', 'delivered', 'acknowledged', 'completed', 'failed')),
  seq          bigserial,
  created_at   timestamptz not null default now(),
  delivered_at timestamptz,
  acknowledged_at timestamptz,
  completed_at timestamptz,
  failure_reason text
);
create unique index if not exists runner_commands_idempotency on runner_commands (wst_id, idempotency_key);
create index if not exists runner_commands_pending on runner_commands (runner_id, seq)
  where state in ('pending', 'delivered', 'acknowledged');

-- ---------------------------------------------------------------------------
-- Evidence: checkpoints and per-file changes derived from git, never from the
-- harness's prose; verification observed from real tool results (D-037).
-- ---------------------------------------------------------------------------

create table if not exists checkpoints (
  ckp_id       text primary key,
  org_id       text not null references organizations(org_id),
  mission_id   text not null references missions(mission_id),
  wst_id       text not null references workstreams(wst_id),
  exe_id       text not null references executions(exe_id),
  outcome      text not null check (outcome in ('committed', 'clean', 'failed')),
  sha          text,
  parent_sha   text,
  branch       text not null,
  files_changed int not null default 0,
  additions    int not null default 0,
  deletions    int not null default 0,
  withheld_secrets int not null default 0,
  uncommitted  boolean not null default false,
  runner_id    text references runners(runner_id),
  environment  text not null,
  error        text,
  created_at   timestamptz not null default now()
);
create index if not exists checkpoints_by_execution on checkpoints (exe_id, created_at desc);

create table if not exists file_changes (
  chg_id       text primary key,
  org_id       text not null references organizations(org_id),
  mission_id   text not null references missions(mission_id),
  ckp_id       text not null references checkpoints(ckp_id),
  path         text not null,
  previous_path text,
  change_state text not null check (change_state in ('added', 'modified', 'deleted', 'renamed')),
  additions    int not null default 0,
  deletions    int not null default 0,
  is_binary    boolean not null default false,
  truncated    boolean not null default false,
  diff         text
);
create index if not exists file_changes_by_checkpoint on file_changes (ckp_id, path);

create table if not exists verification_checks (
  chk_id       text primary key,
  org_id       text not null references organizations(org_id),
  mission_id   text not null references missions(mission_id),
  exe_id       text not null references executions(exe_id),
  name         text not null,
  category     text not null check (category in ('test', 'typecheck', 'build', 'lint', 'diagnostic')),
  outcome      text not null check (outcome in ('passed', 'failed', 'skipped', 'errored')),
  command      text not null,
  output       text,
  truncated    boolean not null default false,
  environment  text not null,
  runner_id    text references runners(runner_id),
  observed_at  timestamptz not null default now()
);
create index if not exists verification_checks_by_execution on verification_checks (exe_id, observed_at);

-- ---------------------------------------------------------------------------
-- Workspace runtime (D-040 … D-042). The control plane records what a
-- workspace *is* and what is running in it; it never learns how to build
-- anything — the commands live in the repository — and it never holds a
-- secret value.
-- ---------------------------------------------------------------------------

create table if not exists workspaces (
  wsp_id       text primary key,
  org_id       text not null references organizations(org_id),
  mission_id   text not null references missions(mission_id),
  wst_id       text not null references workstreams(wst_id),
  runner_id    text references runners(runner_id),
  location     text not null default 'local' check (location in ('local')),
  -- Readiness is the answer to "can this workspace run anything yet?".
  readiness    text not null check (readiness in ('unconfigured', 'configuring', 'ready', 'failed')),
  -- Reported by the runner so the room can name a port without knowing a path.
  port_range_start int,
  port_range_end   int,
  setup_error  text,
  configured_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index if not exists workspaces_one_per_workstream on workspaces (wst_id);

-- A command the project declared, alive or finished, in a workspace. Long-lived
-- run commands are the reason both clients can see "App running" at all.
create table if not exists workspace_processes (
  prc_id       text primary key,
  org_id       text not null references organizations(org_id),
  mission_id   text not null references missions(mission_id),
  wst_id       text not null references workstreams(wst_id),
  wsp_id       text not null references workspaces(wsp_id),
  kind         text not null check (kind in ('setup', 'run', 'verification')),
  name         text not null,
  command      text not null,
  state        text not null check (state in ('starting', 'running', 'exited', 'failed', 'stopped')),
  started_by   text references users(user_id),
  runner_id    text references runners(runner_id),
  preview_url  text,
  port         int,
  exit_code    int,
  failure_reason text,
  started_at   timestamptz not null default now(),
  ended_at     timestamptz
);
create index if not exists workspace_processes_live on workspace_processes (wst_id, started_at desc);
-- One live process per named run command per workstream, unless the project
-- said its run commands may overlap; the runner enforces the project's answer
-- and this index enforces the default.
create unique index if not exists workspace_processes_one_live_per_name
  on workspace_processes (wst_id, name) where state in ('starting', 'running');

-- Verification gains what makes a check evidence rather than a green word:
-- who caused it, when, how long, what it exited with, and which revision it
-- actually proves (D-037, extended).
alter table verification_checks add column if not exists origin text not null default 'harness';
alter table verification_checks drop constraint if exists verification_checks_origin_check;
alter table verification_checks add constraint verification_checks_origin_check
  check (origin in ('harness', 'participant', 'external', 'automatic'));
alter table verification_checks add column if not exists requested_by text references users(user_id);
alter table verification_checks add column if not exists exit_code int;
alter table verification_checks add column if not exists started_at timestamptz;
alter table verification_checks add column if not exists completed_at timestamptz;
alter table verification_checks add column if not exists duration_ms int;
-- The revision this check proves. Null only for harness-observed checks from
-- before the workspace runtime existed.
alter table verification_checks add column if not exists checkpoint_sha text;
-- exe_id is nullable now: a participant can verify without an execution.
alter table verification_checks alter column exe_id drop not null;

-- The runner's command vocabulary grows with the workspace runtime, and it is
-- widened in exactly **one** place — below, where the list is complete. It used
-- to be widened here as well, with the list as it stood at the time, and that
-- made this file non-rerunnable the moment a database held a command added
-- later: re-migrating dropped the good constraint and re-added a narrower one,
-- which Postgres then refused against the existing rows. A real deployment hit
-- it the second time it started after somebody answered an approval.
--
-- There is deliberately no shell command in the vocabulary: remote interactive
-- access to somebody's laptop is structurally absent, not merely unauthorized
-- (D-042).

-- ---------------------------------------------------------------------------
-- Declared commands, readiness, and how a command ended (D-043, D-045).
-- ---------------------------------------------------------------------------

-- What the project declared, exactly as the runner read it. The control plane
-- never parses `.novus/settings.toml` and does not start now: this is an opaque
-- list it was handed, stored so every participant's Run control offers the same
-- commands and so an authorization can be pinned to the snapshot it authorized.
alter table workspaces add column if not exists declared jsonb not null default '[]'::jsonb;
alter table workspaces add column if not exists declared_at timestamptz;

-- A process existing is not a claim that an application is serving. `pending`
-- is a run command whose declared readiness signal has not answered yet, which
-- the room shows as Starting rather than Running.
alter table workspace_processes add column if not exists readiness text not null default 'not_required';
alter table workspace_processes drop constraint if exists workspace_processes_readiness_check;
alter table workspace_processes add constraint workspace_processes_readiness_check
  check (readiness in ('not_required', 'pending', 'ready', 'unreachable'));

-- Why it stopped. A deadline, a cancellation, and a non-zero exit are three
-- different endings, and a room that cannot tell them apart cannot say what
-- happened.
alter table workspace_processes add column if not exists ending text;
alter table workspace_processes drop constraint if exists workspace_processes_ending_check;
alter table workspace_processes add constraint workspace_processes_ending_check
  check (ending is null or ending in ('exit', 'signal', 'timeout', 'cancelled', 'spawn_failed'));

alter table verification_checks add column if not exists ending text;
alter table verification_checks drop constraint if exists verification_checks_ending_check;
alter table verification_checks add constraint verification_checks_ending_check
  check (ending is null or ending in ('exit', 'signal', 'timeout', 'cancelled', 'spawn_failed'));

-- ---------------------------------------------------------------------------
-- Harness approvals (D-056). The harness asks before it acts; the question is
-- durable, the answer is attributed, and both outlive the turn.
--
-- What is deliberately absent is the tool's raw input. A `Write` carries an
-- entire file in it and a `Bash` carries a command line that may hold a token;
-- a row distributed to every participant and projected into a receipt is the
-- last place either belongs. What is stored is a bounded summary the runner
-- built from named fields and passed through the same redaction every other
-- reported string goes through (D-052).
-- ---------------------------------------------------------------------------

create table if not exists approval_requests (
  apr_id       text primary key,
  org_id       text not null references organizations(org_id),
  mission_id   text not null references missions(mission_id),
  wst_id       text not null references workstreams(wst_id),
  exe_id       text not null references executions(exe_id),
  runner_id    text references runners(runner_id),
  -- The harness's own correlation id. Unique per execution: a replayed report
  -- of the same question is the same row, never a second one.
  harness_request_id text not null,
  tool_use_id  text,
  tool_name    text not null,
  display_name text not null,
  summary      text not null,
  state        text not null check (state in ('pending', 'approved', 'denied', 'cancelled', 'expired')),
  requested_at timestamptz not null default now(),
  responded_by text references users(user_id),
  responded_at timestamptz,
  resolution   text
);
create unique index if not exists approval_requests_one_per_harness_request
  on approval_requests (exe_id, harness_request_id);
create index if not exists approval_requests_by_mission on approval_requests (mission_id, requested_at);
-- The open question, which is what *Needs approval* is about.
create index if not exists approval_requests_pending on approval_requests (exe_id)
  where state = 'pending';

-- The controller's typed answer is a runner command like any other.
-- `push_branch` (D-099) puts the mission branch on the repository host; there
-- is deliberately no merge in this vocabulary, and never will be by accident,
-- because this is the one place it is written.
alter table runner_commands drop constraint if exists runner_commands_kind_check;
alter table runner_commands add constraint runner_commands_kind_check
  check (kind in ('start_execution', 'apply_direction', 'stop_execution', 'boundary_request',
                  'respond_approval',
                  'run_setup', 'run_command', 'stop_command', 'run_verification',
                  'push_branch'));

-- A check proves one lane's revision (D-074). Harness-observed checks could
-- always be traced through their execution; participant-run ones carry no
-- execution at all, so with a second lane in the mission they belonged to
-- nothing. The workstream is recorded directly, and backfilled for the rows
-- written before it existed.
alter table verification_checks add column if not exists wst_id text references workstreams(wst_id);
update verification_checks v
   set wst_id = e.wst_id
  from executions e
 where v.exe_id = e.exe_id and v.wst_id is null;
update verification_checks v
   set wst_id = w.wst_id
  from workstreams w
 where v.wst_id is null and w.mission_id = v.mission_id
   and not exists (select 1 from workstreams w2 where w2.mission_id = v.mission_id and w2.wst_id <> w.wst_id);
create index if not exists verification_checks_by_workstream on verification_checks (wst_id, observed_at);

-- ---------------------------------------------------------------------------
-- Decisions (PRODUCT.md#domain-model, D-075). A judgment, never a computation:
-- nothing here is scored, ranked, or derived from which lane "won". Append
-- only — a later decision supersedes an earlier one and neither is rewritten.
-- ---------------------------------------------------------------------------

create table if not exists decisions (
  dec_id          text primary key,
  org_id          text not null references organizations(org_id),
  mission_id      text not null references missions(mission_id),
  wst_id          text not null references workstreams(wst_id),
  -- The exact revision chosen. Null only where a lane was chosen before it
  -- ever produced a checkpoint, which the surface states rather than hides.
  checkpoint_sha  text,
  decided_by      text not null references users(user_id),
  -- Required by the database as well as by the route: a rationale that can be
  -- skipped is a rationale that is skipped.
  rationale       text not null check (length(btrim(rationale)) > 0),
  accepted_risks  text,
  -- What was outstanding at the moment of deciding, captured then rather than
  -- recomputed later, when the answer would have changed.
  unresolved_check_ids jsonb not null default '[]'::jsonb,
  unresolved_summary   jsonb not null default '[]'::jsonb,
  decided_at      timestamptz not null default now(),
  superseded_at   timestamptz
);
create index if not exists decisions_by_mission on decisions (mission_id, decided_at);
-- One current decision per mission; the rest are history.
create unique index if not exists decisions_one_current_per_mission
  on decisions (mission_id) where superseded_at is null;

-- ---------------------------------------------------------------------------
-- Pull requests (PRODUCT.md#domain-model, D-099). The row D-075 promised: it
-- starts existing when a request is actually opened on the host, and from
-- then on Novus tracks it — state, reviews, mergeability — to a resolution
-- that happens on GitHub, by humans. There is no merge verb anywhere in this
-- schema, in any route, or in the runner vocabulary above, deliberately.
-- ---------------------------------------------------------------------------

create table if not exists pull_requests (
  pr_id            text primary key,
  org_id           text not null references organizations(org_id),
  mission_id       text not null references missions(mission_id),
  wst_id           text not null references workstreams(wst_id),
  -- The decision this publishes. Publishing is what a decision becomes,
  -- never a shortcut around one.
  dec_id           text not null references decisions(dec_id),
  provider_number  integer not null check (provider_number > 0),
  url              text not null,
  state            text not null check (state in ('draft', 'ready', 'merged', 'closed')),
  mergeable        text not null default 'unknown'
                   check (mergeable in ('unknown', 'clean', 'conflict')),
  -- Exactly what was sent, snapshotted at publication: the record of the
  -- receipt that travelled (D-075's stored-draft rejection, resolved by
  -- D-099 for the opened case).
  title            text not null check (length(btrim(title)) > 0),
  body             text not null check (length(btrim(body)) > 0),
  base_ref         text not null,
  head_ref         text not null,
  -- The revision the remote served when this was opened — the remote-head
  -- guarantee's receipt.
  head_sha         text check (head_sha ~ '^[0-9a-f]{40}$'),
  requested_reviewers jsonb not null default '[]'::jsonb,
  -- Review threads, ingested read-only and bounded (D-099). A table of their
  -- own arrives with review.comment; a reflection does not need one.
  review_threads   jsonb not null default '[]'::jsonb,
  created_by       text not null references users(user_id),
  merged_by        text,
  merged_at        timestamptz,
  closed_at        timestamptz,
  created_at       timestamptz not null default now(),
  last_synced_at   timestamptz
);
create index if not exists pull_requests_by_mission on pull_requests (mission_id, created_at);
-- At most one request that is still open — draft or ready — per lane.
create unique index if not exists pull_requests_one_open_per_workstream
  on pull_requests (wst_id) where state in ('draft', 'ready');

-- The remote-head half of the guarantee (D-099): the revision the host is
-- known to serve for this lane's branch, written only by an observed
-- successful push. Null is the ordinary local-first state.
alter table workstreams add column if not exists remote_head_sha text
  check (remote_head_sha is null or remote_head_sha ~ '^[0-9a-f]{40}$');

-- Operating the request in-house (D-100): the host's labels, and the
-- aggregated merge-readiness projection the poll refreshes — checks with
-- their required flags, the review decision, behind/ahead, and the
-- repository's own allowed merge methods. Bounded JSON, like the threads.
alter table pull_requests add column if not exists labels jsonb not null default '[]'::jsonb;
alter table pull_requests add column if not exists readiness jsonb;

-- The person's own OAuth access token (D-101): held here alone so a comment
-- from Novus can be authored as them on the host. Never served to a client,
-- a runner, or an event; refreshed at sign-in; null until a person signs in
-- under the repo scope. ARCHITECTURE.md#secret-placement carries the row.
alter table users add column if not exists github_token text;

-- ---------------------------------------------------------------------------
-- Sessions (D-083): parallel conversations inside one workstream. A session
-- owns its direction thread, its executions, and its own harness continuity —
-- and nothing else. No branch, no worktree, no workspace, no lease: sessions
-- take turns in the workstream's single workspace, and the one-live-execution-
-- per-workstream index above is the serialization.
--
-- `csn_` because `ses_` has always been the auth session's prefix; two objects
-- sharing a prefix is what prefixes exist to prevent.
-- ---------------------------------------------------------------------------

create table if not exists workstream_sessions (
  csn_id       text primary key,
  org_id       text not null references organizations(org_id),
  mission_id   text not null references missions(mission_id),
  wst_id       text not null references workstreams(wst_id),
  -- The session's own first words, truncated; null until it has any. Never a
  -- form field and never renamed (D-083).
  title        text,
  created_by   text not null references users(user_id),
  -- This conversation's own resume point. The workstream's legacy column stays
  -- mirrored from the lane's first session for old readers.
  harness_session_id text,
  created_at   timestamptz not null default now()
);
create index if not exists workstream_sessions_by_lane
  on workstream_sessions (wst_id, created_at, csn_id);
-- The chat's declared file scope (D-097): a json array of repository-relative
-- glob patterns, null for unscoped. Set by the baton holder; a scoped chat's
-- write turns run in parallel with provably disjoint siblings and may write
-- only inside the scope.
alter table workstream_sessions add column if not exists scope jsonb;
-- What a scoped turn changed outside its scope, observed and deliberately not
-- committed (D-097). Empty for every unscoped checkpoint.
alter table checkpoints add column if not exists drift_paths jsonb not null default '[]'::jsonb;

-- Every workstream holds at least one session, created with it. Existing
-- workstreams are migrated with one session adopting their history and their
-- resume point. The id is derived from the lane so a rerun inserts nothing.
insert into workstream_sessions (csn_id, org_id, mission_id, wst_id, title, created_by, harness_session_id, created_at)
select 'csn_0' || left(md5(w.wst_id), 19), m.org_id, w.mission_id, w.wst_id, null, m.created_by,
       w.harness_session_id, w.created_at
  from workstreams w
  join missions m on m.mission_id = w.mission_id
 where not exists (select 1 from workstream_sessions s where s.wst_id = w.wst_id);

-- A direction belongs to exactly one session; rows from before sessions land
-- in their lane's first. NOT NULL after the backfill, so a write path that
-- forgets the session fails loudly rather than minting an orphan thread.
alter table directions add column if not exists session_id text references workstream_sessions(csn_id);
update directions d
   set session_id = s.csn_id
  from (select distinct on (wst_id) wst_id, csn_id
          from workstream_sessions order by wst_id, created_at, csn_id) s
 where s.wst_id = d.wst_id and d.session_id is null;
alter table directions alter column session_id set not null;
create index if not exists directions_by_session on directions (session_id, ordinal);

-- An execution is one session's turn, under the same backfill and the same
-- refusal of null. The one-active-per-workstream index is deliberately
-- untouched: sessions do not weaken the workspace's serialization.
alter table executions add column if not exists session_id text references workstream_sessions(csn_id);
update executions e
   set session_id = s.csn_id
  from (select distinct on (wst_id) wst_id, csn_id
          from workstream_sessions order by wst_id, created_at, csn_id) s
 where s.wst_id = e.wst_id and e.session_id is null;
alter table executions alter column session_id set not null;
-- One turn per conversation, whatever its access (D-095): a session's turns
-- resume its own harness session, and two at once would fork the transcript.
-- Implied by the lane-wide index until read turns began bypassing it.
create unique index if not exists executions_one_active_per_session
  on executions (session_id)
  where state in ('requested', 'starting', 'running', 'needs_direction', 'needs_approval', 'stopping');

-- A migrated session is titled by its first words, exactly as a new one is.
-- Idempotent: only null titles move, and the oldest direction does not change.
update workstream_sessions s
   set title = left(regexp_replace(btrim(d.body), '\s+', ' ', 'g'), 80)
  from (select distinct on (session_id) session_id, body
          from directions order by session_id, ordinal) d
 where d.session_id = s.csn_id and s.title is null and length(btrim(d.body)) > 0;

-- ---------------------------------------------------------------------------
-- Permission profiles (D-115). The lane's standing answer policy for the
-- harness's permission questions — chosen by a person with `policy.set`,
-- event-recorded as `policy.changed`, and pinned onto each execution at
-- dispatch so a turn's record says what supervision it ran under. 'manual'
-- is the default and is exactly the pre-profile behaviour: every question
-- asked. There is deliberately no 'bypass' value anywhere in this vocabulary:
-- the harness always asks over the pinned stdio channel (D-062), and what a
-- profile changes is who answers. The CHECK is widened here and only here,
-- per the one-place rule the runner-command vocabulary learned the hard way.
-- ---------------------------------------------------------------------------

alter table workstreams add column if not exists permission_profile text not null default 'manual';
alter table workstreams drop constraint if exists workstreams_permission_profile_check;
alter table workstreams add constraint workstreams_permission_profile_check
  check (permission_profile in ('plan', 'manual', 'accept_edits', 'auto', 'dont_ask'));

alter table executions add column if not exists permission_profile text not null default 'manual';
alter table executions drop constraint if exists executions_permission_profile_check;
alter table executions add constraint executions_permission_profile_check
  check (permission_profile in ('plan', 'manual', 'accept_edits', 'auto', 'dont_ask'));

-- ---------------------------------------------------------------------------
-- Project skills (D-118). The worktree's `.claude/skills` manifest, published
-- by the runner beside the declared commands (D-043's pattern), and the set a
-- person with `skills.set` enabled on the lane — each entry pinned to the
-- SHA-256 of the exact SKILL.md the person was shown, so a file the agent
-- rewrites afterwards is dropped at compose time rather than loaded on a
-- stale approval. Both are json arrays validated at the wire by the contracts
-- package; the control plane stores them verbatim and never reads a skill
-- body, exactly as it never parses a declared command.
-- ---------------------------------------------------------------------------

alter table workspaces add column if not exists declared_skills jsonb not null default '[]'::jsonb;
alter table workstreams add column if not exists enabled_skills jsonb not null default '[]'::jsonb;

-- Project MCP servers (D-119): the same publish-review-enable shape as the
-- skills above, one tier up — `mcp.set` is Mission Admin's alone, because a
-- server is new tool surface rather than instructions. Stored verbatim,
-- validated at the wire, never parsed here.
alter table workspaces add column if not exists declared_mcp jsonb not null default '[]'::jsonb;
alter table workstreams add column if not exists enabled_mcp_servers jsonb not null default '[]'::jsonb;

-- The Home board's aggregates (D-120): the list sums churn and counts
-- distinct changed paths per mission on every poll, so both tables need a
-- mission-keyed path. Checkpoints also serve the per-lane current-head
-- lookup by (wst_id, created_at).
create index if not exists checkpoints_by_mission on checkpoints (mission_id);
create index if not exists checkpoints_by_workstream on checkpoints (wst_id, created_at desc);
create index if not exists file_changes_by_mission on file_changes (mission_id, path);

-- ---------------------------------------------------------------------------
-- The terminal lifecycle (D-121). A mission's work ends by a person's own
-- act — completed (result accepted) or cancelled — and the ending is the one
-- stored word the state projection reads, because a terminal state is a fact
-- a person made, not a derivation. The receipt is snapshotted in the same
-- transaction: a deterministic projection with the event range it covers,
-- validated at the wire shape before it is stored, always re-derivable.
-- Closing is not archival (D-063): one ends the work, the other files the
-- record away, and a mission can be both.
-- ---------------------------------------------------------------------------

alter table missions add column if not exists closed_at timestamptz;
alter table missions add column if not exists closed_by text references users(user_id);
alter table missions add column if not exists closed_outcome text
  check (closed_outcome in ('completed', 'cancelled'));

create table if not exists receipts (
  rcp_id       text primary key,
  org_id       text not null references organizations(org_id),
  mission_id   text not null references missions(mission_id),
  snapshot     jsonb not null,
  from_seq     bigint not null,
  to_seq       bigint not null,
  created_at   timestamptz not null default now()
);
create unique index if not exists receipts_one_per_mission on receipts (mission_id);

-- ---------------------------------------------------------------------------
-- Artifacts (D-022, D-122): durable visual evidence. This table holds
-- metadata, provenance, and relationships; the bytes live in the artifact
-- store behind the S3-compatible interface, addressed by an object key Novus
-- generated and scoped. No signed URL is ever stored — viewing access is
-- minted per request and expires. A row reads as evidence only in the
-- 'available' and 'interrupted' states; pending, uploading, and failed never
-- do, and a failed upload says why. Metadata is immutable once available:
-- attach/detach changes relationship rows, never this one.
-- ---------------------------------------------------------------------------

create table if not exists artifacts (
  art_id       text primary key,
  org_id       text not null references organizations(org_id),
  mission_id   text not null references missions(mission_id),
  wst_id       text references workstreams(wst_id),
  -- The chat honestly attributable, or null: a person's capture belongs to no
  -- conversation and is never assigned to the most recent one.
  csn_id       text references workstream_sessions(csn_id),
  -- The execution that requested it (agent-requested capture), or null.
  exe_id       text references executions(exe_id),
  kind         text not null check (kind in ('screenshot', 'recording')),
  mime_type    text not null check (mime_type in ('image/png', 'video/webm')),
  byte_size    bigint not null check (byte_size > 0),
  sha256       text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  -- The store object key: server-generated, mission-scoped, never served to
  -- any client and never in an event or a receipt.
  object_key   text not null,
  thumb_object_key text,
  thumb_byte_size  bigint check (thumb_byte_size is null or thumb_byte_size > 0),
  thumb_sha256     text check (thumb_sha256 is null or thumb_sha256 ~ '^[0-9a-f]{64}$'),
  state        text not null check (state in ('pending', 'uploading', 'available', 'interrupted', 'failed')),
  failure_reason      text,
  interruption_reason text,
  label        text not null,
  initiator    text not null check (initiator in ('person', 'agent')),
  capture_source text not null default 'preview' check (capture_source in ('preview')),
  created_by   text references users(user_id),
  -- The approval that authorized an agent-requested capture, when one was a
  -- routed card; a profile-decided answer has no card.
  approval_id  text references approval_requests(apr_id),
  runner_id    text references runners(runner_id),
  environment  text not null,
  -- Capture provenance, each a bounded claim from the machine that performed
  -- the capture (D-037's discipline): the live process, its validated origin,
  -- its declared readiness, and the worktree revision read from git at the
  -- moment of capture — with dirty stated rather than hidden.
  process_id   text,
  process_name text,
  origin       text,
  readiness    text check (readiness is null or readiness in ('not_required', 'pending', 'ready', 'unreachable')),
  revision_sha text,
  revision_dirty boolean not null default false,
  ckp_id       text references checkpoints(ckp_id),
  duration_ms  bigint check (duration_ms is null or duration_ms >= 0),
  captured_at  timestamptz not null,
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists artifacts_by_mission on artifacts (mission_id, created_at);
create index if not exists artifacts_by_state on artifacts (state, created_at);

-- Where an artifact is evidence (D-122): beside a check or a tracked pull
-- request. Append-only — detaching sets detached_at, so the record can answer
-- "was this ever presented as evidence?" — and at most one live attachment
-- per (artifact, target). Decisions carry their chosen artifact ids on the
-- decision row itself, frozen with the rationale.
create table if not exists artifact_attachments (
  att_id       text primary key,
  org_id       text not null references organizations(org_id),
  mission_id   text not null references missions(mission_id),
  art_id       text not null references artifacts(art_id),
  target_kind  text not null check (target_kind in ('check', 'pull_request')),
  target_id    text not null,
  attached_by  text not null references users(user_id),
  attached_at  timestamptz not null default now(),
  detached_by  text references users(user_id),
  detached_at  timestamptz
);
create index if not exists artifact_attachments_by_artifact on artifact_attachments (art_id, attached_at);
create index if not exists artifact_attachments_by_target on artifact_attachments (target_kind, target_id);
create unique index if not exists artifact_attachments_one_live
  on artifact_attachments (art_id, target_kind, target_id) where detached_at is null;

-- The decision's chosen visual evidence (D-122): exact artifact ids, frozen
-- at record time with the rationale, preserved into the receipt snapshot.
alter table decisions add column if not exists artifact_ids jsonb not null default '[]'::jsonb;
