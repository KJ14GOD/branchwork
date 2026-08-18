import type { FastifyInstance } from "fastify";
import { BeginAttachmentInputSchema, MAX_ATTACHMENT_BYTES, type Artifact } from "@novus/contracts";
import { z } from "zod";
import { missionAccess, require as requireCapability } from "./authz.ts";
import type { Db, Queryable } from "./db.ts";
import { newArtifactId } from "./ids.ts";
import type { RouteDeps } from "./routes.ts";
import { closedRefusal } from "./close.ts";
import { resolveArtifactStore } from "./artifact-store.ts";
import { runnerAuthenticator } from "./runner.ts";
import { ARTIFACT_SELECT, blobKey, serveArtifact, type ArtifactRow } from "./artifacts.ts";

/**
 * Attaching an image to a direction (D-150).
 *
 * The whole D-122 lifecycle is reused unchanged — a promise of kind, MIME,
 * length and SHA-256; an upload grant bound to exactly that promise; and a row
 * that reads as evidence only once the **store itself** confirms what arrived.
 * Two things differ, both deliberate:
 *
 *  - **No capture provenance.** Novus did not photograph this. There is no
 *    process, no validated origin, no readiness; the row says `upload` and
 *    invents no producer. A record that claimed Novus captured a file somebody
 *    handed it would be a lie of exactly the kind D-122 exists to prevent.
 *  - **No runner requirement.** A capture needs the machine holding the
 *    workspace, because the preview only exists there. A person's own file
 *    needs nobody: a participant whose laptop holds no checkout may still
 *    attach one.
 *
 * Authorization is `direction.submit`, never `artifact.capture`: attaching an
 * image is part of saying something to the harness. Whoever may direct may
 * illustrate what they mean; whoever may not, may not — and a Viewer, who may
 * do neither, is refused here by the same rule that refuses their words.
 */

const UPLOAD_TTL_SECONDS = 600;
const VIEW_TTL_SECONDS = 300;

const MissionParamsSchema = z.object({ missionId: z.string().startsWith("msn_") });

/** The label an attachment wears in the room: the person's own filename,
 *  bounded, and never used to address anything. The object key is generated
 *  here and owes nothing to what the file was called. */
function labelFor(filename: string): string {
  const trimmed = filename.trim().replace(/[\r\n\t]/g, " ");
  return (trimmed.length > 0 ? trimmed : "Attached image").slice(0, 120);
}

/**
 * The attachments of one direction, oldest first. Read as part of the room's
 * projection, so an image is visible on the direction that carried it for
 * exactly as long as the direction is.
 */
export async function attachmentsForDirections(
  db: Queryable,
  directionIds: string[]
): Promise<Map<string, { artifactId: string; mimeType: string; byteSize: number; label: string; state: string }[]>> {
  const byDirection = new Map<
    string,
    { artifactId: string; mimeType: string; byteSize: number; label: string; state: string }[]
  >();
  if (directionIds.length === 0) return byDirection;
  const result = await db.query(
    `select da.dir_id, a.art_id, a.mime_type, a.byte_size, a.label, a.state
       from direction_attachments da
       join artifacts a on a.art_id = da.art_id
      where da.dir_id = any($1::text[])
      order by da.dir_id, da.ordinal`,
    [directionIds]
  );
  for (const row of result.rows as {
    dir_id: string;
    art_id: string;
    mime_type: string;
    byte_size: number;
    label: string;
    state: string;
  }[]) {
    const list = byDirection.get(row.dir_id) ?? [];
    list.push({
      artifactId: row.art_id,
      mimeType: row.mime_type,
      byteSize: Number(row.byte_size),
      label: row.label,
      state: row.state
    });
    byDirection.set(row.dir_id, list);
  }
  return byDirection;
}

/**
 * Resolves the ids a direction claims to carry, refusing anything that is not
 * this mission's own available attachment. Returns the reason instead of the
 * list when it refuses, so the caller answers in words.
 *
 * Every clause here is a way the claim could be false: a foreign artifact, a
 * captured screenshot passed off as an attachment, bytes that never arrived or
 * failed their digest, the same image twice, or more than the bound. A
 * direction is never held open waiting for an upload — the bytes are verified
 * before the words are submitted, or the submission is refused.
 */
export async function resolveDirectionAttachments(
  db: Queryable,
  missionId: string,
  artifactIds: string[]
): Promise<{ ok: true; ids: string[] } | { ok: false; message: string }> {
  if (artifactIds.length === 0) return { ok: true, ids: [] };
  if (new Set(artifactIds).size !== artifactIds.length) {
    return { ok: false, message: "The same image was attached twice." };
  }
  const found = await db.query(
    `select art_id, state from artifacts
      where mission_id = $1 and art_id = any($2::text[]) and kind = 'attachment'`,
    [missionId, artifactIds]
  );
  const states = new Map(
    (found.rows as { art_id: string; state: string }[]).map((row) => [row.art_id, row.state])
  );
  for (const id of artifactIds) {
    const state = states.get(id);
    if (state === undefined) {
      return { ok: false, message: "That image is not this mission's to attach." };
    }
    if (state !== "available") {
      return { ok: false, message: "That image has not finished uploading." };
    }
  }
  return { ok: true, ids: artifactIds };
}

