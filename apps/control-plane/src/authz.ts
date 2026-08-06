import type { Capability, MissionRole } from "@novus/contracts";
import type pg from "pg";
import type { Db } from "./db.ts";
import type { AuthedContext } from "./auth.ts";

/**
 * Authorization, in exactly one place (ARCHITECTURE.md#authorization).
 *
 * A participant's effective mission capabilities are **role capabilities ∪
 * lease-granted capabilities**, evaluated against current durable state at
 * command time. The interface renders from the result; it never grants
 * anything (AGENTS.md rule 13). Every mutating route calls `require`.
 */

const ROLE_CAPABILITIES: Record<MissionRole, Capability[]> = {
  mission_admin: [
    "mission.view",
    "mission.invite",
    // Filing a mission away is the Mission Admin's, and is not lease-granted:
    // it is a decision about the mission's place in the product, not an
    // operating verb on a running workstream (PRODUCT.md#roles-and-capabilities).
    "mission.archive",
    "direction.submit",
    "execution.start",
    "execution.stop",
    // Forking a competing approach makes a *sibling* lane with its own branch,
    // workspace and lease. It does not steer the lane it forks, so it is held
    // by role and never by the baton (D-074) — the same reasoning as archival.
    "approach.create",
    // Resolving the work: recording a decision, or asking for a revision
    // instead. Also role-held: choosing between approaches is not an operating
    // verb on either of them (D-075).
    "review.approve",
    "workspace.command",
    "control.request",
    "control.accept",
    "control.revoke"
  ],
  operator: [
    "mission.view",
    "direction.submit",
    "execution.start",
    "execution.stop",
    "approach.create",
    "review.approve",
    "workspace.command",
    "control.request",
    "control.accept"
  ],
  contributor: [
    "mission.view",
    "direction.submit",
    "execution.stop",
    "control.request",
    "control.accept"
  ],
  viewer: ["mission.view"]
};

/**
 * What holding the workstream's lease adds, whatever the holder's role. The
 * controller operates the harness: applying queued direction, starting the
 * execution that consumes it, stopping it, and offering control onward
 * (PRODUCT.md#roles-and-capabilities).
 */
const LEASE_CAPABILITIES: Capability[] = [
  "direction.apply",
  "execution.start",
  "execution.stop",
  // The controller runs the commands the project declared — and only those.
  // An interactive shell is not here, and is not anywhere (D-042).
  "workspace.command",
  // Answering the harness is the controller's, and **only** the controller's.
  // PRODUCT.md#roles-and-capabilities gives `approval.respond` to the lease
  // column alone: a Mission Admin who is not holding the baton may revoke it
  // and then answer, which is visible and logged, but may not reach around it.
  // That is why this appears here and in no role list.
  "approval.respond",
  "control.offer"
];

export interface MissionAccess {
  missionId: string;
  orgId: string;
  workstreamId: string | null;
  role: MissionRole;
  /** The workstream's current lease holder, or null when nobody holds it. */
  controllerUserId: string | null;
  leaseId: string | null;
  isController: boolean;
  capabilities: Capability[];
}

export class AuthorizationError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 403) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function capabilitiesFor(role: MissionRole, isController: boolean): Capability[] {
  const set = new Set<Capability>(ROLE_CAPABILITIES[role]);
  if (isController) for (const capability of LEASE_CAPABILITIES) set.add(capability);
  return [...set];
}

/**
 * Resolves the caller's standing in a mission. Returns null when the mission
 * does not exist, the caller is not a member of the organization that owns it,
 * or the caller is not a participant — a non-participant must not be able to
 * confirm a mission id exists by guessing it, so callers turn null into 404,
 * never 403.
 *
 * Scoping is against the **mission's** organization, not the session's. A
 * person who redeems an invitation belongs to two organizations (D-036), so a
 * single "current org" on the session cannot decide this: the mission names
 * its owner, and the caller must hold both a membership there and a
 * participant row. `orgId` below is the mission's, and every event this
 * standing authorizes is recorded against it.
 */
export async function missionAccess(
  db: Db | pg.PoolClient,
  /** Only the caller's identity is read; a full session is not required, so a
   *  server-side path can resolve someone else's standing deliberately. */
  ctx: Pick<AuthedContext, "userId">,
  missionId: string,
  /**
   * Which lane the caller is acting on (D-074). A mission may hold several:
   * the one it started with, and a sibling for every approach somebody forked.
   * Control is **per lane**, so who the controller is — and therefore what the
   * caller may do — depends on which one this names. Absent means the lane the
   * mission started with, which is every mission that never forked.
   *
   * A lane id that belongs to another mission resolves to no access at all,
   * rather than silently falling back to the default: naming someone else's
   * workstream must never widen what you can do to your own.
   */
  workstreamId?: string | null
): Promise<MissionAccess | null> {
  const result = await db.query(
    `select m.mission_id, m.org_id, p.mission_role,
            w.wst_id,
            l.lease_id, l.holder_user_id
       from missions m
       join participants p on p.mission_id = m.mission_id and p.user_id = $2
       join organization_members om on om.org_id = m.org_id and om.user_id = $2
       left join lateral (
         select w2.wst_id
           from workstreams w2
          where w2.mission_id = m.mission_id
            and ($3::text is null or w2.wst_id = $3)
          -- Oldest first, so "the mission's lane" is stable rather than
          -- whichever row the planner happened to return.
          order by w2.created_at, w2.wst_id
          limit 1
       ) w on true
       left join control_leases l
              on l.wst_id = w.wst_id and l.state in ('held', 'releasing')
      where m.mission_id = $1`,
    [missionId, ctx.userId, workstreamId ?? null]
  );
  const row = result.rows[0];
  if (!row) return null;
  // A named lane that does not belong to this mission: refused outright rather
  // than served with the default lane's authority.
  if (workstreamId && row.wst_id !== workstreamId) return null;
  const role = row.mission_role as MissionRole;
  const controllerUserId = (row.holder_user_id as string | null) ?? null;
  const isController = controllerUserId === ctx.userId;
  return {
    missionId: row.mission_id,
    orgId: row.org_id,
    workstreamId: (row.wst_id as string | null) ?? null,
    role,
    controllerUserId,
    leaseId: (row.lease_id as string | null) ?? null,
    isController,
    capabilities: capabilitiesFor(role, isController)
  };
}

/** Throws unless the access carries the capability. */
export function require(access: MissionAccess, capability: Capability): void {
  if (!access.capabilities.includes(capability)) {
    throw new AuthorizationError(
      "forbidden",
      capability === "direction.apply" ||
        capability === "control.offer" ||
        capability === "approval.respond"
        ? "Only the controller can do that."
        : "Your role in this mission doesn't allow that."
    );
  }
}

/** Resolves a workstream's mission, honouring participation. */
export async function workstreamAccess(
  db: Db,
  ctx: AuthedContext,
  workstreamId: string
): Promise<MissionAccess | null> {
  const result = await db.query(
    "select mission_id from workstreams where wst_id = $1",
    [workstreamId]
  );
  const missionId = result.rows[0]?.mission_id as string | undefined;
  if (!missionId) return null;
  // Resolved *against this lane*, so an approach's own lease decides what its
  // controller may do — rather than the mission's first lane deciding for it.
  return missionAccess(db, ctx, missionId, workstreamId);
}
