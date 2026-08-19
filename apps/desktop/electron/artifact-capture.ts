import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  Artifact,
  ArtifactProvenance,
  ArtifactUploadGrant,
  BeginArtifactResponse,
  ProcessLog
} from "@novus/contracts";
import { ApiError } from "./api-client";
import { captureProvenance, captureRefusal } from "./artifact-policy";
import { capturePreviewImage, embeddedPreviewStatus } from "./workspace-preview";

/**
 * The capture pipeline (D-123): pixels from the validated preview, provenance
 * from the machine that holds both the view and the worktree, bytes into the
 * store under D-122's grants. The main process is the only caller; the
 * renderer's whole contribution is "capture this lane's preview", and the
 * agent's is a routed, approved request that lands here too.
 *
 * Upload grants arrive from the control plane, are used once, and are held in
 * function scope only — never stored, never logged, never given to anything.
 */

/** Thumbnails are presentation: small, fixed-width, verified like the blob. */
const THUMB_WIDTH = 480;

export interface ArtifactUploader {
  /** Begins the artifact under the initiator's own authority — the person's
   *  session, or the runner credential naming the requesting execution. */
  begin(input: {
    kind: "screenshot" | "recording";
    mimeType: "image/png" | "video/webm";
    byteSize: number;
    sha256: string;
    thumbnail?: { byteSize: number; sha256: string };
    capturedAt: string;
    interrupted?: boolean;
    interruptionReason?: string;
    provenance: ArtifactProvenance;
  }): Promise<BeginArtifactResponse>;
  complete(
    artifactId: string,
    outcome: "uploaded" | "failed",
    failureReason?: string
  ): Promise<Artifact>;
}

const sha256Of = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** The worktree's revision at this exact moment — a git fact, with dirtiness
 *  stated rather than hidden. Null when there is no worktree to ask. */
export async function worktreeRevision(
  worktreePath: string
): Promise<{ sha: string | null; dirty: boolean }> {
  if (!existsSync(join(worktreePath, ".git"))) return { sha: null, dirty: false };
  const git = (args: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile("git", ["-C", worktreePath, ...args], { timeout: 15_000 }, (error, stdout) =>
        error ? reject(error) : resolve(stdout)
      );
    });
  try {
    const [head, status] = await Promise.all([git(["rev-parse", "HEAD"]), git(["status", "--porcelain"])]);
    const sha = head.trim();
    return { sha: /^[0-9a-f]{40}$/.test(sha) ? sha : null, dirty: status.trim().length > 0 };
  } catch {
    return { sha: null, dirty: false };
  }
}

async function putGrant(grant: ArtifactUploadGrant, bytes: Buffer): Promise<void> {
  const response = await fetch(grant.url, {
    method: grant.method,
    headers: grant.headers,
    body: new Uint8Array(bytes)
  });
  if (!response.ok) {
    throw new ApiError(
      "upload_failed",
      `The artifact store refused the upload (${response.status}).`,
      502
    );
  }
}

/**
 * Uploads captured bytes as one artifact: begin with the promise, PUT exactly
 * those bytes, complete on the store's verification. A failed upload is
 * completed as failed with the reason — the row must say what happened, not
 * linger as almost-evidence — and the failure is then rethrown in words.
 */
export async function uploadCapturedArtifact(args: {
  kind: "screenshot" | "recording";
  mimeType: "image/png" | "video/webm";
  bytes: Buffer;
  thumbnail: Buffer | null;
  capturedAt: string;
  interrupted?: boolean;
  interruptionReason?: string;
  provenance: ArtifactProvenance;
  uploader: ArtifactUploader;
}): Promise<Artifact> {
  const begun = await args.uploader.begin({
    kind: args.kind,
    mimeType: args.mimeType,
    byteSize: args.bytes.length,
    sha256: sha256Of(args.bytes),
    ...(args.thumbnail
      ? { thumbnail: { byteSize: args.thumbnail.length, sha256: sha256Of(args.thumbnail) } }
      : {}),
    capturedAt: args.capturedAt,
    ...(args.interrupted ? { interrupted: true, interruptionReason: args.interruptionReason } : {}),
    provenance: args.provenance
  });
  const artifactId = begun.artifact.artifactId;
  try {
    await putGrant(begun.upload, args.bytes);
    if (args.thumbnail && begun.thumbnailUpload) {
      // A thumbnail that fails to land is dropped by the completion check —
      // presentation must never block evidence.
      await putGrant(begun.thumbnailUpload, args.thumbnail).catch(() => undefined);
    }
  } catch (error) {
    const reason =
      error instanceof Error ? error.message.slice(0, 300) : "The upload did not complete.";
    await args.uploader.complete(artifactId, "failed", reason).catch(() => undefined);
    throw error instanceof ApiError ? error : new ApiError("upload_failed", reason, 502);
  }
  return args.uploader.complete(artifactId, "uploaded");
}

