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
create table if not exists auth_flows (
  state         text primary key,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  session_token text,
  user_id       text references users(user_id)
);

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
