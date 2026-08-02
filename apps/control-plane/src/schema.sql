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
-- V0 constraint: exactly one workstream per mission (multi-workstream is a later, deliberate change).
create unique index if not exists workstreams_one_per_mission on workstreams (mission_id);
drop index if exists workstreams_branch_unique;
-- One branch name per repository — the invariant the audit demanded be real.
create unique index if not exists workstreams_repo_branch_unique on workstreams (repo_id, mission_branch);
-- The harness session this workstream continues across executions (D-038).
alter table workstreams add column if not exists harness_session_id text;

create table if not exists participants (
  mission_id  text not null references missions(mission_id),
  user_id     text not null references users(user_id),
  mission_role text not null check (mission_role in ('mission_admin', 'operator', 'contributor', 'viewer')),
  created_at  timestamptz not null default now(),
  primary key (mission_id, user_id)
);

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
create index if not exists executions_by_workstream on executions (wst_id, created_at desc);
create unique index if not exists executions_one_active_per_workstream
  on executions (wst_id)
  where state in ('requested', 'starting', 'running', 'needs_direction', 'needs_approval', 'stopping');

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
-- run commands are the reason both clients can see "Project running" at all.
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
  check (origin in ('harness', 'participant', 'external'));
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

-- The runner's command vocabulary grows with the workspace runtime. There is
-- deliberately no shell command: remote interactive access to somebody's
-- laptop is structurally absent, not merely unauthorized (D-042).
alter table runner_commands drop constraint if exists runner_commands_kind_check;
alter table runner_commands add constraint runner_commands_kind_check
  check (kind in ('start_execution', 'apply_direction', 'stop_execution', 'boundary_request',
                  'run_setup', 'run_command', 'stop_command', 'run_verification'));
