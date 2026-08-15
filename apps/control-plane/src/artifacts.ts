import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { Readable } from "node:stream";
import {
  ArtifactSchema,
  AttachArtifactInputSchema,
  BeginArtifactInputSchema,
  BeginRunnerArtifactInputSchema,
  MAX_RECORDING_BYTES,
  MAX_SCREENSHOT_BYTES,
  MAX_THUMBNAIL_BYTES,
  TERMINAL_EXECUTION_STATES,
  type Artifact,
  type ArtifactAttachmentRef,
  type BeginArtifactInput,
  type BeginRunnerArtifactInput
} from "@novus/contracts";
import { missionAccess, require as requireCapability } from "./authz.ts";
import { withTransaction, type Db } from "./db.ts";
import { recordEvent } from "./events.ts";
import { newArtifactId, newAttachmentId } from "./ids.ts";
import type { RouteDeps } from "./routes.ts";
import { closedRefusal } from "./close.ts";
import { environmentOf, runnerAuthenticator } from "./runner.ts";
import { LocalArtifactStore, resolveArtifactStore, type ArtifactStore } from "./artifact-store.ts";

/**
 * Durable visual evidence (D-022, D-122): the Artifact rows, their storage
 * boundary, and their relationships.
 *
 * The division of trust: this module holds the only store credentials and
 * generates every object key; clients and runners receive short-lived signed
 * grants that are never stored and never logged. A row reads as evidence only
 * once the store itself has confirmed the promised bytes — length and SHA-256
 * both — so a failed or incomplete upload can never be presented as completed
 * evidence, and a blob cannot change after capture without the record saying
 * so, because nothing can write it again.
 *
 * Reads use the same mission authorization as everything else: no mission
 * access, no metadata, no viewing grant — and without a grant the store
 * serves nothing, so guessing an artifact id or an object key retrieves
 * nothing.
 */

const UPLOAD_TTL_SECONDS = 600;
const VIEW_TTL_SECONDS = 300;
/** A pending upload older than this is failed by the sweep: the machine that
 *  began it has restarted, or gone, and the row must not linger as almost-
 *  evidence forever. */
export const PENDING_ARTIFACT_TTL_MS = 15 * 60_000;

const blobKey = (missionId: string, artifactId: string) =>
  `missions/${missionId}/artifacts/${artifactId}/blob`;
const thumbKey = (missionId: string, artifactId: string) =>
  `missions/${missionId}/artifacts/${artifactId}/thumb`;

interface ArtifactRow {
  art_id: string;
  org_id: string;
  mission_id: string;
  wst_id: string | null;
  csn_id: string | null;
  exe_id: string | null;
  kind: "screenshot" | "recording";
  mime_type: "image/png" | "video/webm";
  byte_size: string | number;
  sha256: string;
  object_key: string;
  thumb_object_key: string | null;
  thumb_byte_size: string | number | null;
  thumb_sha256: string | null;
  state: Artifact["state"];
  failure_reason: string | null;
  interruption_reason: string | null;
  label: string;
  initiator: "person" | "agent";
  capture_source: "preview";
  created_by: string | null;
  created_by_login?: string | null;
  approval_id: string | null;
  runner_id: string | null;
  environment: string;
  process_id: string | null;
  process_name: string | null;
  origin: string | null;
  readiness: Artifact["readiness"];
  revision_sha: string | null;
  revision_dirty: boolean;
  ckp_id: string | null;
  duration_ms: string | number | null;
  captured_at: Date;
  created_at: Date;
}

function serveArtifact(row: ArtifactRow, attachments: ArtifactAttachmentRef[]): Artifact {
  return ArtifactSchema.parse({
    artifactId: row.art_id,
    missionId: row.mission_id,
    workstreamId: row.wst_id,
    sessionId: row.csn_id,
    executionId: row.exe_id,
    kind: row.kind,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size),
    sha256: row.sha256,
    state: row.state,
    failureReason: row.failure_reason,
    interruptionReason: row.interruption_reason,
    label: row.label,
    capturedAt: row.captured_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    createdByLogin: row.created_by_login ?? null,
    initiator: row.initiator,
    captureSource: row.capture_source,
    processId: row.process_id,
    processName: row.process_name,
    origin: row.origin,
    readiness: row.readiness,
    revisionSha: row.revision_sha,
    revisionDirty: Boolean(row.revision_dirty),
    checkpointId: row.ckp_id,
    environment: row.environment,
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    hasThumbnail: row.thumb_object_key !== null,
    redaction: "metadata_only",
    attachments
  });
}

const ARTIFACT_SELECT = `
  select a.*, u.login as created_by_login
    from artifacts a
    left join users u on u.user_id = a.created_by`;

/**
 * Everywhere each of the mission's artifacts is currently evidence: live
 * attachment rows (checks and pull requests) plus the artifact ids frozen on
 * decisions. Resolved into words a reader can use — a check's name, a PR's
 * number — never internal keys.
 */
