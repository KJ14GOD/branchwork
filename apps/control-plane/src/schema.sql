-- Control-plane schema, V0 vertical slice.
-- Representation rules: ARCHITECTURE.md#data-model. Concepts: PRODUCT.md#domain-model.

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