/**
 * A screenshot of the lane's live preview, as evidence (D-123).
 *
 * The whole judgment chain runs here, in the main process: the preview must
 * be this lane's, live, and showing a page on screen; the pixels are the
 * embedded view's own; the revision is read from git at this moment with
 * dirtiness stated; textual metadata passes the caller's redaction before it
 * travels. Throws an ApiError whose message is the refusal, in words.
 */
/** How long a capture waits out a page mid-reload before refusing (D-169).
 *  The preview's element remounts, and so reloads, every time its tab is
 *  left and returned to (the guest page's own process does not survive a
 *  React unmount, unlike the native view this replaced) — a real page on a
 *  real local server finishes that reload in well under this bound, and a
 *  request that lands in the middle of it deserves the wait, not an honest
 *  but avoidable refusal. */
const RELOAD_WAIT_MS = 8_000;
const RELOAD_POLL_MS = 100;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits out a *this lane's own* page reloading, and only that: every other
 *  refusal reason (wrong lane, unreachable, crashed, stopped, no live
 *  process) is exactly as immediate as it always was. Exported for the
 *  recording entry point (D-169), which faces the identical race. */
export async function awaitReadyIfReloading(workstreamId: string): Promise<void> {
  const deadline = Date.now() + RELOAD_WAIT_MS;
  while (Date.now() < deadline) {
    const status = embeddedPreviewStatus();
    if (status === null || status.workstreamId !== workstreamId || status.phase !== "loading") return;
    await sleep(RELOAD_POLL_MS);
  }
}

export async function captureScreenshot(args: {
  workstreamId: string;
  worktreePath: string;
  logs: ProcessLog[];
  /** The known-secret redaction for this lane's project (D-052), applied to
   *  every textual metadata field before it leaves this machine. */
  sanitize: (text: string) => string;
  uploader: ArtifactUploader;
}): Promise<Artifact> {
  await awaitReadyIfReloading(args.workstreamId);
  const refusal = captureRefusal(embeddedPreviewStatus(), args.workstreamId, args.logs);
  if (refusal !== null) throw new ApiError("capture_refused", refusal, 409);

  const shot = await capturePreviewImage(args.workstreamId);
  if (!shot.ok) throw new ApiError("capture_refused", shot.refusal, 409);

  const capturedAt = new Date().toISOString();
  const bytes = shot.image.toPNG();
  const size = shot.image.getSize();
  const thumbnail =
    size.width > THUMB_WIDTH ? shot.image.resize({ width: THUMB_WIDTH }).toPNG() : bytes;
  const revision = await worktreeRevision(args.worktreePath);
  const source = captureProvenance(shot.status, args.logs);
  const provenance: ArtifactProvenance = {
    processId: source.processId,
    processName: args.sanitize(source.processName).slice(0, 120),
    // The origin was validated credential-free before the view existed
    // (D-098); sanitized again here because a belt is not a reason to skip
    // the braces.
    origin: args.sanitize(source.origin).slice(0, 300),
    readiness: source.readiness,
    revisionSha: revision.sha,
    revisionDirty: revision.dirty
  };
  return uploadCapturedArtifact({
    kind: "screenshot",
    mimeType: "image/png",
    bytes,
    thumbnail,
    capturedAt,
    provenance,
    uploader: args.uploader
  });
}