async function attachmentRefs(
  db: Db | pg.PoolClient,
  missionId: string
): Promise<Map<string, ArtifactAttachmentRef[]>> {
  const refs = new Map<string, ArtifactAttachmentRef[]>();
  const push = (artifactId: string, ref: ArtifactAttachmentRef) => {
    const list = refs.get(artifactId) ?? [];
    list.push(ref);
    refs.set(artifactId, list);
  };
  const attachments = await db.query(
    `select t.art_id, t.target_kind, t.target_id,
            v.name as check_name, p.provider_number
       from artifact_attachments t
       left join verification_checks v on t.target_kind = 'check' and v.chk_id = t.target_id
       left join pull_requests p on t.target_kind = 'pull_request' and p.pr_id = t.target_id
      where t.mission_id = $1 and t.detached_at is null
      order by t.attached_at`,
    [missionId]
  );
  for (const row of attachments.rows) {
    push(row.art_id as string, {
      kind: row.target_kind as "check" | "pull_request",
      id: row.target_id as string,
      label:
        row.target_kind === "check"
          ? `check "${((row.check_name as string | null) ?? "unknown").slice(0, 180)}"`
          : `PR #${row.provider_number ?? "?"}`
    });
  }
  const decisions = await db.query(
    `select dec_id, artifact_ids, superseded_at from decisions
      where mission_id = $1 order by decided_at`,
    [missionId]
  );
  for (const row of decisions.rows) {
    for (const artifactId of (row.artifact_ids as string[]) ?? []) {
      push(artifactId, {
        kind: "decision",
        id: row.dec_id as string,
        label: row.superseded_at === null ? "the decision" : "a superseded decision"
      });
    }
  }
  return refs;
}

export async function listArtifacts(db: Db, missionId: string): Promise<Artifact[]> {
  const [result, refs] = await Promise.all([
    db.query(`${ARTIFACT_SELECT} where a.mission_id = $1 order by a.created_at, a.art_id`, [
      missionId
    ]),
    attachmentRefs(db, missionId)
  ]);
  return result.rows.map((row) =>
    serveArtifact(row as ArtifactRow, refs.get((row as ArtifactRow).art_id) ?? [])
  );
}

/** Live attachment ids per target, for the checks and pull request the detail
 *  serves — so the room can show evidence beside the thing it supports. */
export async function artifactIdsByTarget(
  db: Db,
  missionId: string
): Promise<Map<string, string[]>> {
  const result = await db.query(
    `select target_kind, target_id, art_id from artifact_attachments
      where mission_id = $1 and detached_at is null order by attached_at`,
    [missionId]
  );
  const byTarget = new Map<string, string[]>();
  for (const row of result.rows) {
    const key = `${row.target_kind}:${row.target_id}`;
    const list = byTarget.get(key) ?? [];
    list.push(row.art_id as string);
    byTarget.set(key, list);
  }
  return byTarget;
}

/** The mission's frozen evidence set for the receipt (D-122): available and
 *  interrupted artifacts only — pending never entered evidence and failed
 *  never was — with where each was attached, in words. */
export async function receiptArtifacts(
  client: pg.PoolClient,
  missionId: string
): Promise<
  {
    artifactId: string;
    kind: string;
    label: string;
    state: string;
    sha256: string;
    capturedAt: string;
    revisionSha: string | null;
    attachedTo: string[];
  }[]
> {
  const refs = await attachmentRefs(client, missionId);
  const rows = await client.query(
    `select art_id, kind, label, state, sha256, captured_at, revision_sha, thumb_object_key
       from artifacts
      where mission_id = $1 and state in ('available', 'interrupted')
      order by created_at, art_id limit 50`,
    [missionId]
  );
  return rows.rows.map((row) => ({
    artifactId: row.art_id as string,
    kind: row.kind as string,
    label: (row.label as string).slice(0, 120),
    state: row.state as string,
    sha256: row.sha256 as string,
    capturedAt: (row.captured_at as Date).toISOString(),
    revisionSha: (row.revision_sha as string | null) ?? null,
    hasThumbnail: row.thumb_object_key !== null,
    attachedTo: (refs.get(row.art_id as string) ?? []).map((ref) => ref.label.slice(0, 200))
  }));
}

/** How large this kind of blob may be — enforced at begin, bound into the
 *  upload grant, and re-checked against what the store actually holds. */
function sizeLimitFor(kind: "screenshot" | "recording"): number {
  return kind === "screenshot" ? MAX_SCREENSHOT_BYTES : MAX_RECORDING_BYTES;
}

function labelFor(kind: "screenshot" | "recording", processName: string): string {
  return `${kind === "screenshot" ? "Screenshot" : "Recording"} · ${processName}`.slice(0, 120);
}

interface BeginContext {
  orgId: string;
  missionId: string;
  workstreamId: string;
  sessionId: string | null;
  executionId: string | null;
  initiator: "person" | "agent";
  createdBy: string | null;
  approvalId: string | null;
  runnerId: string | null;
  environment: string;
}

