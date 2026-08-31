import type { Direction, DirectionAttachment, DirectionContextRef, DirectionState } from "@novus/contracts";
import type pg from "pg";
import type { Db, Queryable } from "./db.ts";
import { withTransaction } from "./db.ts";
import { recordEvent } from "./events.ts";
import { newDirectionId } from "./ids.ts";
import { closedRefusal } from "./close.ts";
import { resolveSessionForDirection, titleSessionFromFirstDirection } from "./sessions.ts";
import type { MissionAccess } from "./authz.ts";
import { AuthorizationError } from "./authz.ts";
import { attachmentsForDirections, linkDirectionAttachments, resolveDirectionAttachments } from "./attachments.ts";

/**
 * The direction lifecycle (PRODUCT.md#direction). Attributed instruction in,
 * durable state out. Two rules carry the product's weight:
 *
 *  - Submission is never silently dropped. It is recorded, attributed, and
 *    visible to every participant the instant the write commits.
 *  - **Applied** is marked only when the runner acknowledges the direction —
 *    never when the control plane sends it. "Which direction is it following?"
 *    must never lie.
 *
 * Queueing is automatic: Submitted becomes Queued on acceptance of the write.
 * A `direction.queued` event is recorded only when the direction must actually
 * wait for someone — a non-controller's submission — because that waiting is
 * the visible product state. The controller's own direction goes straight
 * toward application and its next event is `direction.applied`.
 */

interface DirectionRow {
  dir_id: string;
  wst_id: string;
  session_id: string;
  author_user_id: string;
  author_login: string;
  body: string;
  state: string;
  ordinal: string | number;
  submitted_at: Date;
  applied_at: Date | null;
  resolution_reason: string | null;
  consumed_by_execution_id: string | null;
  context: unknown;
}

const DIRECTION_SELECT = `
  select d.dir_id, d.wst_id, d.session_id, d.author_user_id, u.login as author_login, d.body,
         d.state, d.ordinal, d.submitted_at, d.applied_at, d.resolution_reason,
         d.consumed_by_execution_id, d.context
    from directions d
    join users u on u.user_id = d.author_user_id`;

export function toDirection(row: DirectionRow, attachments: DirectionAttachment[] = []): Direction {
  return {
    directionId: row.dir_id,
    workstreamId: row.wst_id,
    sessionId: row.session_id,
    authorUserId: row.author_user_id,
    authorLogin: row.author_login,
    body: row.body,
    state: row.state as DirectionState,
    ordinal: Number(row.ordinal),
    submittedAt: row.submitted_at.toISOString(),
    appliedAt: row.applied_at ? row.applied_at.toISOString() : null,
    resolutionReason: row.resolution_reason,
    consumedByExecutionId: row.consumed_by_execution_id,
    attachments,
    // Stored validated at submit; a row from before D-182 has null here.
    context: Array.isArray(row.context) ? (row.context as Direction["context"]) : []
  };
}

export async function listDirections(db: Queryable, missionId: string): Promise<Direction[]> {
  const result = await db.query(`${DIRECTION_SELECT} where d.mission_id = $1 order by d.ordinal`, [
    missionId
  ]);
  const rows = result.rows as DirectionRow[];
  // One query for every direction's images rather than one per direction
  // (D-150): the room reads the whole mission's directions at once.
  const attachments = await attachmentsForDirections(
    db,
    rows.map((row) => row.dir_id)
  );
  return rows.map((row) =>
    toDirection(
      row,
      (attachments.get(row.dir_id) ?? []).map((found) => ({
        artifactId: found.artifactId,
        kind: found.kind as DirectionAttachment["kind"],
        mimeType: found.mimeType as DirectionAttachment["mimeType"],
        byteSize: found.byteSize,
        label: found.label,
        state: found.state as DirectionAttachment["state"]
      }))
    )
  );
}

export interface SubmittedDirection {
  direction: Direction;
  /** True when the author holds the lease, so the direction proceeds toward
   *  application immediately instead of waiting for the controller. */
  authorIsController: boolean;
}

/**
 * Records a submitted direction into one session of the workstream (D-083).
 * The caller has already been checked for `direction.submit` and resolved the
 * session against the same lane this access carries; this function decides
 * only the resulting state. A session's first words become its title.
 */
