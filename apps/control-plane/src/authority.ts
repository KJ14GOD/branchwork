import { createHash } from "node:crypto";
import {
  CreateInvitationInputSchema,
  ExecutionStateSchema,
  RedeemInvitationInputSchema,
  TERMINAL_EXECUTION_STATES,
  type Invitation,
  type MissionRole
} from "@novus/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import type pg from "pg";
import { z } from "zod";
import type { RouteDeps } from "./routes.ts";
import type { AuthedContext } from "./auth.ts";
import { lockMission, withTransaction } from "./db.ts";
import { recordEvent } from "./events.ts";
import {
  AuthorizationError,
  capabilitiesFor,
  missionAccess,
  require as requireCapability,
  type MissionAccess
} from "./authz.ts";
import { activeRunner, enqueueCommand } from "./runners.ts";
import { RELIABILITY_THRESHOLDS } from "./reliability.ts";
import {
  newControlRequestId,
  newHandoffOfferId,
  newInvitationId,
  newLeaseId,
  newSecretToken
} from "./ids.ts";

/**
 * OWNER: multiplayer authority — invitations, participants, and the three
 * control machines (PRODUCT.md#control). Paths owned by this module:
 *
 *   POST   /missions/:missionId/invitations
 *   GET    /missions/:missionId/invitations
 *   POST   /invitations/:invitationId/revoke
 *   POST   /invitations/redeem
 *   POST   /missions/:missionId/control/request
 *   POST   /missions/:missionId/control/request/withdraw
 *   POST   /control/requests/:requestId/decline
 *   POST   /missions/:missionId/control/offer
 *   POST   /control/offers/:offerId/withdraw
 *   POST   /control/offers/:offerId/accept
 *   POST   /control/offers/:offerId/decline
 *   POST   /missions/:missionId/control/revoke
 *
 * No other module registers a path under /invitations or /control.
 *
 * Two rules carry this module's weight:
 *
 *  - Authority is decided from current durable state, never from what the
 *    client claims. Every mutating route resolves `missionAccess` (null → 404,
 *    so a mission id can never be probed) and then enforces the capability or
 *    the named identity the product assigns to that verb.
 *  - Every lease movement is a compare-and-swap on (lease_id, state) taken
 *    under the per-mission ordering point, so two clients can never both
 *    believe they hold control: one wins, the loser gets an explicit rejection
 *    (ARCHITECTURE.md#authorization).
 */

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

const MissionParams = z.object({ missionId: z.string().startsWith("msn_") });
const InvitationParams = z.object({ invitationId: z.string().startsWith("inv_") });
const RequestParams = z.object({ requestId: z.string().startsWith("crq_") });
const OfferParams = z.object({ offerId: z.string().startsWith("hof_") });
/** Wire shape for the offer body; the contract package carries no schema for
 *  a single path parameter's sibling. */
const OfferInput = z.object({ toUserId: z.string().startsWith("usr_") });

/** The states the executions partial unique index calls active: while any of
 *  them is live the workstream is not at a safe boundary. Derived from the
 *  contract so the two lists cannot drift. */
const ACTIVE_EXECUTION_STATES: string[] = ExecutionStateSchema.options.filter(
  (state) => !TERMINAL_EXECUTION_STATES.includes(state)
);

// --- Invitations ------------------------------------------------------------

interface InvitationRow {
  inv_id: string;
  mission_id: string;
  mission_role: string;
  created_at: Date;
  expires_at: Date;
  redeemed_at: Date | null;
  revoked_at: Date | null;
  redeemed_by_login: string | null;
}

const INVITATION_SELECT = `
  select i.inv_id, i.mission_id, i.mission_role, i.created_at, i.expires_at,
         i.redeemed_at, i.revoked_at, u.login as redeemed_by_login
    from invitations i
    left join users u on u.user_id = i.redeemed_by`;

function toInvitation(row: InvitationRow): Invitation {
  return {
    invitationId: row.inv_id,
    missionId: row.mission_id,
    role: row.mission_role as MissionRole,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    redeemedAt: row.redeemed_at ? row.redeemed_at.toISOString() : null,
    redeemedByLogin: row.redeemed_by_login,
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null
  };
}

// --- Shared mechanics -------------------------------------------------------

interface CurrentLease {
  leaseId: string;
  holderUserId: string;
  state: "held" | "releasing";
}