/** The shared half of both begin routes: validate the claim, mint the row as
 *  `pending`, and hand back grants for exactly the promised bytes. */
async function beginArtifact(
  deps: RouteDeps,
  store: ArtifactStore,
  input: BeginArtifactInput | BeginRunnerArtifactInput,
  ctx: BeginContext
): Promise<
  | { ok: true; artifact: Artifact; artifactId: string }
  | { ok: false; status: number; code: string; message: string }
> {
  if (input.kind === "screenshot" && input.mimeType !== "image/png") {
    return { ok: false, status: 422, code: "invalid_artifact", message: "A screenshot is a PNG." };
  }
  if (input.kind === "recording" && input.mimeType !== "video/webm") {
    return { ok: false, status: 422, code: "invalid_artifact", message: "A recording is WebM." };
  }
  if (input.byteSize > sizeLimitFor(input.kind)) {
    return {
      ok: false,
      status: 422,
      code: "artifact_too_large",
      message: `A ${input.kind} may be at most ${sizeLimitFor(input.kind)} bytes.`
    };
  }
  if (input.thumbnail && input.thumbnail.byteSize > MAX_THUMBNAIL_BYTES) {
    return {
      ok: false,
      status: 422,
      code: "artifact_too_large",
      message: `A thumbnail may be at most ${MAX_THUMBNAIL_BYTES} bytes.`
    };
  }

  const artifactId = newArtifactId();
  const key = blobKey(ctx.missionId, artifactId);
  const thumb = input.thumbnail ? thumbKey(ctx.missionId, artifactId) : null;
  const interruptionReason = input.interrupted
    ? (input.interruptionReason?.trim() ||
      "The recording did not end by its own stop.")
    : null;

  // The checkpoint matching the captured revision, when one exists — an
  // attribution made only where it is true (D-122): no match, no claim.
  const checkpoint =
    input.provenance.revisionSha === null
      ? { rows: [] }
      : await deps.db.query(
          `select c.ckp_id from checkpoints c
            where c.wst_id = $1 and c.sha = $2 order by c.created_at desc limit 1`,
          [ctx.workstreamId, input.provenance.revisionSha]
        );

  await deps.db.query(
    `insert into artifacts (
       art_id, org_id, mission_id, wst_id, csn_id, exe_id, kind, mime_type, byte_size, sha256,
       object_key, thumb_object_key, thumb_byte_size, thumb_sha256, state, interruption_reason,
       label, initiator, capture_source, created_by, approval_id, runner_id, environment,
       process_id, process_name, origin, readiness, revision_sha, revision_dirty, ckp_id,
       duration_ms, captured_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'pending', $15,
             $16, $17, 'preview', $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30)`,
    [
      artifactId,
      ctx.orgId,
      ctx.missionId,
      ctx.workstreamId,
      ctx.sessionId,
      ctx.executionId,
      input.kind,
      input.mimeType,
      input.byteSize,
      input.sha256,
      key,
      thumb,
      input.thumbnail?.byteSize ?? null,
      input.thumbnail?.sha256 ?? null,
      interruptionReason,
      labelFor(input.kind, input.provenance.processName),
      ctx.initiator,
      ctx.createdBy,
      ctx.approvalId,
      ctx.runnerId,
      ctx.environment,
      input.provenance.processId,
      input.provenance.processName.slice(0, 120),
      input.provenance.origin.slice(0, 300),
      input.provenance.readiness,
      input.provenance.revisionSha,
      input.provenance.revisionDirty,
      (checkpoint.rows[0]?.ckp_id as string | undefined) ?? null,
      input.provenance.durationMs ?? null,
      input.capturedAt
    ]
  );
  const served = await deps.db.query(`${ARTIFACT_SELECT} where a.art_id = $1`, [artifactId]);
  return {
    ok: true,
    artifactId,
    artifact: serveArtifact(served.rows[0] as ArtifactRow, [])
  };
}

/**
 * The completion check: what does the store actually hold? Only the store's
 * own answer moves a row to `available` — the uploader's word never does.
 * "Nothing arrived" refuses without failing the row (the PUT may still be in
 * flight and completion raced it); wrong bytes fail it terminally.
 */
async function verifyUploaded(
  store: ArtifactStore,
  key: string,
  expected: { byteSize: number; sha256: string }
): Promise<{ verdict: "ok" } | { verdict: "missing" } | { verdict: "mismatch"; message: string }> {
  let held: { byteSize: number; sha256: string | null } | null;
  try {
    held = await store.stat(key);
  } catch (error) {
    return {
      verdict: "mismatch",
      message: `The artifact store could not be read: ${error instanceof Error ? error.message : "unknown error"}`
    };
  }
  if (held === null) return { verdict: "missing" };
  if (held.byteSize !== expected.byteSize) {
    return {
      verdict: "mismatch",
      message: `The store holds ${held.byteSize} bytes; ${expected.byteSize} were promised.`
    };
  }
  if (held.sha256 === null || held.sha256 !== expected.sha256) {
    return {
      verdict: "mismatch",
      message: "The stored bytes do not match the digest promised at capture."
    };
  }
  return { verdict: "ok" };
}