export async function submitDirection(
  db: Db,
  access: MissionAccess,
  author: { userId: string; login: string },
  body: string,
  harness: { model: string; effort: string; speed?: string; review?: boolean },
  session: { sessionId?: string; newSession: boolean; forkOf?: string },
  /** Images this direction carries (D-150). Already uploaded and verified —
   *  the ids are resolved against this mission before anything is written, so
   *  a direction never exists claiming an image that does not. */
  attachmentIds: string[] = [],
  /** Pinned references (D-182), already validated by the route's schema. */
  context: DirectionContextRef[] = []
): Promise<SubmittedDirection> {
  if (!access.workstreamId) {
    throw new AuthorizationError("no_workstream", "This mission has no workstream yet.", 409);
  }
  // A terminal state never resumes (D-121): direction into a closed mission
  // is refused in words, which also closes every dispatch path behind it.
  const closed = await closedRefusal(db, access.missionId);
  if (closed) throw new AuthorizationError("mission_closed", closed, 409);
  const claimed = await resolveDirectionAttachments(db, access.missionId, attachmentIds);
  if (!claimed.ok) throw new AuthorizationError("invalid_attachment", claimed.message, 422);
  const workstreamId = access.workstreamId;
  const authorIsController = access.isController;
  const dirId = newDirectionId();

  const row = await withTransaction(db, async (client) => {
    const resolved = await resolveSessionForDirection(client, access, author, {
      ...(session.sessionId ? { sessionId: session.sessionId } : {}),
      ...(session.forkOf ? { forkOf: session.forkOf } : {}),
      newSession: session.newSession,
      body
    });
    // A named session that is not this lane's is answered exactly like a named
    // lane that is not this mission's: it does not exist for you.
    if (!resolved) {
      throw new AuthorizationError("not_found", "No such session in this workstream.", 404);
    }
    const inserted = await client.query(
      `insert into directions (dir_id, org_id, mission_id, wst_id, session_id, author_user_id, body, state, model, effort, speed, review, context)
       values ($1, $2, $3, $4, $5, $6, $7, 'queued', $8, $9, $10, $11, $12) returning dir_id`,
      [
        dirId,
        access.orgId,
        access.missionId,
        workstreamId,
        resolved.sessionId,
        author.userId,
        body,
        harness.model,
        harness.effort,
        harness.speed ?? null,
        harness.review === true,
        context.length > 0 ? JSON.stringify(context) : null
      ]
    );
    const id = inserted.rows[0]?.dir_id as string;
    // The session's first words name it (D-083). A no-op for every session
    // that already has a title, including the one `newSession` just made.
    await titleSessionFromFirstDirection(client, resolved.sessionId, body);
    // Words and images land together or not at all.
    await linkDirectionAttachments(client, id, claimed.ids);
    await recordEvent(client, {
      orgId: access.orgId,
      missionId: access.missionId,
      workstreamId,
      kind: "direction.submitted",
      actorKind: "user",
      actorId: author.userId,
      actorLogin: author.login,
      causeDirectionId: id,
      causeLeaseId: access.leaseId,
      payload: {
        body,
        authorIsController,
        model: harness.model,
        effort: harness.effort,
        sessionId: resolved.sessionId,
        // Ids and a count, never bytes: an event is durable and projected into
        // receipts, and an image belongs in the store (D-150).
        attachmentIds: claimed.ids
      }
    });
    if (!authorIsController) {
      // The visible product state: attributed, queued, waiting for whoever
      // holds the baton.
      await recordEvent(client, {
        orgId: access.orgId,
        missionId: access.missionId,
        workstreamId,
        kind: "direction.queued",
        actorKind: "system",
        actorId: "control-plane",
        causeDirectionId: id,
        payload: { authorLogin: author.login, awaiting: access.controllerUserId }
      });
    }
    const fetched = await client.query(`${DIRECTION_SELECT} where d.dir_id = $1`, [id]);
    return fetched.rows[0] as DirectionRow;
  });

  const carried = await attachmentsForDirections(db, [row.dir_id]);
  const images = (carried.get(row.dir_id) ?? []).map((found) => ({
    artifactId: found.artifactId,
    kind: found.kind as DirectionAttachment["kind"],
    mimeType: found.mimeType as DirectionAttachment["mimeType"],
    byteSize: found.byteSize,
    label: found.label,
    state: found.state as DirectionAttachment["state"]
  }));
  return { direction: toDirection(row, images), authorIsController };
}

