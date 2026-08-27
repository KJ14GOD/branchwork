import { createHash } from "node:crypto";
import type pg from "pg";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { withTransaction } from "./db.ts";
import { newOrgId, newSessionId, newSessionToken, newStateNonce, newUserId } from "./ids.ts";

export interface GithubIdentity {
  githubId: number;
  login: string;
  name: string | null;
  /** The person's own OAuth access token (D-101): held by the control plane
   *  alone so a comment from Novus can be authored as them on the host.
   *  Never served to a client, a runner, or an event. Null where the
   *  exchange returned none, or for rows from before the scope existed. */
  accessToken: string | null;
}

export interface AuthedContext {
  userId: string;
  login: string;
  name: string | null;
  orgId: string;
  orgName: string;
  sessionId: string;
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export async function startFlow(
  db: Db,
  config: Config,
  /** Test-only: which deterministic identity the gated fake upstream returns.
   *  Recorded on the flow row and read only when `fakeGithub` is on. */
  fakeLogin?: string
): Promise<{ state: string; authorizeUrl: string }> {
  const state = newStateNonce();
  await db.query("delete from auth_flows where expires_at < now()"); // opportunistic prune
  await db.query(
    "insert into auth_flows (state, expires_at, fake_login) values ($1, now() + interval '10 minutes', $2)",
    [state, config.fakeGithub ? fakeLogin ?? null : null]
  );
  const callback = `${config.publicBaseUrl}/auth/github/callback`;
  const authorizeUrl = config.fakeGithub
    ? `${config.publicBaseUrl}/auth/fake/authorize?state=${state}`
    : `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(config.githubClientId)}&redirect_uri=${encodeURIComponent(callback)}&state=${state}&scope=${encodeURIComponent("read:user repo")}`;
  return { state, authorizeUrl };
}

export async function exchangeGithubCode(
  config: Config,
  code: string,
  db?: Db,
  state?: string
): Promise<GithubIdentity> {
  if (config.fakeGithub) {
    // Deterministic test identity. Only the upstream is faked: sessions,
    // organizations, membership, invitations, and scoping are all real. A
    // per-flow login lets a test be two different people (D-027).
    let login = "spike-user";
    if (db && state) {
      const row = await db.query("select fake_login from auth_flows where state = $1", [state]);
      const hinted = row.rows[0]?.fake_login as string | null | undefined;
      if (hinted) login = hinted;
    }
    const githubId =
      login === "spike-user"
        ? 1_000_001
        : 1_000_000 + (Number.parseInt(createHash("sha256").update(login).digest("hex").slice(0, 8), 16) % 900_000) + 100;
    return {
      githubId,
      login,
      name: login.replace(/(^|-)([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase()),
      // Deterministic, obviously fake: what the attribution path stores and
      // the fake host reads back as the author's own hand.
      accessToken: `gho_fake_${login}`
    };
  }
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: config.githubClientId,
      client_secret: config.githubClientSecret,
      code
    })
  });
  if (!tokenResponse.ok) throw new Error(`github token exchange failed: ${tokenResponse.status}`);
  const tokenBody = (await tokenResponse.json()) as { access_token?: string; error?: string };
  if (!tokenBody.access_token) throw new Error(`github token exchange rejected: ${tokenBody.error ?? "no token"}`);

  const userResponse = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${tokenBody.access_token}`, accept: "application/vnd.github+json" }
  });
  if (!userResponse.ok) throw new Error(`github user lookup failed: ${userResponse.status}`);
  const user = (await userResponse.json()) as { id: number; login: string; name: string | null };
  return { githubId: user.id, login: user.login, name: user.name ?? null, accessToken: tokenBody.access_token };
}

/**
 * Upserts the user and guarantees a personal org + membership. No session is
 * created here and no credential is stored: the flow row only records which
 * user the browser leg resolved to. The session token is minted at claim time,
 * so a live token never sits in the database (D-031 audit).
 */
export async function completeFlow(
  db: Db,
  _config: Config,
  state: string,
  identity: GithubIdentity
): Promise<void> {
  await withTransaction(db, async (client) => {
    const flow = await client.query(
      "select state from auth_flows where state = $1 and expires_at > now() and user_id is null for update",
      [state]
    );
    if (flow.rowCount === 0) throw new Error("auth flow missing, expired, or already completed");

    const user = await upsertUser(client, identity);
    await ensurePersonalOrg(client, user.userId, identity.login);
    await client.query("update auth_flows set user_id = $1 where state = $2", [user.userId, state]);
  });
}

async function upsertUser(client: pg.PoolClient, identity: GithubIdentity): Promise<{ userId: string }> {
  const existing = await client.query("select user_id from users where github_id = $1", [identity.githubId]);
  if (existing.rowCount && existing.rows[0]) {
    // The token refreshes on every sign-in and never clears on a flow that
    // did not carry one — a re-auth under the old scope must not delete the
    // attribution a person already granted.
    await client.query(
      "update users set login = $2, name = $3, github_token = coalesce($4, github_token) where github_id = $1",
      [identity.githubId, identity.login, identity.name, identity.accessToken]
    );
    return { userId: existing.rows[0].user_id as string };
  }
  const userId = newUserId();
  await client.query(
    "insert into users (user_id, github_id, login, name, github_token) values ($1, $2, $3, $4, $5)",
    [userId, identity.githubId, identity.login, identity.name, identity.accessToken]
  );
  return { userId };
}

async function ensurePersonalOrg(client: pg.PoolClient, userId: string, login: string): Promise<void> {
  const membership = await client.query("select org_id from organization_members where user_id = $1", [userId]);
  if (membership.rowCount) return;
  const orgId = newOrgId();
  await client.query("insert into organizations (org_id, name) values ($1, $2)", [orgId, login]);
  await client.query(
    "insert into organization_members (org_id, user_id, org_role) values ($1, $2, 'owner')",
    [orgId, userId]
  );
}

/** One-shot claim: mints the session and hands its token over exactly once. */
export async function claimFlow(db: Db, config: Config, state: string): Promise<string | null> {
  return withTransaction(db, async (client) => {
    const row = await client.query(
      "select user_id from auth_flows where state = $1 and expires_at > now() for update",
      [state]
    );
    if (row.rowCount === 0) throw new Error("auth flow missing or expired");
    const userId = row.rows[0]?.user_id as string | null;
    if (!userId) return null; // browser leg not finished yet — keep polling

    const token = newSessionToken();
    await client.query(
      "insert into sessions (session_id, user_id, token_hash, expires_at) values ($1, $2, $3, now() + ($4 || ' hours')::interval)",
      [newSessionId(), userId, hashToken(token), String(config.sessionTtlHours)]
    );
    await client.query("delete from auth_flows where state = $1", [state]);
    return token;
  });
}

export async function authenticate(db: Db, bearerToken: string): Promise<AuthedContext | null> {
  // A person can belong to more than one organization the moment they redeem a
  // mission invitation (D-036). The session's organization is their own — the
  // oldest membership, which is the personal org created at first sign-in —
  // resolved deterministically rather than by whichever row the planner
  // happened to return. It is the scope for organization-level acts only;
  // access to a mission is decided by the mission's own organization and the
  // participant row, never by this field (see authz.ts).
  const result = await db.query(
    `select s.session_id, u.user_id, u.login, u.name, m.org_id, o.name as org_name
       from sessions s
       join users u on u.user_id = s.user_id
       join organization_members m on m.user_id = u.user_id
       join organizations o on o.org_id = m.org_id
      where s.token_hash = $1 and s.expires_at > now() and s.revoked_at is null
      order by m.created_at asc, m.org_id asc
      limit 1`,
    [hashToken(bearerToken)]
  );
  if (result.rowCount === 0 || !result.rows[0]) return null;
  const row = result.rows[0];
  return {
    userId: row.user_id,
    login: row.login,
    name: row.name,
    orgId: row.org_id,
    orgName: row.org_name,
    sessionId: row.session_id
  };
}

/**
 * The acting person's repository credential, read at the moment of the call
 * and never stored anywhere new (D-101's pattern, made the rule by D-223).
 * A person with no stored token gets a null-token actor; the provider then
 * refuses by name, and the cure is a fresh sign-in.
 */
export async function repoActorOf(db: Db, userId: string): Promise<{ token: string | null; login: string | null }> {
  const row = await db.query("select login, github_token from users where user_id = $1", [userId]);
  return {
    token: (row.rows[0]?.github_token as string | null | undefined) ?? null,
    login: (row.rows[0]?.login as string | null | undefined) ?? null
  };
}

export async function revokeSession(db: Db, sessionId: string): Promise<void> {
  await db.query("update sessions set revoked_at = now() where session_id = $1", [sessionId]);
}