export function registerArtifactRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const store = resolveArtifactStore(deps.config);
  const requireRunner = runnerAuthenticator(deps);

  const unconfigured = (reply: Parameters<RouteDeps["sendError"]>[0]) =>
    deps.sendError(
      reply,
      503,
      "artifact_store_unconfigured",
      "No artifact store is configured, so visual evidence cannot be stored. Set NOVUS_ARTIFACT_STORE."
    );

  // --- The local store's own signed routes -----------------------------------
  // Only the local store serves blobs from the control plane; S3 serves its
  // own. Authorization is the expiring HMAC signature minted by a presign —
  // there is no session fallback, so an unauthorized person cannot retrieve a
  // blob by knowing its key, and an expired grant is exactly as useless.

  if (store instanceof LocalArtifactStore) {
    // The blob body arrives as a raw stream; these are the only content types
    // any route accepts as bytes.
    app.addContentTypeParser(["image/png", "video/webm"], (_request, payload, done) =>
      done(null, payload)
    );

    app.put(
      "/artifact-store/:key",
      { bodyLimit: MAX_RECORDING_BYTES + 1024 },
      async (request, reply) => {
        const key = (request.params as { key?: string }).key ?? "";
        const outcome = await store.receivePut(
          key,
          request.query as Record<string, string>,
          request.body as Readable
        );
        if (!outcome.ok) {
          return deps.sendError(reply, outcome.status, "upload_refused", outcome.message);
        }
        return reply.send({ ok: true });
      }
    );

    app.get("/artifact-store/:key", async (request, reply) => {
      const key = (request.params as { key?: string }).key ?? "";
      if (!store.authorizeGet(key, request.query as Record<string, string>)) {
        return deps.sendError(reply, 403, "view_refused", "This viewing grant is not valid.");
      }
      const blob = await store.open(key);
      if (blob === null) {
        return deps.sendError(reply, 404, "not_found", "The store holds nothing at this key.");
      }
      reply.header("content-type", blob.contentType);
      reply.header("content-length", String(blob.byteSize));
      // A grant is for these bytes now; nothing may cache them into a longer
      // life than the grant has.
      reply.header("cache-control", "private, no-store");
      return reply.send(blob.stream);
    });
  }

  // --- Person capture: begin -------------------------------------------------

  app.post("/missions/:missionId/artifacts", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const missionId = (request.params as { missionId?: string }).missionId ?? "";
    const body = BeginArtifactInputSchema.safeParse(request.body);
    if (!body.success) {
      return deps.sendError(
        reply,
        422,
        "invalid_artifact",
        body.error.issues[0]?.message ?? "Malformed artifact."
      );
    }
    const access = await missionAccess(deps.db, ctx, missionId, body.data.workstreamId);
    if (!access || !access.workstreamId) {
      return deps.sendError(reply, 404, "not_found", "No such mission in your organization.");
    }
    requireCapability(access, "artifact.capture");
    if (store === null) return unconfigured(reply);
    const ended = await closedRefusal(deps.db, access.missionId);
    if (ended) return deps.sendError(reply, 409, "mission_closed", ended);

    // The chat this claims, when it claims one, must be the named lane's own —
    // a foreign session is answered as not found, never adopted (D-083).
    if (body.data.provenance.sessionId) {
      const session = await deps.db.query(
        "select 1 from workstream_sessions where csn_id = $1 and wst_id = $2",
        [body.data.provenance.sessionId, access.workstreamId]
      );
      if ((session.rowCount ?? 0) === 0) {
        return deps.sendError(reply, 404, "not_found", "No such conversation in this lane.");
      }
    }

    // The producing machine: the lane's enrolled runner. A preview only exists
    // on the machine that holds the workspace, so a capture without one has no
    // honest producer to attribute.
    const runner = await deps.db.query(
      `select runner_id, label from runners
        where wst_id = $1 and revoked_at is null and expires_at > now()
        order by created_at desc limit 1`,
      [access.workstreamId]
    );
    if ((runner.rowCount ?? 0) === 0) {
      return deps.sendError(
        reply,
        409,
        "no_runner",
        "No machine holds this lane's workspace, so nothing can have captured its preview."
      );
    }

    const begun = await beginArtifact(deps, store, body.data, {
      orgId: access.orgId,
      missionId: access.missionId,
      workstreamId: access.workstreamId,
      sessionId: body.data.provenance.sessionId ?? null,
      executionId: null,
      initiator: "person",
      createdBy: ctx.userId,
      approvalId: null,
      runnerId: runner.rows[0]!.runner_id as string,
      environment: `local runner (${runner.rows[0]!.label as string})`
    });
    if (!begun.ok) return deps.sendError(reply, begun.status, begun.code, begun.message);

    const upload = await store.presignUpload(blobKey(access.missionId, begun.artifactId), {
      byteSize: body.data.byteSize,
      sha256: body.data.sha256,
      contentType: body.data.mimeType,
      expiresInSeconds: UPLOAD_TTL_SECONDS
    });
    const thumbnailUpload = body.data.thumbnail
      ? await store.presignUpload(thumbKey(access.missionId, begun.artifactId), {
          byteSize: body.data.thumbnail.byteSize,
          sha256: body.data.thumbnail.sha256,
          contentType: "image/png",
          expiresInSeconds: UPLOAD_TTL_SECONDS
        })
      : null;
    reply.code(201);
    return { artifact: begun.artifact, upload, thumbnailUpload };
  });

  // --- Agent-requested capture: begin (runner-authenticated, D-123) ----------

  app.post("/runner/artifacts", async (request, reply) => {
    const runner = await requireRunner(request, reply);
    if (!runner) return;
    if (store === null) return unconfigured(reply);
    const body = BeginRunnerArtifactInputSchema.safeParse(request.body);
    if (!body.success) {
      return deps.sendError(
        reply,
        422,
        "invalid_artifact",
        body.error.issues[0]?.message ?? "Malformed artifact."
      );
    }
    // The requesting execution must be this runner's own lane's, and must be
    // live: an agent's capture happens inside its turn, while the tool call
    // blocks on the answer.
    const execution = await deps.db.query(
      "select exe_id, session_id, state from executions where exe_id = $1 and wst_id = $2",
      [body.data.executionId, runner.workstreamId]
    );
    const row = execution.rows[0];
    if (!row) {
      return deps.sendError(reply, 404, "not_found", "No such execution in this workstream.");
    }
    if ((TERMINAL_EXECUTION_STATES as readonly string[]).includes(row.state as string)) {
      return deps.sendError(
        reply,
        409,
        "execution_ended",
        "That execution has ended; a capture it requested can no longer begin."
      );
    }
    if (body.data.approvalId) {
      const approval = await deps.db.query(
        "select 1 from approval_requests where apr_id = $1 and exe_id = $2",
        [body.data.approvalId, body.data.executionId]
      );
      if ((approval.rowCount ?? 0) === 0) {
        return deps.sendError(reply, 404, "not_found", "No such approval for that execution.");
      }
    }

    const begun = await beginArtifact(deps, store, body.data, {
      orgId: runner.orgId,
      missionId: runner.missionId,
      workstreamId: runner.workstreamId,
      // The agent's own conversation — the one attribution that is honestly
      // known here, derived from the execution row rather than claimed.
      sessionId: row.session_id as string,
      executionId: body.data.executionId,
      initiator: "agent",
      createdBy: null,
      approvalId: body.data.approvalId ?? null,
      runnerId: runner.runnerId,
      environment: environmentOf(runner)
    });
    if (!begun.ok) return deps.sendError(reply, begun.status, begun.code, begun.message);

    const upload = await store.presignUpload(blobKey(runner.missionId, begun.artifactId), {
      byteSize: body.data.byteSize,
      sha256: body.data.sha256,
      contentType: body.data.mimeType,
      expiresInSeconds: UPLOAD_TTL_SECONDS
    });
    const thumbnailUpload = body.data.thumbnail
      ? await store.presignUpload(thumbKey(runner.missionId, begun.artifactId), {
          byteSize: body.data.thumbnail.byteSize,
          sha256: body.data.thumbnail.sha256,
          contentType: "image/png",
          expiresInSeconds: UPLOAD_TTL_SECONDS
        })
      : null;
    reply.code(201);
    return { artifact: begun.artifact, upload, thumbnailUpload };
  });

  // --- Completion ------------------------------------------------------------

  const complete = async (
    artifact: ArtifactRow,
    outcome: "uploaded" | "failed",
    failureReason: string | undefined,
    actor: { kind: "user"; id: string; login: string } | { kind: "harness"; id: string }
  ): Promise<{ status: number; code: string; message: string } | { artifact: Artifact }> => {
    if (store === null) return { status: 503, code: "artifact_store_unconfigured", message: "No artifact store is configured." };
    // Duplicate completion lands once: an already-settled row answers with
    // itself and changes nothing (the runner protocol's idempotency posture).
    if (artifact.state === "available" || artifact.state === "interrupted") {
      if (outcome === "uploaded") {
        const refs = await attachmentRefs(deps.db, artifact.mission_id);
        return { artifact: serveArtifact(artifact, refs.get(artifact.art_id) ?? []) };
      }
      return {
        status: 409,
        code: "already_completed",
        message: "This artifact is already completed evidence; it cannot become failed."
      };
    }
    if (artifact.state === "failed") {
      return {
        status: 409,
        code: "already_failed",
        message: `This artifact already failed: ${artifact.failure_reason ?? "no reason recorded"}.`
      };
    }

    if (outcome === "failed") {
      const reason = failureReason?.trim() || "The upload failed.";
      await withTransaction(deps.db, async (client) => {
        await client.query(
          "update artifacts set state = 'failed', failure_reason = $2, completed_at = now() where art_id = $1 and state = 'pending'",
          [artifact.art_id, reason]
        );
        await recordEvent(client, {
          orgId: artifact.org_id,
          missionId: artifact.mission_id,
          workstreamId: artifact.wst_id,
          executionId: artifact.exe_id,
          actorKind: actor.kind,
          actorId: actor.id,
          actorLogin: actor.kind === "user" ? actor.login : null,
          kind: "artifact.failed",
          payload: { artifactId: artifact.art_id, kind: artifact.kind, reason }
        });
      });
      const served = await deps.db.query(`${ARTIFACT_SELECT} where a.art_id = $1`, [artifact.art_id]);
      return { artifact: serveArtifact(served.rows[0] as ArtifactRow, []) };
    }

    const verdict = await verifyUploaded(store, artifact.object_key, {
      byteSize: Number(artifact.byte_size),
      sha256: artifact.sha256
    });
    if (verdict.verdict === "missing") {
      return {
        status: 409,
        code: "blob_missing",
        message: "The store holds nothing for this artifact yet; the upload has not arrived."
      };
    }
    if (verdict.verdict === "mismatch") {
      await withTransaction(deps.db, async (client) => {
        await client.query(
          "update artifacts set state = 'failed', failure_reason = $2, completed_at = now() where art_id = $1 and state = 'pending'",
          [artifact.art_id, verdict.message]
        );
        await recordEvent(client, {
          orgId: artifact.org_id,
          missionId: artifact.mission_id,
          workstreamId: artifact.wst_id,
          executionId: artifact.exe_id,
          actorKind: actor.kind,
          actorId: actor.id,
          actorLogin: actor.kind === "user" ? actor.login : null,
          kind: "artifact.failed",
          payload: { artifactId: artifact.art_id, kind: artifact.kind, reason: verdict.message }
        });
      });
      return { status: 422, code: "digest_mismatch", message: verdict.message };
    }

    // The thumbnail is presentation, not evidence: one that never arrived or
    // does not match is dropped — the fields clear, and the blob's own
    // completion stands.
    let thumbOk = false;
    if (artifact.thumb_object_key !== null && artifact.thumb_sha256 !== null) {
      const thumbVerdict = await verifyUploaded(store, artifact.thumb_object_key, {
        byteSize: Number(artifact.thumb_byte_size),
        sha256: artifact.thumb_sha256
      });
      thumbOk = thumbVerdict.verdict === "ok";
    }

    const finalState = artifact.interruption_reason !== null ? "interrupted" : "available";
    await withTransaction(deps.db, async (client) => {
      await client.query(
        `update artifacts
            set state = $2, completed_at = now(),
                thumb_object_key = case when $3 then thumb_object_key else null end,
                thumb_byte_size = case when $3 then thumb_byte_size else null end,
                thumb_sha256 = case when $3 then thumb_sha256 else null end
          where art_id = $1 and state = 'pending'`,
        [artifact.art_id, finalState, thumbOk]
      );
      await recordEvent(client, {
        orgId: artifact.org_id,
        missionId: artifact.mission_id,
        workstreamId: artifact.wst_id,
        executionId: artifact.exe_id,
        actorKind: actor.kind,
        actorId: actor.id,
        actorLogin: actor.kind === "user" ? actor.login : null,
        kind: "artifact.captured",
        payload: {
          artifactId: artifact.art_id,
          kind: artifact.kind,
          label: artifact.label,
          state: finalState,
          initiator: artifact.initiator,
          revisionSha: artifact.revision_sha,
          ...(artifact.approval_id ? { approvalId: artifact.approval_id } : {})
        }
      });
    });
    const served = await deps.db.query(`${ARTIFACT_SELECT} where a.art_id = $1`, [artifact.art_id]);
    const refs = await attachmentRefs(deps.db, artifact.mission_id);
    return {
      artifact: serveArtifact(served.rows[0] as ArtifactRow, refs.get(artifact.art_id) ?? [])
    };
  };

  app.post("/artifacts/:artifactId/complete", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const artifactId = (request.params as { artifactId?: string }).artifactId ?? "";
    const body = (request.body ?? {}) as { outcome?: string; failureReason?: string };
    if (body.outcome !== "uploaded" && body.outcome !== "failed") {
      return deps.sendError(reply, 422, "invalid_completion", "Say how the upload ended: uploaded or failed.");
    }
    const loaded = await deps.db.query(`${ARTIFACT_SELECT} where a.art_id = $1`, [artifactId]);
    const artifact = loaded.rows[0] as ArtifactRow | undefined;
    if (!artifact) return deps.sendError(reply, 404, "not_found", "No such artifact.");
    const access = await missionAccess(deps.db, ctx, artifact.mission_id, artifact.wst_id);
    if (!access) return deps.sendError(reply, 404, "not_found", "No such artifact.");
    requireCapability(access, "artifact.capture");
    const settled = await complete(artifact, body.outcome, body.failureReason, {
      kind: "user",
      id: ctx.userId,
      login: ctx.login
    });
    if ("status" in settled) return deps.sendError(reply, settled.status, settled.code, settled.message);
    return settled;
  });

  app.post("/runner/artifacts/:artifactId/complete", async (request, reply) => {
    const runner = await requireRunner(request, reply);
    if (!runner) return;
    const artifactId = (request.params as { artifactId?: string }).artifactId ?? "";
    const body = (request.body ?? {}) as { outcome?: string; failureReason?: string };
    if (body.outcome !== "uploaded" && body.outcome !== "failed") {
      return deps.sendError(reply, 422, "invalid_completion", "Say how the upload ended: uploaded or failed.");
    }
    const loaded = await deps.db.query(`${ARTIFACT_SELECT} where a.art_id = $1`, [artifactId]);
    const artifact = loaded.rows[0] as ArtifactRow | undefined;
    // A runner may complete only what it began: its own lane's agent-requested
    // rows. Anything else is answered as not found, never widened.
    if (!artifact || artifact.wst_id !== runner.workstreamId || artifact.initiator !== "agent") {
      return deps.sendError(reply, 404, "not_found", "No such artifact for this runner.");
    }
    const settled = await complete(artifact, body.outcome, body.failureReason, {
      kind: "harness",
      id: "claude-code"
    });
    if ("status" in settled) return deps.sendError(reply, settled.status, settled.code, settled.message);
    return settled;
  });

  // --- Temporary viewing -----------------------------------------------------

  app.post("/artifacts/:artifactId/view", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const artifactId = (request.params as { artifactId?: string }).artifactId ?? "";
    const loaded = await deps.db.query(`${ARTIFACT_SELECT} where a.art_id = $1`, [artifactId]);
    const artifact = loaded.rows[0] as ArtifactRow | undefined;
    if (!artifact) return deps.sendError(reply, 404, "not_found", "No such artifact.");
    // Mission authorization is the read boundary (D-022): a person without
    // access to the mission is told nothing exists, exactly as missions are.
    const access = await missionAccess(deps.db, ctx, artifact.mission_id);
    if (!access) return deps.sendError(reply, 404, "not_found", "No such artifact.");
    if (store === null) return unconfigured(reply);
    if (artifact.state !== "available" && artifact.state !== "interrupted") {
      return deps.sendError(
        reply,
        409,
        "not_viewable",
        `This artifact is ${artifact.state}; there is nothing verified to view.`
      );
    }
    const url = await store.presignDownload(artifact.object_key, {
      expiresInSeconds: VIEW_TTL_SECONDS
    });
    const thumbnailUrl =
      artifact.thumb_object_key !== null
        ? await store.presignDownload(artifact.thumb_object_key, {
            expiresInSeconds: VIEW_TTL_SECONDS
          })
        : null;
    return {
      url,
      mimeType: artifact.mime_type,
      expiresAt: new Date(Date.now() + VIEW_TTL_SECONDS * 1000).toISOString(),
      thumbnailUrl
    };
  });

  // --- Attachments (D-122) ---------------------------------------------------

  app.post("/artifacts/:artifactId/attach", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const artifactId = (request.params as { artifactId?: string }).artifactId ?? "";
    const body = AttachArtifactInputSchema.safeParse(request.body);
    if (!body.success) {
      return deps.sendError(reply, 422, "invalid_attachment", "Say what to attach this to.");
    }
    const loaded = await deps.db.query(`${ARTIFACT_SELECT} where a.art_id = $1`, [artifactId]);
    const artifact = loaded.rows[0] as ArtifactRow | undefined;
    if (!artifact) return deps.sendError(reply, 404, "not_found", "No such artifact.");
    const access = await missionAccess(deps.db, ctx, artifact.mission_id);
    if (!access) return deps.sendError(reply, 404, "not_found", "No such artifact.");
    requireCapability(access, "artifact.attach");
    const ended = await closedRefusal(deps.db, access.missionId);
    if (ended) return deps.sendError(reply, 409, "mission_closed", ended);
    if (artifact.state !== "available" && artifact.state !== "interrupted") {
      return deps.sendError(
        reply,
        409,
        "not_evidence",
        `This artifact is ${artifact.state}; only completed evidence can be attached.`
      );
    }

    // The target must be this same mission's — an artifact never becomes
    // evidence for work it did not witness (cross-mission refusal, D-122).
    const target = body.data.target;
    let label: string;
    if (target.kind === "check") {
      const check = await deps.db.query(
        "select name from verification_checks where chk_id = $1 and mission_id = $2",
        [target.id, artifact.mission_id]
      );
      if ((check.rowCount ?? 0) === 0) {
        return deps.sendError(reply, 404, "not_found", "No such check in this mission.");
      }
      label = `check "${(check.rows[0]!.name as string).slice(0, 180)}"`;
    } else {
      const pull = await deps.db.query(
        "select provider_number from pull_requests where pr_id = $1 and mission_id = $2",
        [target.id, artifact.mission_id]
      );
      if ((pull.rowCount ?? 0) === 0) {
        return deps.sendError(reply, 404, "not_found", "No such pull request in this mission.");
      }
      label = `PR #${pull.rows[0]!.provider_number}`;
    }

    await withTransaction(deps.db, async (client) => {
      const inserted = await client.query(
        `insert into artifact_attachments (att_id, org_id, mission_id, art_id, target_kind, target_id, attached_by)
         select $1, $2, $3, $4, $5, $6, $7
          where not exists (
            select 1 from artifact_attachments
             where art_id = $4 and target_kind = $5 and target_id = $6 and detached_at is null)
         returning att_id`,
        [newAttachmentId(), access.orgId, access.missionId, artifactId, target.kind, target.id, ctx.userId]
      );
      // Attaching what is already attached changes nothing and records
      // nothing: the relationship is a fact, not a counter.
      if ((inserted.rowCount ?? 0) === 0) return;
      await recordEvent(client, {
        orgId: access.orgId,
        missionId: access.missionId,
        workstreamId: artifact.wst_id,
        actorKind: "user",
        actorId: ctx.userId,
        actorLogin: ctx.login,
        kind: "artifact.attached",
        payload: { artifactId, kind: artifact.kind, label: artifact.label, target: label }
      });
    });
    return { ok: true };
  });

  app.post("/artifacts/:artifactId/detach", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const artifactId = (request.params as { artifactId?: string }).artifactId ?? "";
    const body = AttachArtifactInputSchema.safeParse(request.body);
    if (!body.success) {
      return deps.sendError(reply, 422, "invalid_attachment", "Say what to detach this from.");
    }
    const loaded = await deps.db.query(`${ARTIFACT_SELECT} where a.art_id = $1`, [artifactId]);
    const artifact = loaded.rows[0] as ArtifactRow | undefined;
    if (!artifact) return deps.sendError(reply, 404, "not_found", "No such artifact.");
    const access = await missionAccess(deps.db, ctx, artifact.mission_id);
    if (!access) return deps.sendError(reply, 404, "not_found", "No such artifact.");
    requireCapability(access, "artifact.attach");
    const ended = await closedRefusal(deps.db, access.missionId);
    if (ended) return deps.sendError(reply, 409, "mission_closed", ended);

    await withTransaction(deps.db, async (client) => {
      const detached = await client.query(
        `update artifact_attachments set detached_at = now(), detached_by = $4
          where art_id = $1 and target_kind = $2 and target_id = $3 and detached_at is null
          returning att_id`,
        [artifactId, body.data.target.kind, body.data.target.id, ctx.userId]
      );
      if ((detached.rowCount ?? 0) === 0) return;
      await recordEvent(client, {
        orgId: access.orgId,
        missionId: access.missionId,
        workstreamId: artifact.wst_id,
        actorKind: "user",
        actorId: ctx.userId,
        actorLogin: ctx.login,
        kind: "artifact.detached",
        payload: {
          artifactId,
          kind: artifact.kind,
          label: artifact.label,
          target: `${body.data.target.kind} ${body.data.target.id}`
        }
      });
    });
    return { ok: true };
  });
}