/** The workstream's live lease, row-locked for the rest of the transaction. */
async function currentLease(
  client: pg.PoolClient,
  workstreamId: string
): Promise<CurrentLease | null> {
  const result = await client.query(
    `select lease_id, holder_user_id, state from control_leases
      where wst_id = $1 and state in ('held', 'releasing') for update`,
    [workstreamId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    leaseId: row.lease_id as string,
    holderUserId: row.holder_user_id as string,
    state: row.state as CurrentLease["state"]
  };
}

async function loginOf(client: pg.PoolClient, userId: string): Promise<string> {
  const result = await client.query("select login from users where user_id = $1", [userId]);
  return (result.rows[0]?.login as string | undefined) ?? userId;
}

/** Control lives on a workstream; a mission without one has nothing to hold. */
function requireWorkstream(standing: MissionAccess): string {
  if (!standing.workstreamId) {
    throw new AuthorizationError("no_workstream", "This mission has no workstream yet.", 409);
  }
  return standing.workstreamId;
}

/**
 * True while an execution is mid-flight. A workstream with no non-terminal
 * execution is already at a safe boundary and its transfer completes
 * control-plane-side with no runner round-trip; while one is live, only the
 * runner can say when the harness is awaiting input
 * (ARCHITECTURE.md#control-transfer-mechanics).
 */
async function hasActiveExecution(client: pg.PoolClient, workstreamId: string): Promise<boolean> {
  const result = await client.query(
    // Write turns only (D-095): a read turn running alongside holds no claim
    // on the worktree, so an otherwise-idle lane transfers immediately — the
    // read turn keeps running under D-034's rule that transfer removes future
    // authority and never ends authorized work (it could not write anyway).
    "select 1 from executions where wst_id = $1 and state = any($2::text[]) and access = 'write' limit 1",
    [workstreamId, ACTIVE_EXECUTION_STATES]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Asks the runner to acknowledge at its next safe boundary
 * (ARCHITECTURE.md#control-transfer-mechanics: the control plane marks the
 * lease `releasing` and sends `report_boundary_request`).
 *
 * This half was protocol surface with no sender until approvals arrived, and
 * approvals are what make it load-bearing: a harness blocked on a permission
 * prompt is at a safe boundary and can stay there indefinitely, because the
 * only person allowed to answer is the one waiting for the transfer. Without
 * the ask, that transfer waits for a turn that is waiting for the transfer.
 *
 * The runner answers only when it is genuinely at a boundary; a turn that is
 * merely working still reports its own boundary when it ends, exactly as
 * before. Nothing here forces or interrupts anything.
 */
async function requestBoundary(
  client: pg.PoolClient,
  args: { orgId: string; missionId: string; workstreamId: string; offerId: string }
): Promise<void> {
  const runner = await activeRunner(client, args.workstreamId);
  const runnerId = runner?.runnerId;
  if (!runnerId) return;
  const running = await client.query(
    "select exe_id from executions where wst_id = $1 and state = any($2::text[]) limit 1",
    [args.workstreamId, ACTIVE_EXECUTION_STATES]
  );
  await enqueueCommand(client, {
    orgId: args.orgId,
    missionId: args.missionId,
    workstreamId: args.workstreamId,
    executionId: (running.rows[0]?.exe_id as string | undefined) ?? null,
    runnerId,
    kind: "boundary_request",
    payload: { offerId: args.offerId },
    idempotencyKey: `boundary:${args.offerId}`
  });
}

/**
 * Closes the workstream's remaining open requests as `superseded`. Returns the
 * logins closed, so the caller records one honest event instead of N.
 */
async function supersedeOpenRequests(
  client: pg.PoolClient,
  workstreamId: string
): Promise<string[]> {
  const open = await client.query(
    `select u.login from control_requests r join users u on u.user_id = r.requester_user_id
      where r.wst_id = $1 and r.state = 'open'`,
    [workstreamId]
  );
  if (open.rowCount === 0) return [];
  await client.query(
    "update control_requests set state = 'superseded', ended_at = now() where wst_id = $1 and state = 'open'",
    [workstreamId]
  );
  return open.rows.map((row) => row.login as string);
}

/**
 * Completes an accepted handoff once the runner declares a safe boundary, or
 * immediately when the workstream is idle. Called from runner event ingestion
 * (`boundary.reached`) and from the offer-accept path when no execution is
 * active. Idempotent: a second call after the transfer completed is a no-op.
 *
 * Returns the new holder's user id when a transfer completed, else null.
 */
export async function completeTransferAtBoundary(
  client: pg.PoolClient,
  args: { orgId: string; missionId: string; workstreamId: string }
): Promise<string | null> {
  await lockMission(client, args.missionId);

  const pending = await client.query(
    `select o.offer_id, o.from_user_id, o.to_user_id, o.lease_id,
            f.login as from_login, t.login as to_login
       from handoff_offers o
       join users f on f.user_id = o.from_user_id
       join users t on t.user_id = o.to_user_id
      where o.wst_id = $1 and o.state in ('accepted', 'waiting_for_boundary')
      order by o.created_at desc limit 1
        for update of o`,
    [args.workstreamId]
  );
  const offer = pending.rows[0];
  if (!offer) return null;

  // Compare-and-swap. Zero rows means someone else already moved this lease —
  // a revoke, or a boundary reported twice — and this call must change nothing.
  const released = await client.query(
    `update control_leases set state = 'transferred', ended_at = now()
      where lease_id = $1 and state in ('held', 'releasing') returning lease_id`,
    [offer.lease_id]
  );
  if (released.rowCount === 0) return null;

  const leaseId = newLeaseId();
  const recipient = offer.to_user_id as string;
  await client.query(
    `insert into control_leases (lease_id, org_id, mission_id, wst_id, holder_user_id, state)
       values ($1, $2, $3, $4, $5, 'held')`,
    [leaseId, args.orgId, args.missionId, args.workstreamId, recipient]
  );
  await client.query(
    "update handoff_offers set state = 'completed', ended_at = now() where offer_id = $1",
    [offer.offer_id]
  );

  await recordEvent(client, {
    orgId: args.orgId,
    missionId: args.missionId,
    workstreamId: args.workstreamId,
    kind: "control.transferred",
    actorKind: "system",
    actorId: "control-plane",
    causeLeaseId: leaseId,
    payload: { fromLogin: offer.from_login, toLogin: offer.to_login }
  });

  const fulfilled = await client.query(
    `update control_requests set state = 'fulfilled', ended_at = now()
      where wst_id = $1 and requester_user_id = $2 and state = 'open' returning req_id`,
    [args.workstreamId, recipient]
  );
  if (fulfilled.rowCount) {
    await recordEvent(client, {
      orgId: args.orgId,
      missionId: args.missionId,
      workstreamId: args.workstreamId,
      kind: "control.request_fulfilled",
      actorKind: "system",
      actorId: "control-plane",
      causeLeaseId: leaseId,
      payload: { requesterLogin: offer.to_login }
    });
  }
  // A completed transfer closes every other open request (PRODUCT.md#control).
  const superseded = await supersedeOpenRequests(client, args.workstreamId);
  if (superseded.length > 0) {
    await recordEvent(client, {
      orgId: args.orgId,
      missionId: args.missionId,
      workstreamId: args.workstreamId,
      kind: "control.requests_superseded",
      actorKind: "system",
      actorId: "control-plane",
      causeLeaseId: leaseId,
      payload: { logins: superseded, reason: "control_transferred" }
    });
  }

  return recipient;
}

export function registerAuthorityRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { db, requireAuth, sendError } = deps;

  /** A mission the caller cannot see does not exist for them — 404, not 403. */
  const notFound = (reply: FastifyReply) =>
    sendError(reply, 404, "not_found", "No such mission in your organization.");

  // --- Invitations ----------------------------------------------------------

  app.post("/missions/:missionId/invitations", async (request, reply) => {
    const ctx = await requireAuth(request, reply);
    if (!ctx) return;
    const params = MissionParams.safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "bad_id", "Malformed mission id.");
    const body = CreateInvitationInputSchema.safeParse(request.body ?? {});
    if (!body.success) return sendError(reply, 422, "invalid_invitation", "That isn't a mission role.");
    const standing = await missionAccess(db, ctx, params.data.missionId);
    if (!standing) return notFound(reply);
    requireCapability(standing, "mission.invite");

    // The usable token exists in this process and in the response, nowhere
    // else: only its hash is stored (ARCHITECTURE.md#authentication).
    const token = newSecretToken();
    const invitationId = newInvitationId();
    const invitation = await withTransaction(db, async (client) => {
      await client.query(
        `insert into invitations (inv_id, org_id, mission_id, mission_role, token_hash, created_by, expires_at)
           values ($1, $2, $3, $4, $5, $6, now() + interval '7 days')`,
        [invitationId, standing.orgId, standing.missionId, body.data.role, hashToken(token), ctx.userId]
      );
      await recordEvent(client, {
        orgId: standing.orgId,
        missionId: standing.missionId,
        workstreamId: standing.workstreamId,
        kind: "invitation.created",
        actorKind: "user",
        actorId: ctx.userId,
        actorLogin: ctx.login,
        payload: { invitationId, role: body.data.role }
      });
      const row = await client.query(`${INVITATION_SELECT} where i.inv_id = $1`, [invitationId]);
      return toInvitation(row.rows[0] as InvitationRow);
    });
    return reply.status(201).send({ invitation, token });
  });

  app.get("/missions/:missionId/invitations", async (request, reply) => {
    const ctx = await requireAuth(request, reply);
    if (!ctx) return;
    const params = MissionParams.safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "bad_id", "Malformed mission id.");
    const standing = await missionAccess(db, ctx, params.data.missionId);
    if (!standing) return notFound(reply);
    requireCapability(standing, "mission.invite");

    const rows = await db.query(
      `${INVITATION_SELECT} where i.mission_id = $1 order by i.created_at desc`,
      [standing.missionId]
    );
    return { invitations: (rows.rows as InvitationRow[]).map(toInvitation) };
  });

  app.post("/invitations/:invitationId/revoke", async (request, reply) => {
    const ctx = await requireAuth(request, reply);
    if (!ctx) return;
    const params = InvitationParams.safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "bad_id", "Malformed invitation id.");

    const found = await db.query(
      "select inv_id, mission_id, redeemed_at, revoked_at from invitations where inv_id = $1",
      [params.data.invitationId]
    );
    const invitation = found.rows[0];
    // Unknown ids and other organizations' ids answer identically.
    if (!invitation) return sendError(reply, 404, "not_found", "No such invitation.");
    const standing = await missionAccess(db, ctx, invitation.mission_id as string);
    if (!standing) return sendError(reply, 404, "not_found", "No such invitation.");
    requireCapability(standing, "mission.invite");
    if (invitation.redeemed_at) {
      return sendError(reply, 409, "invitation_redeemed", "That invitation was already redeemed.");
    }

    await withTransaction(db, async (client) => {
      const revoked = await client.query(
        "update invitations set revoked_at = now() where inv_id = $1 and revoked_at is null returning inv_id",
        [params.data.invitationId]
      );
      if (revoked.rowCount === 0) return; // already revoked: no second event
      await recordEvent(client, {
        orgId: standing.orgId,
        missionId: standing.missionId,
        workstreamId: standing.workstreamId,
        kind: "invitation.revoked",
        actorKind: "user",
        actorId: ctx.userId,
        actorLogin: ctx.login,
        payload: { invitationId: params.data.invitationId }
      });
    });
    return { ok: true };
  });

  /**
   * Redemption is the one authority route that requires a session but no prior
   * standing: the token is the grant. It is looked up by hash alone — never
   * scoped to the caller's organization — because joining an organization is
   * exactly what it does. The participant row is created for the invitation's
   * own mission, so a token for mission X grants nothing anywhere else.
   */
  app.post("/invitations/redeem", async (request, reply) => {
    const ctx = await requireAuth(request, reply);
    if (!ctx) return;
    const body = RedeemInvitationInputSchema.safeParse(request.body);
    if (!body.success) return sendError(reply, 422, "invalid_token", "That isn't an invitation token.");

    const found = await db.query(
      "select inv_id, org_id, mission_id, mission_role, expires_at, redeemed_at, revoked_at from invitations where token_hash = $1",
      [hashToken(body.data.token)]
    );
    const invitation = found.rows[0];
    if (!invitation) return sendError(reply, 404, "unknown_invitation", "That invitation link isn't valid.");
    if (invitation.revoked_at) {
      return sendError(reply, 409, "invitation_revoked", "That invitation was revoked.");
    }
    if (invitation.redeemed_at) {
      return sendError(reply, 409, "invitation_redeemed", "That invitation was already used.");
    }
    if ((invitation.expires_at as Date).getTime() <= Date.now()) {
      return sendError(reply, 410, "invitation_expired", "That invitation has expired. Ask for a new one.");
    }

    const orgId = invitation.org_id as string;
    const missionId = invitation.mission_id as string;
    let invitedRole = invitation.mission_role as MissionRole;
    // An invitation redeemed after the mission reached a terminal state
    // succeeds as read access (ARCHITECTURE.md failure mode 13, D-121): the
    // participant joins as Viewer and sees history and receipt — no
    // operational verbs, whatever role the invitation carried.
    const terminal = await db.query(
      "select 1 from missions where mission_id = $1 and closed_at is not null",
      [missionId]
    );
    if ((terminal.rowCount ?? 0) > 0) invitedRole = "viewer";

    const role = await withTransaction(db, async (client) => {
      // Single use is enforced by the write, not by the read above: the loser
      // of two simultaneous redemptions changes nothing and is told so.
      const claimed = await client.query(
        `update invitations set redeemed_at = now(), redeemed_by = $2
          where inv_id = $1 and redeemed_at is null and revoked_at is null and expires_at > now()
          returning inv_id`,
        [invitation.inv_id, ctx.userId]
      );
      if (claimed.rowCount === 0) {
        throw new AuthorizationError("invitation_redeemed", "That invitation was already used.", 409);
      }
      // Least privilege: an invitation makes you a member of the organization,
      // never an owner (PRODUCT.md#roles-and-capabilities).
      await client.query(
        `insert into organization_members (org_id, user_id, org_role) values ($1, $2, 'member')
           on conflict (org_id, user_id) do nothing`,
        [orgId, ctx.userId]
      );
      const joined = await client.query(
        `insert into participants (mission_id, user_id, mission_role) values ($1, $2, $3)
           on conflict (mission_id, user_id) do nothing
           returning mission_role`,
        [missionId, ctx.userId, invitedRole]
      );
      if (joined.rowCount === 0) {
        // Already a participant: the invitation is spent, the role it named is
        // not applied on top of a standing the mission already granted.
        const existing = await client.query(
          "select mission_role from participants where mission_id = $1 and user_id = $2",
          [missionId, ctx.userId]
        );
        return existing.rows[0]?.mission_role as MissionRole;
      }
      await recordEvent(client, {
        orgId,
        missionId,
        kind: "participant.joined",
        actorKind: "user",
        actorId: ctx.userId,
        actorLogin: ctx.login,
        payload: { login: ctx.login, role: invitedRole, invitationId: invitation.inv_id }
      });
      return invitedRole;
    });

    return { missionId, role };
  });

  // --- ControlRequest -------------------------------------------------------

  app.post("/missions/:missionId/control/request", async (request, reply) => {
    const ctx = await requireAuth(request, reply);
    if (!ctx) return;
    const params = MissionParams.safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "bad_id", "Malformed mission id.");
    const standing = await missionAccess(db, ctx, params.data.missionId);
    if (!standing) return notFound(reply);
    requireCapability(standing, "control.request");
    const workstreamId = requireWorkstream(standing);

    await withTransaction(db, async (client) => {
      await lockMission(client, standing.missionId);
      const lease = await currentLease(client, workstreamId);

      if (lease && lease.holderUserId === ctx.userId) {
        throw new AuthorizationError("already_controller", "You already hold control.", 409);
      }

      if (!lease) {
        // Nobody holds it: this request is a claim, and the server fulfils it
        // immediately. First accepted wins — the partial unique index decides
        // (PRODUCT.md#control).
        const reopened = await client.query(
          `update control_requests set state = 'fulfilled', ended_at = now()
            where wst_id = $1 and requester_user_id = $2 and state = 'open' returning req_id`,
          [workstreamId, ctx.userId]
        );
        if (reopened.rowCount === 0) {
          await client.query(
            `insert into control_requests (req_id, org_id, mission_id, wst_id, requester_user_id, state, ended_at)
               values ($1, $2, $3, $4, $5, 'fulfilled', now())`,
            [newControlRequestId(), standing.orgId, standing.missionId, workstreamId, ctx.userId]
          );
        }
        const leaseId = newLeaseId();
        await client.query(
          `insert into control_leases (lease_id, org_id, mission_id, wst_id, holder_user_id, state)
             values ($1, $2, $3, $4, $5, 'held')`,
          [leaseId, standing.orgId, standing.missionId, workstreamId, ctx.userId]
        );
        await recordEvent(client, {
          orgId: standing.orgId,
          missionId: standing.missionId,
          workstreamId,
          kind: "control.requested",
          actorKind: "user",
          actorId: ctx.userId,
          actorLogin: ctx.login,
          payload: { requesterLogin: ctx.login, unheld: true }
        });
        await recordEvent(client, {
          orgId: standing.orgId,
          missionId: standing.missionId,
          workstreamId,
          kind: "control.granted",
          actorKind: "system",
          actorId: "control-plane",
          causeLeaseId: leaseId,
          payload: { holderLogin: ctx.login, reason: "claimed" }
        });
        return;
      }

      // A second request from the same person is a no-op, not a duplicate row:
      // the partial unique index is the arbiter, not a read-then-write.
      const opened = await client.query(
        `insert into control_requests (req_id, org_id, mission_id, wst_id, requester_user_id, state)
           values ($1, $2, $3, $4, $5, 'open')
           on conflict (wst_id, requester_user_id) where state = 'open' do nothing
           returning req_id`,
        [newControlRequestId(), standing.orgId, standing.missionId, workstreamId, ctx.userId]
      );
      if (opened.rowCount === 0) return;
      await recordEvent(client, {
        orgId: standing.orgId,
        missionId: standing.missionId,
        workstreamId,
        kind: "control.requested",
        actorKind: "user",
        actorId: ctx.userId,
        actorLogin: ctx.login,
        causeLeaseId: lease.leaseId,
        payload: { requesterLogin: ctx.login, holderLogin: await loginOf(client, lease.holderUserId) }
      });
    });
    return { ok: true };
  });

  app.post("/missions/:missionId/control/request/withdraw", async (request, reply) => {
    const ctx = await requireAuth(request, reply);
    if (!ctx) return;
    const params = MissionParams.safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "bad_id", "Malformed mission id.");
    const standing = await missionAccess(db, ctx, params.data.missionId);
    if (!standing) return notFound(reply);
    // Withdrawing your own request grants nothing, so the check that matters is
    // identity: the update below only ever touches this caller's open row.
    const workstreamId = requireWorkstream(standing);

    await withTransaction(db, async (client) => {
      await lockMission(client, standing.missionId);
      const withdrawn = await client.query(
        `update control_requests set state = 'withdrawn', ended_at = now()
          where wst_id = $1 and requester_user_id = $2 and state = 'open' returning req_id`,
        [workstreamId, ctx.userId]
      );
      if (withdrawn.rowCount === 0) {
        throw new AuthorizationError("no_open_request", "You have no open request for control.", 409);
      }
      await recordEvent(client, {
        orgId: standing.orgId,
        missionId: standing.missionId,
        workstreamId,
        kind: "control.request_withdrawn",
        actorKind: "user",
        actorId: ctx.userId,
        actorLogin: ctx.login,
        causeLeaseId: standing.leaseId,
        payload: { requesterLogin: ctx.login }
      });
    });
    return { ok: true };
  });

  app.post("/control/requests/:requestId/decline", async (request, reply) => {
    const ctx = await requireAuth(request, reply);
    if (!ctx) return;
    const params = RequestParams.safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "bad_id", "Malformed request id.");

    const found = await db.query(
      "select req_id, mission_id, wst_id, requester_user_id, state from control_requests where req_id = $1",
      [params.data.requestId]
    );
    const row = found.rows[0];
    if (!row) return sendError(reply, 404, "not_found", "No such control request.");
    const standing = await missionAccess(db, ctx, row.mission_id as string);
    if (!standing) return sendError(reply, 404, "not_found", "No such control request.");
    requireCapability(standing, "control.offer");

    await withTransaction(db, async (client) => {
      await lockMission(client, standing.missionId);
      const declined = await client.query(
        `update control_requests set state = 'declined', ended_at = now()
          where req_id = $1 and state = 'open' returning req_id`,
        [params.data.requestId]
      );
      if (declined.rowCount === 0) {
        throw new AuthorizationError("request_settled", "That request for control is no longer open.", 409);
      }
      await recordEvent(client, {
        orgId: standing.orgId,
        missionId: standing.missionId,
        workstreamId: row.wst_id as string,
        kind: "control.request_declined",
        actorKind: "user",
        actorId: ctx.userId,
        actorLogin: ctx.login,
        causeLeaseId: standing.leaseId,
        payload: { requesterLogin: await loginOf(client, row.requester_user_id as string) }
      });
    });
    return { ok: true };
  });

  // --- HandoffOffer ---------------------------------------------------------

  app.post("/missions/:missionId/control/offer", async (request, reply) => {
    const ctx = await requireAuth(request, reply);
    if (!ctx) return;
    const params = MissionParams.safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "bad_id", "Malformed mission id.");
    const body = OfferInput.safeParse(request.body);
    if (!body.success) return sendError(reply, 422, "invalid_offer", "Name who should take control.");
    const standing = await missionAccess(db, ctx, params.data.missionId);
    if (!standing) return notFound(reply);
    requireCapability(standing, "control.offer");
    const workstreamId = requireWorkstream(standing);
    if (body.data.toUserId === ctx.userId) {
      return sendError(reply, 422, "self_offer", "You already hold control.");
    }

    const offerId = newHandoffOfferId();
    await withTransaction(db, async (client) => {
      await lockMission(client, standing.missionId);
      // Re-read under the lock: the capability check above ran against state
      // that may have moved, and the offer must bind to the live lease.
      const lease = await currentLease(client, workstreamId);
      if (!lease || lease.holderUserId !== ctx.userId) {
        throw new AuthorizationError("forbidden", "Only the controller can do that.");
      }
      const recipient = await client.query(
        "select mission_role from participants where mission_id = $1 and user_id = $2",
        [standing.missionId, body.data.toUserId]
      );
      const role = recipient.rows[0]?.mission_role as MissionRole | undefined;
      if (!role) {
        throw new AuthorizationError(
          "not_a_participant",
          "You can only hand control to someone in this mission.",
          422
        );
      }
      // Offering control to someone who cannot accept it would create a dead
      // offer; the capability model already says who may accept.
      if (!capabilitiesFor(role, false).includes("control.accept")) {
        throw new AuthorizationError(
          "recipient_cannot_accept",
          "That participant's role can't take control.",
          422
        );
      }
      const created = await client.query(
        `insert into handoff_offers (offer_id, org_id, mission_id, wst_id, from_user_id, to_user_id, lease_id, state, expires_at)
           values ($1, $2, $3, $4, $5, $6, $7, 'open', now() + ($8 || ' milliseconds')::interval)
           on conflict (wst_id) where state in ('open', 'accepted', 'waiting_for_boundary') do nothing
           returning offer_id`,
        [
          offerId,
          standing.orgId,
          standing.missionId,
          workstreamId,
          ctx.userId,
          body.data.toUserId,
          lease.leaseId,
          RELIABILITY_THRESHOLDS.OFFER_TTL_MS
        ]
      );
      if (created.rowCount === 0) {
        throw new AuthorizationError(
          "offer_live",
          "A handoff offer is already live on this workstream. Withdraw it first.",
          409
        );
      }
      await recordEvent(client, {
        orgId: standing.orgId,
        missionId: standing.missionId,
        workstreamId,
        kind: "control.offered",
        actorKind: "user",
        actorId: ctx.userId,
        actorLogin: ctx.login,
        causeLeaseId: lease.leaseId,
        payload: {
          offerId,
          fromLogin: ctx.login,
          toLogin: await loginOf(client, body.data.toUserId)
        }
      });
    });
    return { ok: true };
  });

  interface OfferRow {
    offer_id: string;
    mission_id: string;
    wst_id: string;
    from_user_id: string;
    to_user_id: string;
    lease_id: string;
    state: string;
  }

  /** Loads an offer and the caller's standing in its mission, or replies 404. */
  const loadOffer = async (
    reply: FastifyReply,
    ctx: AuthedContext,
    offerId: string
  ): Promise<{ offer: OfferRow; standing: MissionAccess } | null> => {
    const found = await db.query(
      "select offer_id, mission_id, wst_id, from_user_id, to_user_id, lease_id, state from handoff_offers where offer_id = $1",
      [offerId]
    );
    const offer = found.rows[0] as OfferRow | undefined;
    // An offer in a mission the caller cannot see answers exactly as an unknown
    // id does, so neither can be probed.
    if (!offer) {
      await sendError(reply, 404, "not_found", "No such handoff offer.");
      return null;
    }
    const standing = await missionAccess(db, ctx, offer.mission_id);
    if (!standing) {
      await sendError(reply, 404, "not_found", "No such handoff offer.");
      return null;
    }
    return { offer, standing };
  };

  app.post("/control/offers/:offerId/withdraw", async (request, reply) => {
    const ctx = await requireAuth(request, reply);
    if (!ctx) return;
    const params = OfferParams.safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "bad_id", "Malformed offer id.");
    const loaded = await loadOffer(reply, ctx, params.data.offerId);
    if (!loaded) return;
    const { offer, standing } = loaded;
    if (offer.from_user_id !== ctx.userId) {
      throw new AuthorizationError("not_offerer", "Only the controller who offered control can withdraw it.");
    }

    await withTransaction(db, async (client) => {
      await lockMission(client, standing.missionId);
      const withdrawn = await client.query(
        `update handoff_offers set state = 'withdrawn', ended_at = now()
          where offer_id = $1 and state = 'open' returning offer_id`,
        [offer.offer_id]
      );
      if (withdrawn.rowCount === 0) {
        throw new AuthorizationError("offer_settled", "That handoff offer is no longer open.", 409);
      }
      await recordEvent(client, {
        orgId: standing.orgId,
        missionId: standing.missionId,
        workstreamId: offer.wst_id,
        kind: "control.offer_withdrawn",
        actorKind: "user",
        actorId: ctx.userId,
        actorLogin: ctx.login,
        causeLeaseId: offer.lease_id,
        payload: { offerId: offer.offer_id, toLogin: await loginOf(client, offer.to_user_id) }
      });
    });
    return { ok: true };
  });

  app.post("/control/offers/:offerId/decline", async (request, reply) => {
    const ctx = await requireAuth(request, reply);
    if (!ctx) return;
    const params = OfferParams.safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "bad_id", "Malformed offer id.");
    const loaded = await loadOffer(reply, ctx, params.data.offerId);
    if (!loaded) return;
    const { offer, standing } = loaded;
    // Declining takes nothing and grants nothing; the named recipient is the
    // only person it can belong to.
    if (offer.to_user_id !== ctx.userId) {
      throw new AuthorizationError("not_recipient", "Only the person offered control can answer it.");
    }

    await withTransaction(db, async (client) => {
      await lockMission(client, standing.missionId);
      const declined = await client.query(
        `update handoff_offers set state = 'declined', ended_at = now()
          where offer_id = $1 and state = 'open' returning offer_id`,
        [offer.offer_id]
      );
      if (declined.rowCount === 0) {
        throw new AuthorizationError("offer_settled", "That handoff offer is no longer open.", 409);
      }
      await recordEvent(client, {
        orgId: standing.orgId,
        missionId: standing.missionId,
        workstreamId: offer.wst_id,
        kind: "control.offer_declined",
        actorKind: "user",
        actorId: ctx.userId,
        actorLogin: ctx.login,
        causeLeaseId: offer.lease_id,
        payload: { offerId: offer.offer_id, fromLogin: await loginOf(client, offer.from_user_id) }
      });
    });
    return { ok: true };
  });

  app.post("/control/offers/:offerId/accept", async (request, reply) => {
    const ctx = await requireAuth(request, reply);
    if (!ctx) return;
    const params = OfferParams.safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "bad_id", "Malformed offer id.");
    const loaded = await loadOffer(reply, ctx, params.data.offerId);
    if (!loaded) return;
    const { offer, standing } = loaded;
    if (offer.to_user_id !== ctx.userId) {
      throw new AuthorizationError("not_recipient", "Only the person offered control can accept it.");
    }
    requireCapability(standing, "control.accept");

    await withTransaction(db, async (client) => {
      await lockMission(client, standing.missionId);
      // Compare-and-swap on the offer: of two simultaneous accepts exactly one
      // moves the row, and the loser is told the offer already settled. An
      // offer past its expiry is refused here even before the sweep has moved
      // it (D-092): expiry is the offer's own fact, not the sweep's schedule.
      const accepted = await client.query(
        `update handoff_offers set state = 'accepted', accepted_at = now()
          where offer_id = $1 and state = 'open'
            and coalesce(expires_at, created_at + ($2 || ' milliseconds')::interval) > now()
          returning offer_id`,
        [offer.offer_id, RELIABILITY_THRESHOLDS.OFFER_TTL_MS]
      );
      if (accepted.rowCount === 0) {
        throw new AuthorizationError("offer_settled", "That handoff offer is no longer open.", 409);
      }
      await recordEvent(client, {
        orgId: standing.orgId,
        missionId: standing.missionId,
        workstreamId: offer.wst_id,
        kind: "control.offer_accepted",
        actorKind: "user",
        actorId: ctx.userId,
        actorLogin: ctx.login,
        causeLeaseId: offer.lease_id,
        payload: { offerId: offer.offer_id, fromLogin: await loginOf(client, offer.from_user_id) }
      });

      if (!(await hasActiveExecution(client, offer.wst_id))) {
        // An idle workstream is already at a safe boundary, so the transfer
        // completes here with no runner round-trip (ARCHITECTURE.md).
        await completeTransferAtBoundary(client, {
          orgId: standing.orgId,
          missionId: standing.missionId,
          workstreamId: offer.wst_id
        });
        return;
      }

      const releasing = await client.query(
        `update control_leases set state = 'releasing', pending_recipient_user_id = $2
          where lease_id = $1 and state = 'held' returning lease_id`,
        [offer.lease_id, ctx.userId]
      );
      if (releasing.rowCount === 0) {
        // The lease moved between the offer and this accept; rolling back
        // leaves the offer open rather than half-applying the transfer.
        throw new AuthorizationError("lease_moved", "Control moved before this handoff could start.", 409);
      }
      await client.query("update handoff_offers set state = 'waiting_for_boundary' where offer_id = $1", [
        offer.offer_id
      ]);
      await recordEvent(client, {
        orgId: standing.orgId,
        missionId: standing.missionId,
        workstreamId: offer.wst_id,
        kind: "control.waiting_for_boundary",
        actorKind: "system",
        actorId: "control-plane",
        causeLeaseId: offer.lease_id,
        payload: { offerId: offer.offer_id, toLogin: ctx.login }
      });
      await requestBoundary(client, {
        orgId: standing.orgId,
        missionId: standing.missionId,
        workstreamId: offer.wst_id,
        offerId: offer.offer_id as string
      });
    });
    return { ok: true };
  });

  // --- Revocation -----------------------------------------------------------

  /**
   * The Mission Admin's force-take (PRODUCT.md#control): always available,
   * always logged, never silent. It closes the live offer as `failed` and every
   * open request as `superseded`, because the authority they were waiting on
   * no longer exists.
   */
  app.post("/missions/:missionId/control/revoke", async (request, reply) => {
    const ctx = await requireAuth(request, reply);
    if (!ctx) return;
    const params = MissionParams.safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "bad_id", "Malformed mission id.");
    const standing = await missionAccess(db, ctx, params.data.missionId);
    if (!standing) return notFound(reply);
    requireCapability(standing, "control.revoke");
    const workstreamId = requireWorkstream(standing);

    await withTransaction(db, async (client) => {
      await lockMission(client, standing.missionId);
      const lease = await currentLease(client, workstreamId);

      const live = await client.query(
        `update handoff_offers set state = 'failed', ended_at = now()
          where wst_id = $1 and state in ('open', 'accepted', 'waiting_for_boundary')
          returning offer_id, to_user_id, lease_id`,
        [workstreamId]
      );
      for (const row of live.rows) {
        await recordEvent(client, {
          orgId: standing.orgId,
          missionId: standing.missionId,
          workstreamId,
          kind: "control.offer_failed",
          actorKind: "user",
          actorId: ctx.userId,
          actorLogin: ctx.login,
          causeLeaseId: row.lease_id as string,
          payload: {
            offerId: row.offer_id as string,
            toLogin: await loginOf(client, row.to_user_id as string),
            reason: "control_revoked"
          }
        });
      }

      const fromLogin = lease ? await loginOf(client, lease.holderUserId) : null;
      let leaseId: string;
      if (lease && lease.holderUserId === ctx.userId) {
        // Already the holder: the force-take is the closing of what was pending
        // above, and the lease itself stays as it is.
        leaseId = lease.leaseId;
      } else {
        if (lease) {
          await client.query(
            "update control_leases set state = 'revoked', ended_at = now() where lease_id = $1 and state in ('held', 'releasing')",
            [lease.leaseId]
          );
        }
        leaseId = newLeaseId();
        await client.query(
          `insert into control_leases (lease_id, org_id, mission_id, wst_id, holder_user_id, state)
             values ($1, $2, $3, $4, $5, 'held')`,
          [leaseId, standing.orgId, standing.missionId, workstreamId, ctx.userId]
        );
      }

      await recordEvent(client, {
        orgId: standing.orgId,
        missionId: standing.missionId,
        workstreamId,
        kind: "control.revoked",
        actorKind: "user",
        actorId: ctx.userId,
        actorLogin: ctx.login,
        causeLeaseId: leaseId,
        payload: { fromLogin, toLogin: ctx.login }
      });

      const superseded = await supersedeOpenRequests(client, workstreamId);
      if (superseded.length > 0) {
        await recordEvent(client, {
          orgId: standing.orgId,
          missionId: standing.missionId,
          workstreamId,
          kind: "control.requests_superseded",
          actorKind: "system",
          actorId: "control-plane",
          causeLeaseId: leaseId,
          payload: { logins: superseded, reason: "control_revoked" }
        });
      }
    });
    return { ok: true };
  });
}