/**
 * The controller's judgment on a queued direction: apply it, reject it, or
 * supersede it. Only Submitted/Queued direction can be resolved — Applied
 * direction is history and can only be followed, never rewritten.
 */
export async function resolveDirection(
  db: Db,
  access: MissionAccess,
  actor: { userId: string; login: string },
  directionId: string,
  action: "apply" | "reject" | "supersede",
  reason?: string
): Promise<Direction | null> {
  const nextState: DirectionState =
    action === "apply" ? "queued" : action === "reject" ? "rejected" : "superseded";

  return withTransaction(db, async (client) => {
    const current = await client.query(
      `select dir_id, wst_id, state, author_user_id from directions
        where dir_id = $1 and mission_id = $2 for update`,
      [directionId, access.missionId]
    );
    const row = current.rows[0];
    if (!row) return null;
    if (row.state !== "submitted" && row.state !== "queued") {
      throw new AuthorizationError(
        "direction_settled",
        "That direction has already been applied or resolved.",
        409
      );
    }
    if (action === "apply") {
      // Applying does not change state here: the direction stays queued until
      // the runner acknowledges it. What changes is that the controller has
      // authorized it, which the dispatcher acts on.
      await recordEvent(client, {
        orgId: access.orgId,
        missionId: access.missionId,
        workstreamId: row.wst_id,
        kind: "direction.authorized",
        actorKind: "user",
        actorId: actor.userId,
        actorLogin: actor.login,
        causeDirectionId: directionId,
        causeLeaseId: access.leaseId,
        payload: {}
      });
    } else {
      await client.query(
        "update directions set state = $2, ended_at = now(), resolution_reason = $3 where dir_id = $1",
        [directionId, nextState, reason ?? null]
      );
      await recordEvent(client, {
        orgId: access.orgId,
        missionId: access.missionId,
        workstreamId: row.wst_id,
        kind: action === "reject" ? "direction.rejected" : "direction.superseded",
        actorKind: "user",
        actorId: actor.userId,
        actorLogin: actor.login,
        causeDirectionId: directionId,
        causeLeaseId: access.leaseId,
        payload: { reason: reason ?? null }
      });
    }
    const fetched = await client.query(`${DIRECTION_SELECT} where d.dir_id = $1`, [directionId]);
    return toDirection(fetched.rows[0] as DirectionRow);
  });
}

/** The author withdraws their own direction before it is applied. */
export async function cancelDirection(
  db: Db,
  access: MissionAccess,
  actor: { userId: string; login: string },
  directionId: string
): Promise<Direction | null> {
  return withTransaction(db, async (client) => {
    const current = await client.query(
      "select dir_id, wst_id, state, author_user_id from directions where dir_id = $1 and mission_id = $2 for update",
      [directionId, access.missionId]
    );
    const row = current.rows[0];
    if (!row) return null;
    if (row.author_user_id !== actor.userId) {
      throw new AuthorizationError("not_author", "Only the author can cancel their direction.");
    }
    if (row.state !== "submitted" && row.state !== "queued") {
      throw new AuthorizationError(
        "direction_settled",
        "That direction has already been applied or resolved.",
        409
      );
    }
    await client.query(
      "update directions set state = 'cancelled', ended_at = now() where dir_id = $1",
      [directionId]
    );
    await recordEvent(client, {
      orgId: access.orgId,
      missionId: access.missionId,
      workstreamId: row.wst_id,
      kind: "direction.cancelled",
      actorKind: "user",
      actorId: actor.userId,
      actorLogin: actor.login,
      causeDirectionId: directionId,
      payload: {}
    });
    const fetched = await client.query(`${DIRECTION_SELECT} where d.dir_id = $1`, [directionId]);
    return toDirection(fetched.rows[0] as DirectionRow);
  });
}

/**
 * Marks a direction Applied. Called only from runner event ingestion, on the
 * runner's `direction.applied` acknowledgement — the harness has it.
 * Idempotent: a replayed acknowledgement changes nothing.
 */
export async function markDirectionApplied(
  client: pg.PoolClient,
  args: { orgId: string; missionId: string; workstreamId: string; directionId: string; executionId: string }
): Promise<boolean> {
  const updated = await client.query(
    `update directions set state = 'applied', applied_at = now(), consumed_by_execution_id = $2
      where dir_id = $1 and state in ('submitted', 'queued') returning dir_id`,
    [args.directionId, args.executionId]
  );
  return (updated.rowCount ?? 0) > 0;
}