/**
 * The reliability sweep's half (D-122): a pending row whose upload never
 * completed inside the TTL becomes `failed` with the reason stated — it must
 * never linger as almost-evidence, and it must never quietly become evidence
 * later. Returns how many were failed, for the sweep's own accounting.
 */
export async function sweepStalePendingArtifacts(db: Db): Promise<number> {
  const stale = await db.query(
    `select art_id, org_id, mission_id, wst_id, exe_id, kind from artifacts
      where state = 'pending' and created_at < now() - interval '15 minutes'`
  );
  for (const row of stale.rows) {
    await withTransaction(db, async (client) => {
      const moved = await client.query(
        `update artifacts set state = 'failed', completed_at = now(),
                failure_reason = 'The upload never completed.'
          where art_id = $1 and state = 'pending' returning art_id`,
        [row.art_id]
      );
      if ((moved.rowCount ?? 0) === 0) return;
      await recordEvent(client, {
        orgId: row.org_id as string,
        missionId: row.mission_id as string,
        workstreamId: (row.wst_id as string | null) ?? null,
        executionId: (row.exe_id as string | null) ?? null,
        actorKind: "system",
        actorId: "reliability-sweep",
        kind: "artifact.failed",
        payload: {
          artifactId: row.art_id,
          kind: row.kind,
          reason: "The upload never completed."
        }
      });
    });
  }
  return stale.rowCount ?? 0;
}
