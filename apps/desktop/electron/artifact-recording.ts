import { createHash, randomBytes, type Hash } from "node:crypto";
import { createWriteStream, mkdirSync, readdirSync, rmSync, statSync, type WriteStream } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  MAX_RECORDING_BYTES,
  MAX_RECORDING_MS,
  type Artifact,
  type ArtifactProvenance,
  type ProcessLog,
  type RecordingStatus
} from "@novus/contracts";
import { ApiError } from "./api-client";
import { captureProvenance, captureRefusal } from "./artifact-policy";
import { uploadCapturedArtifact, worktreeRevision, type ArtifactUploader } from "./artifact-capture";
import {
  capturePreviewImage,
  embeddedPreviewStatus,
  onEmbeddedPreviewStatus,
  previewContentsForRecording
} from "./workspace-preview";

/**
 * Preview recording (D-123): not a screen recorder — the one recordable
 * surface is the validated embedded preview, and the frames come from its own
 * `WebContents`, handed to a hidden Novus-owned recorder page through the
 * display-media handler this module installs. Chromium's own encoder produces
 * WebM; the main process owns the temp file, the incremental digest, the
 * limits, and the upload.
 *
 * One recording at a time, machine-wide. Endings mean what they say:
 *
 *  - **Stop** finalizes and uploads: `available`.
 *  - The **stated bound** (duration or size) stops it the same clean way —
 *    documented behavior, not an accident.
 *  - The process exiting, the preview going down, or the encoder failing
 *    mid-recording finalizes what was actually captured as **interrupted**,
 *    with the reason — never published as an ordinary success.
 *  - **Cancel** discards everything: no artifact, nothing durable.
 *
 * Temp files live in a 0700 directory under userData, 0600 each, removed on
 * every terminal outcome; a leftover from a crash is swept at the next start.
 */

const FRAME_RATE = 15;
/** Stop before the store's ceiling so the finalized file always fits it. */
const SIZE_STOP_BYTES = MAX_RECORDING_BYTES - 20_000_000;

interface RecorderHost {
  /** Creates the hidden recorder window and resolves when its page is ready.
   *  Injected so the module never imports Electron at module scope. */
  createRecorderWindow(preloadPath: string, partition: string): Promise<RecorderWindow>;
  /** The capture session's display-media hook (Electron's own), pointed at
   *  the preview contents for exactly the life of one recording. */
  setDisplayMediaSource(partition: string, contents: unknown | null): void;
  onRecorderMessage(channel: string, listener: (payload: unknown) => void): () => void;
  userDataPath: string;
  preloadPath: string;
}

interface RecorderWindow {
  /** Asks the page to start encoding, under a user gesture — Chromium
   *  requires transient activation for `getDisplayMedia`. */
  start(frameRate: number): void;
  /** Asks the encoder to stop and flush. */
  stop(): void;
  destroy(): void;
}

interface ActiveRecording {
  missionId: string;
  workstreamId: string;
  startedAtMs: number;
  status: RecordingStatus;
  filePath: string;
  fileStream: WriteStream;
  hash: Hash;
  bytes: number;
  window: RecorderWindow;
  unsubscribe: (() => void)[];
  limitTimer: NodeJS.Timeout;
  /** Set once something decided how this ends; the finalize path reads it. */
  ending: { kind: "stop" | "cancel" } | { kind: "interrupted"; reason: string } | null;
  /** Resolves when the encoder has flushed its last chunk. */
  encoderDone: Promise<void>;
  settleEncoder: () => void;
  sanitize: (text: string) => string;
  worktreePath: string;
  logs: () => ProcessLog[];
  uploader: ArtifactUploader;
}

let host: RecorderHost | null = null;
let active: ActiveRecording | null = null;
const statusListeners = new Set<(status: RecordingStatus | null) => void>();

export function initializeRecorder(recorderHost: RecorderHost): void {
  host = recorderHost;
  sweepTempFiles(recorderHost.userDataPath);
}

/** Removes leftover encoding files from a previous launch: a crash mid-
 *  recording must leave no half-encoded file behind (D-123). */
export function sweepTempFiles(userDataPath: string): void {
  const dir = capturesDir(userDataPath);
  try {
    for (const name of readdirSync(dir)) {
      rmSync(join(dir, name), { force: true });
    }
  } catch {
    /* nothing to sweep */
  }
}