export function registerAttachmentRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const store = resolveArtifactStore(deps.config);
  const requireRunner = runnerAuthenticator(deps);

  /**
   * The machine about to run a turn fetching one attached image (D-150).
   *
   * A runner credential is scoped to (organization, mission, workstream,
   * runner) already, and the mission clause below is what makes that scoping
   * do the work: a runner enrolled for one mission cannot read another
   * mission's image by naming its id. The grant it receives is the same
   * short-lived signed download every viewer gets — minted per request, never
   * stored, never logged, never written into an event.
   */
  app.post("/runner/attachments/:artifactId/view", async (request, reply) => {
    const runner = await requireRunner(request, reply);
    if (!runner) return;
    const artifactId = (request.params as { artifactId?: string }).artifactId ?? "";
    if (store === null) {
      return deps.sendError(
        reply,
        503,
        "artifact_store_unconfigured",
        "This deployment has no artifact store."
      );
    }
    const found = await attachmentBlobKey(deps.db, runner.missionId, artifactId);
    // Not this mission's, not an attachment, or not yet verified: all one
    // answer, because a runner learning which of those it was would be a
    // probe into a mission it is not enrolled for.
    if (!found) return deps.sendError(reply, 404, "not_found", "No such attachment.");
    const url = await store.presignDownload(found.key, { expiresInSeconds: VIEW_TTL_SECONDS });
    return {
      url,
      mimeType: found.mimeType,
      expiresAt: new Date(Date.now() + VIEW_TTL_SECONDS * 1000).toISOString()
    };
  });

  app.post("/missions/:missionId/attachments", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const params = MissionParamsSchema.safeParse(request.params);
    if (!params.success) return deps.sendError(reply, 400, "bad_id", "Malformed mission id.");
    const body = BeginAttachmentInputSchema.safeParse(request.body);
    if (!body.success) {
      return deps.sendError(
        reply,
        422,
        "invalid_attachment",
        body.error.issues[0]?.message ?? "Malformed attachment."
      );
    }
    const access = await missionAccess(deps.db, ctx, params.data.missionId, body.data.workstreamId);
    if (!access || !access.workstreamId) {
      return deps.sendError(reply, 404, "not_found", "No such mission in your organization.");
    }
    // Illustrating what you mean is part of saying it (D-150).
    requireCapability(access, "direction.submit");
    if (store === null) {
      return deps.sendError(
        reply,
        503,
        "artifact_store_unconfigured",
        "This deployment has no artifact store, so an image has nowhere to live."
      );
    }
    const ended = await closedRefusal(deps.db, access.missionId);
    if (ended) return deps.sendError(reply, 409, "mission_closed", ended);
    if (body.data.byteSize > MAX_ATTACHMENT_BYTES) {
      return deps.sendError(
        reply,
        422,
        "attachment_too_large",
        `An attached image may be at most ${MAX_ATTACHMENT_BYTES} bytes.`
      );
    }
    // A chat this lane does not own is answered as not found, never adopted —
    // the same rule every session-naming route follows (D-083).
    if (body.data.sessionId) {
      const session = await deps.db.query(
        "select 1 from workstream_sessions where csn_id = $1 and wst_id = $2",
        [body.data.sessionId, access.workstreamId]
      );
      if ((session.rowCount ?? 0) === 0) {
        return deps.sendError(reply, 404, "not_found", "No such conversation in this lane.");
      }
    }

    const artifactId = newArtifactId();
    const key = blobKey(access.missionId, artifactId);
    await deps.db.query(
      `insert into artifacts (
         art_id, org_id, mission_id, wst_id, csn_id, exe_id, kind, mime_type, byte_size, sha256,
         object_key, state, label, initiator, capture_source, created_by, environment, captured_at)
       values ($1, $2, $3, $4, $5, null, 'attachment', $6, $7, $8, $9, 'pending', $10, 'person',
               'upload', $11, $12, now())`,
      [
        artifactId,
        access.orgId,
        access.missionId,
        access.workstreamId,
        body.data.sessionId ?? null,
        body.data.mimeType,
        body.data.byteSize,
        body.data.sha256,
        key,
        labelFor(body.data.filename),
        ctx.userId,
        // Not a machine claim: the person's own client sent these bytes, and
        // no runner is involved in an attachment at all.
        "attached by a person"
      ]
    );

    const upload = await store.presignUpload(key, {
      byteSize: body.data.byteSize,
      sha256: body.data.sha256,
      contentType: body.data.mimeType,
      expiresInSeconds: UPLOAD_TTL_SECONDS
    });
    const served = await deps.db.query(`${ARTIFACT_SELECT} where a.art_id = $1`, [artifactId]);
    reply.code(201);
    return {
      artifact: serveArtifact(served.rows[0] as ArtifactRow, []) satisfies Artifact,
      upload
    };
  });
}

/** Records what a direction was submitted carrying. Called inside the
 *  submitting transaction, so words and images land together or not at all. */
export async function linkDirectionAttachments(
  client: Queryable,
  directionId: string,
  artifactIds: string[]
): Promise<void> {
  for (const [ordinal, artifactId] of artifactIds.entries()) {
    await client.query(
      "insert into direction_attachments (dir_id, art_id, ordinal) values ($1, $2, $3)",
      [directionId, artifactId, ordinal]
    );
  }
}

/** The bytes of one attachment, for the machine about to hand it to the
 *  harness. Used by the runner leg (D-150); mission scoping is the caller's. */
export async function attachmentBlobKey(
  db: Db,
  missionId: string,
  artifactId: string
): Promise<{ key: string; mimeType: string } | null> {
  const row = await db.query(
    `select object_key, mime_type from artifacts
      where art_id = $1 and mission_id = $2 and kind = 'attachment' and state = 'available'`,
    [artifactId, missionId]
  );
  const found = row.rows[0] as { object_key: string; mime_type: string } | undefined;
  return found ? { key: found.object_key, mimeType: found.mime_type } : null;
}