function capturesDir(userDataPath: string): string {
  const dir = join(userDataPath, "captures");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function onRecordingStatus(listener: (status: RecordingStatus | null) => void): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

export function recordingStatus(): RecordingStatus | null {
  return active === null ? null : { ...active.status };
}

function announce(): void {
  const status = recordingStatus();
  for (const listener of statusListeners) {
    try {
      listener(status);
    } catch {
      /* a broken listener must not take the recording down */
    }
  }
}

/**
 * Starts recording the named lane's live preview. The same policy gates as a
 * screenshot (D-123): the preview must be this lane's, open, page loaded,
 * process live. Throws an ApiError whose message is the refusal in words.
 */
export async function startRecording(args: {
  missionId: string;
  workstreamId: string;
  worktreePath: string;
  logs: () => ProcessLog[];
  sanitize: (text: string) => string;
  uploader: ArtifactUploader;
}): Promise<RecordingStatus> {
  const recorderHost = host;
  if (recorderHost === null) {
    throw new ApiError("recording_refused", "This machine's recorder is not initialized.", 409);
  }
  if (active !== null) {
    throw new ApiError(
      "recording_refused",
      "A recording is already running. Stop it or cancel it first.",
      409
    );
  }
  const refusal = captureRefusal(embeddedPreviewStatus(), args.workstreamId, args.logs());
  if (refusal !== null) throw new ApiError("recording_refused", refusal, 409);
  const source = previewContentsForRecording(args.workstreamId);
  if (source === null) {
    throw new ApiError("recording_refused", "The preview has no loaded page to record.", 409);
  }

  const partition = "capture";
  const filePath = join(
    capturesDir(recorderHost.userDataPath),
    `recording-${randomBytes(8).toString("hex")}.webm`
  );
  const fileStream = createWriteStream(filePath, { mode: 0o600 });
  recorderHost.setDisplayMediaSource(partition, source.contents);
  const window = await recorderHost.createRecorderWindow(recorderHost.preloadPath, partition);

  let settleEncoder = () => undefined as void;
  const encoderDone = new Promise<void>((resolve) => {
    settleEncoder = resolve;
  });
  let settleStarted: (outcome: { ok: true } | { ok: false; reason: string }) => void = () =>
    undefined;
  const started = new Promise<{ ok: true } | { ok: false; reason: string }>((resolve) => {
    settleStarted = resolve;
  });

  const recording: ActiveRecording = {
    missionId: args.missionId,
    workstreamId: args.workstreamId,
    startedAtMs: Date.now(),
    status: {
      missionId: args.missionId,
      workstreamId: args.workstreamId,
      state: "recording",
      startedAt: new Date().toISOString(),
      processName: source.status.processName.slice(0, 120),
      maxDurationMs: MAX_RECORDING_MS
    },
    filePath,
    fileStream,
    hash: createHash("sha256"),
    bytes: 0,
    window,
    unsubscribe: [],
    limitTimer: setTimeout(() => {
      // The stated bound: a clean, documented stop, never an accident.
      void stopRecording().catch(() => undefined);
    }, MAX_RECORDING_MS),
    ending: null,
    encoderDone,
    settleEncoder,
    sanitize: args.sanitize,
    worktreePath: args.worktreePath,
    logs: args.logs,
    uploader: args.uploader
  };
  recording.limitTimer.unref?.();
  active = recording;

  recording.unsubscribe.push(
    recorderHost.onRecorderMessage("record:chunk", (payload) => {
      if (active !== recording || recording.ending?.kind === "cancel") return;
      const chunk = Buffer.from(payload as ArrayBuffer);
      recording.hash.update(chunk);
      recording.bytes += chunk.length;
      recording.fileStream.write(chunk);
      if (recording.bytes >= SIZE_STOP_BYTES) {
        void stopRecording().catch(() => undefined);
      }
    }),
    recorderHost.onRecorderMessage("record:started", () => {
      settleStarted({ ok: true });
    }),
    recorderHost.onRecorderMessage("record:ended", () => {
      recording.settleEncoder();
    }),
    recorderHost.onRecorderMessage("record:error", (payload) => {
      const reason = typeof payload === "string" ? payload.slice(0, 300) : "The encoder failed.";
      settleStarted({ ok: false, reason });
      if (active !== recording) return;
      if (recording.ending === null) {
        recording.ending = { kind: "interrupted", reason };
      }
      recording.settleEncoder();
      void finalize(recording).catch(() => undefined);
    }),
    recorderHost.onRecorderMessage("record:source-ended", () => {
      if (active !== recording || recording.ending !== null) return;
      recording.ending = {
        kind: "interrupted",
        reason: "The preview went down while recording."
      };
      // The encoder's own onstop still flushes what was captured.
    }),
    // The preview's own story: the process exiting or the page crashing takes
    // the surface down, and the recording ends honestly with the reason.
    onEmbeddedPreviewStatus((status) => {
      if (active !== recording || recording.ending !== null) return;
      const gone =
        status === null ||
        status.workstreamId !== recording.workstreamId ||
        status.phase === "stopped" ||
        status.phase === "crashed";
      if (!gone) return;
      recording.ending = {
        kind: "interrupted",
        reason:
          status?.phase === "crashed"
            ? "The preview's page crashed while recording."
            : "The app stopped while recording."
      };
      recording.window.stop();
      void finalize(recording).catch(() => undefined);
    })
  );

  window.start(FRAME_RATE);
  // The encoder either starts or says why not — a refusal is words here, not
  // a state that flashes and vanishes.
  const outcome = await Promise.race([
    started,
    new Promise<{ ok: false; reason: string }>((resolve) =>
      setTimeout(() => resolve({ ok: false, reason: "The encoder never answered." }), 10_000)
    )
  ]);
  if (!outcome.ok) {
    for (const unsubscribe of recording.unsubscribe) unsubscribe();
    clearTimeout(recording.limitTimer);
    recording.window.destroy();
    recorderHost.setDisplayMediaSource(partition, null);
    await new Promise<void>((resolve) => recording.fileStream.end(resolve));
    await rm(recording.filePath, { force: true }).catch(() => undefined);
    active = null;
    announce();
    throw new ApiError("recording_refused", `Recording could not start: ${outcome.reason}`, 409);
  }
  announce();
  return { ...recording.status };
}

/** Stops and preserves the recording as evidence. */
export async function stopRecording(): Promise<Artifact> {
  const recording = active;
  if (recording === null) {
    throw new ApiError("recording_refused", "No recording is running.", 409);
  }
  if (recording.ending === null) recording.ending = { kind: "stop" };
  recording.window.stop();
  const artifact = await finalize(recording);
  if (artifact === null) {
    throw new ApiError("recording_refused", "The recording was cancelled.", 409);
  }
  return artifact;
}

/** Abandons the recording: no artifact, nothing durable, temp removed. */
export async function cancelRecording(): Promise<void> {
  const recording = active;
  if (recording === null) return;
  recording.ending = { kind: "cancel" };
  recording.window.stop();
  await finalize(recording);
}

let finalizing: Promise<Artifact | null> | null = null;

/** One finalize per recording, whoever asks first; late callers share it. */
function finalize(recording: ActiveRecording): Promise<Artifact | null> {
  if (finalizing !== null) return finalizing;
  finalizing = finalizeOnce(recording).finally(() => {
    finalizing = null;
  });
  return finalizing;
}

async function finalizeOnce(recording: ActiveRecording): Promise<Artifact | null> {
  const recorderHost = host;
  recording.status = { ...recording.status, state: "finalizing" };
  announce();
  clearTimeout(recording.limitTimer);

  // The encoder's last chunk, bounded: a wedged encoder must not hold the
  // room's recording state forever.
  await Promise.race([
    recording.encoderDone,
    new Promise((settle) => setTimeout(settle, 10_000))
  ]);

  for (const unsubscribe of recording.unsubscribe) unsubscribe();
  recording.window.destroy();
  recorderHost?.setDisplayMediaSource("capture", null);
  await new Promise<void>((resolve) => recording.fileStream.end(resolve));

  const durationMs = Date.now() - recording.startedAtMs;
  const ending = recording.ending ?? { kind: "stop" as const };
  active = null;
  announce();

  try {
    if (ending.kind === "cancel") return null;
    if (recording.bytes === 0) {
      throw new ApiError(
        "recording_failed",
        "The recording captured nothing; there is no evidence to preserve.",
        409
      );
    }

    // The poster frame: the preview as it looks at the end, when it is still
    // there to ask; an interrupted recording may honestly have none.
    const poster = await capturePreviewImage(recording.workstreamId)
      .then((shot) => (shot.ok ? shot.image.resize({ width: 480 }).toPNG() : null))
      .catch(() => null);

    const status = embeddedPreviewStatus();
    const logs = recording.logs();
    const fromView =
      status !== null && status.workstreamId === recording.workstreamId
        ? captureProvenance(status, logs)
        : null;
    const revision = await worktreeRevision(recording.worktreePath);
    const provenance: ArtifactProvenance = {
      processId: fromView?.processId ?? "prc_unknown",
      processName: recording.sanitize(recording.status.processName).slice(0, 120) || "app",
      origin: recording.sanitize(fromView?.origin ?? "http://127.0.0.1").slice(0, 300),
      readiness: fromView?.readiness ?? "not_required",
      revisionSha: revision.sha,
      revisionDirty: revision.dirty,
      durationMs
    };

    const bytes = await readFile(recording.filePath);
    return await uploadCapturedArtifact({
      kind: "recording",
      mimeType: "video/webm",
      bytes,
      thumbnail: poster,
      capturedAt: new Date(recording.startedAtMs).toISOString(),
      ...(ending.kind === "interrupted"
        ? { interrupted: true, interruptionReason: ending.reason }
        : {}),
      provenance,
      uploader: recording.uploader
    });
  } finally {
    await rm(recording.filePath, { force: true }).catch(() => undefined);
  }
}

/** Test hook: how large the temp area currently is. */
export function tempFileCount(userDataPath: string): number {
  try {
    return readdirSync(capturesDir(userDataPath)).filter((name) => {
      try {
        return statSync(join(capturesDir(userDataPath), name)).isFile();
      } catch {
        return false;
      }
    }).length;
  } catch {
    return 0;
  }
}
