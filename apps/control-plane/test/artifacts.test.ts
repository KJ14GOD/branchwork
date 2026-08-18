import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReportableRunnerEvent } from "@novus/contracts";
import { FakeRepositoryProvider } from "../src/repo-provider.ts";
import { sweepStalePendingArtifacts } from "../src/artifacts.ts";
import { bearer, createHarness, type Harness, type SignedIn } from "./harness.ts";

/**
 * The Artifact foundation (D-022, D-122), against a real PostgreSQL and the
 * deterministic local store — which is a real HTTP store that genuinely
 * demands a signed grant and genuinely hashes what arrives, and is **never
 * live S3 proof**. In order of how badly it would matter if they stopped
 * holding:
 *
 *  - **A failed or incomplete upload never reads as evidence.** The store's
 *    own verification is the only thing that moves a row to available, and a
 *    row that is not available or interrupted cannot be viewed, attached, or
 *    cited by a decision.
 *  - **Mission authorization is the read boundary.** A person without mission
 *    access is told nothing exists, and knowing an artifact id or an object
 *    key retrieves nothing without a live signed grant.
 *  - **Capture and attachment are server-enforced capabilities**, tiered as
 *    PRODUCT.md says: capture like workspace.command (lease grants it),
 *    attachment like review.approve (role only).
 *  - **The receipt freezes the evidence set** — ids, digests, provenance —
 *    and reopening the mission reconstructs exactly that set.
 */

let harness: Harness;
let kartik: SignedIn;
let provider: FakeRepositoryProvider;
let artifactDir: string;

const sha1 = (value: string) => createHash("sha1").update(value).digest("hex");
const sha256Of = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const runnerAuth = (credential: string) => ({ authorization: `Runner ${credential}` });

interface Lane {
  missionId: string;
  workstreamId: string;
  missionBranch: string;
  credential: string;
  checkpointSha: string;
  executionId: string;
  sessionId: string;
}

beforeAll(async () => {
  artifactDir = mkdtempSync(join(tmpdir(), "novus-artifacts-"));
  process.env.NOVUS_ARTIFACT_DIR = artifactDir;
  process.env.NOVUS_ARTIFACT_SECRET = "artifact-test-secret";
  provider = new FakeRepositoryProvider();
  harness = await createHarness("novus_test_artifacts", provider);
  kartik = await harness.signIn("kartik");
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

let originSeq = 100;

/** A mission with an enrolled runner, one committed checkpoint, and a
 *  completed turn — the room an artifact gets captured in. */
async function lane(providerKind: "local" | "github" = "local"): Promise<Lane> {
  let providerRepoId: string;
  if (providerKind === "local") {
    providerRepoId = randomUUID();
    const registered = await harness.app.inject({
      method: "POST",
      url: "/repositories/local",
      headers: bearer(kartik),
      payload: {
        localId: providerRepoId,
        name: "novus/local",
        defaultBranch: "main",
        headSha: sha1(providerRepoId)
      }
    });
    expect(registered.statusCode).toBe(200);
  } else {
    providerRepoId = "9001";
  }
  const created = await harness.app.inject({
    method: "POST",
    url: "/missions",
    headers: bearer(kartik),
    payload: {
      goal: `Show the preview working ${randomUUID().slice(0, 8)}`,
      successCriteria: "Visual evidence exists with provenance",
      provider: providerKind,
      providerRepoId,
      baseRef: "main",
      baseSha: providerKind === "local" ? sha1(providerRepoId) : sha1("demo-app@main"),
      creationKey: randomUUID()
    }
  });
  expect(created.statusCode).toBe(201);
  const missionId = created.json().mission.missionId as string;
  const workstreamId = created.json().workstream.workstreamId as string;
  if (providerKind === "local") {
    await harness.app.inject({
      method: "POST",
      url: `/workstreams/${workstreamId}/branch/report`,
      headers: bearer(kartik),
      payload: { status: "created" }
    });
  }
  const laneRow = await harness.db.query(
    "select mission_branch from workstreams where wst_id = $1",
    [workstreamId]
  );
  const missionBranch = laneRow.rows[0].mission_branch as string;
  const enrolled = await harness.app.inject({
    method: "POST",
    url: `/workstreams/${workstreamId}/runner`,
    headers: bearer(kartik),
    payload: { workstreamId, label: "kartik-macbook" }
  });
  expect(enrolled.statusCode).toBe(200);
  const credential = enrolled.json().credential as string;

  const submitted = await harness.app.inject({
    method: "POST",
    url: `/missions/${missionId}/direction`,
    headers: bearer(kartik),
    payload: { body: "Run the app and prove it", model: "claude-fable-5", effort: "high", workstreamId }
  });
  expect(submitted.statusCode).toBe(200);
  const execution = await harness.db.query(
    "select exe_id, session_id from executions where wst_id = $1 order by created_at desc limit 1",
    [workstreamId]
  );
  const executionId = execution.rows[0].exe_id as string;
  const sessionId = execution.rows[0].session_id as string;
  const checkpointSha = sha1(`checkpoint:${workstreamId}`);
  const events: ReportableRunnerEvent[] = [
    { originSeq: (originSeq += 1), event: { kind: "execution.starting", payload: {} } },
    {
      originSeq: (originSeq += 1),
      event: {
        kind: "workspace.checkpoint",
        payload: {
          outcome: "committed",
          sha: checkpointSha,
          parentSha: null,
          branch: missionBranch,
          withheldSecrets: 0,
          uncommitted: false,
          error: null,
          files: [
            {
              path: "web/index.html",
              previousPath: null,
              changeState: "modified",
              additions: 3,
              deletions: 1,
              binary: false,
              diff: null,
              truncated: false
            }
          ]
        }
      }
    },
    { originSeq: (originSeq += 1), event: { kind: "execution.completed", payload: {} } }
  ];
  const reported = await harness.app.inject({
    method: "POST",
    url: "/runner/events",
    headers: runnerAuth(credential),
    payload: { executionId, events }
  });
  expect(reported.statusCode).toBe(200);
  return { missionId, workstreamId, missionBranch, credential, checkpointSha, executionId, sessionId };
}

const PNG_BYTES = Buffer.from(`png-bytes-${"x".repeat(64)}`);

function beginPayload(room: Lane, overrides: Record<string, unknown> = {}) {
  return {
    workstreamId: room.workstreamId,
    kind: "screenshot",
    mimeType: "image/png",
    byteSize: PNG_BYTES.length,
    sha256: sha256Of(PNG_BYTES),
    capturedAt: new Date().toISOString(),
    provenance: {
      processId: "prc_previewproc",
      processName: "web",
      origin: "http://127.0.0.1:4471",
      readiness: "ready",
      revisionSha: room.checkpointSha,
      revisionDirty: false
    },
    ...overrides
  };
}

async function begin(room: Lane, overrides: Record<string, unknown> = {}, as: SignedIn = kartik) {
  return harness.app.inject({
    method: "POST",
    url: `/missions/${room.missionId}/artifacts`,
    headers: bearer(as),
    payload: beginPayload(room, overrides)
  });
}

/** PUTs bytes against a grant, exactly as the desktop would over HTTP. */
async function putGrant(
  grant: { url: string; headers: Record<string, string> },
  bytes: Buffer
) {
  const url = new URL(grant.url);
  return harness.app.inject({
    method: "PUT",
    url: url.pathname + url.search,
    headers: grant.headers,
    payload: bytes
  });
}

async function complete(artifactId: string, outcome: "uploaded" | "failed", as: SignedIn = kartik) {
  return harness.app.inject({
    method: "POST",
    url: `/artifacts/${artifactId}/complete`,
    headers: bearer(as),
    payload: { outcome }
  });
}

async function detailOf(room: Lane, as: SignedIn = kartik) {
  const response = await harness.app.inject({
    method: "GET",
    url: `/missions/${room.missionId}?workstream=${room.workstreamId}`,
    headers: bearer(as)
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

/** A full begin→upload→complete, returning the available artifact's id. */
async function captured(room: Lane, overrides: Record<string, unknown> = {}): Promise<string> {
  const begun = await begin(room, overrides);
  expect(begun.statusCode).toBe(201);
  const uploaded = await putGrant(begun.json().upload, PNG_BYTES);
  expect(uploaded.statusCode).toBe(200);
  const done = await complete(begun.json().artifact.artifactId, "uploaded");
  expect(done.statusCode).toBe(200);
  return begun.json().artifact.artifactId as string;
}

/** Maya joins the mission at the stated role. */
async function joinMission(room: Lane, role: "contributor" | "viewer" | "operator"): Promise<SignedIn> {
  const maya = await harness.signIn(`maya-${randomUUID().slice(0, 8)}`);
  const invited = await harness.app.inject({
    method: "POST",
    url: `/missions/${room.missionId}/invitations`,
    headers: bearer(kartik),
    payload: { role }
  });
  expect(invited.statusCode).toBe(201);
  const redeemed = await harness.app.inject({
    method: "POST",
    url: "/invitations/redeem",
    headers: bearer(maya),
    payload: { token: invited.json().token }
  });
  expect(redeemed.statusCode).toBe(200);
  return maya;
}

describe("capturing (D-122)", () => {
  it("begins, uploads, verifies, and serves a screenshot with its provenance", async () => {
    const room = await lane();
    const begun = await begin(room, {
      provenance: {
        processId: "prc_previewproc",
        processName: "web",
        origin: "http://127.0.0.1:4471",
        readiness: "ready",
        revisionSha: room.checkpointSha,
        revisionDirty: false,
        sessionId: room.sessionId
      }
    });
    expect(begun.statusCode).toBe(201);
    const artifact = begun.json().artifact;
    expect(artifact.state).toBe("pending");
    expect(artifact.initiator).toBe("person");
    expect(artifact.createdByLogin).toBe(kartik.login);
    expect(artifact.label).toBe("Screenshot · web");
    expect(artifact.environment).toBe("local runner (kartik-macbook)");
    expect(artifact.sessionId).toBe(room.sessionId);
    // The captured revision matched a recorded checkpoint, so the checkpoint
    // is claimed; the sha is the git fact either way.
    expect(artifact.revisionSha).toBe(room.checkpointSha);
    expect(artifact.checkpointId).toMatch(/^ckp_/);
    // The wire never carries an object key or a stored URL.
    expect(JSON.stringify(begun.json().artifact)).not.toContain("missions/");

    const uploaded = await putGrant(begun.json().upload, PNG_BYTES);
    expect(uploaded.statusCode).toBe(200);
    const done = await complete(artifact.artifactId, "uploaded");
    expect(done.statusCode).toBe(200);
    expect(done.json().artifact.state).toBe("available");

    const detail = await detailOf(room);
    const served = detail.artifacts.find(
      (row: { artifactId: string }) => row.artifactId === artifact.artifactId
    );
    expect(served.state).toBe("available");
    expect(served.sha256).toBe(sha256Of(PNG_BYTES));
    expect(
      detail.events.some(
        (event: { kind: string; payload: { artifactId?: string } }) =>
          event.kind === "artifact.captured" && event.payload.artifactId === artifact.artifactId
      )
    ).toBe(true);
  }, 30_000);

  it("refuses a malformed claim: a screenshot that is not a PNG, and an oversized blob", async () => {
    const room = await lane();
    const wrongMime = await begin(room, { mimeType: "video/webm" });
    expect(wrongMime.statusCode).toBe(422);
    const tooLarge = await begin(room, { byteSize: 20_000_001 });
    expect(tooLarge.statusCode).toBe(422);
    expect(tooLarge.json().error.code).toBe("artifact_too_large");
  }, 30_000);

  it("enforces the capture tier: a contributor is refused until the lease grants it, a viewer always, a stranger sees no mission", async () => {
    const room = await lane();
    const contributor = await joinMission(room, "contributor");
    const refused = await begin(room, {}, contributor);
    expect(refused.statusCode).toBe(403);

    const viewer = await joinMission(room, "viewer");
    const viewerRefused = await begin(room, {}, viewer);
    expect(viewerRefused.statusCode).toBe(403);

    const stranger = await harness.signIn(`stranger-${randomUUID().slice(0, 8)}`);
    const unseen = await begin(room, {}, stranger);
    expect(unseen.statusCode).toBe(404);

    // The lease grants the operating verb (role ∪ lease): hand the baton to
    // the contributor and the same request succeeds.
    const requested = await harness.app.inject({
      method: "POST",
      url: `/missions/${room.missionId}/control/request`,
      headers: bearer(contributor),
      payload: {}
    });
    expect(requested.statusCode).toBe(200);
    const offered = await harness.app.inject({
      method: "POST",
      url: `/missions/${room.missionId}/control/offer`,
      headers: bearer(kartik),
      payload: { toUserId: contributor.userId }
    });
    expect(offered.statusCode).toBe(200);
    const detail = await detailOf(room, contributor);
    const offerId = detail.control.liveOffer?.offerId as string;
    expect(offerId).toBeTruthy();
    const accepted = await harness.app.inject({
      method: "POST",
      url: `/control/offers/${offerId}/accept`,
      headers: bearer(contributor),
      payload: {}
    });
    expect(accepted.statusCode).toBe(200);
    const nowAllowed = await begin(room, {}, contributor);
    expect(nowAllowed.statusCode).toBe(201);
  }, 30_000);

  it("refuses a capture for a lane no machine holds, and a conversation from another lane", async () => {
    // A mission whose runner enrolment never happened: begin refuses, because
    // nothing can have captured a preview that exists only on the machine
    // holding the workspace.
    const bare = await harness.app.inject({
      method: "POST",
      url: "/missions",
      headers: bearer(kartik),
      payload: {
        goal: "A mission with no machine",
        successCriteria: "Nothing captures here",
        provider: "github",
        providerRepoId: "9001",
        baseRef: "main",
        baseSha: sha1("demo-app@main"),
        creationKey: randomUUID()
      }
    });
    expect(bare.statusCode).toBe(201);
    const bareMission = bare.json().mission.missionId as string;
    const bareLane = bare.json().workstream.workstreamId as string;
    const refused = await harness.app.inject({
      method: "POST",
      url: `/missions/${bareMission}/artifacts`,
      headers: bearer(kartik),
      payload: beginPayload({ missionId: bareMission, workstreamId: bareLane } as Lane, {
        provenance: {
          processId: "prc_previewproc",
          processName: "web",
          origin: "http://127.0.0.1:4471",
          readiness: "ready",
          revisionSha: null,
          revisionDirty: false
        }
      })
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("no_runner");

    // A session that belongs to a different lane is answered as not found,
    // never adopted (the D-083 rule).
    const room = await lane();
    const foreign = await lane();
    const crossed = await begin(room, {
      provenance: {
        processId: "prc_previewproc",
        processName: "web",
        origin: "http://127.0.0.1:4471",
        readiness: "ready",
        revisionSha: null,
        revisionDirty: false,
        sessionId: foreign.sessionId
      }
    });
    expect(crossed.statusCode).toBe(404);
  }, 30_000);
});

describe("the store's own verification (D-122)", () => {
  it("refuses bytes that do not hash to the promise, and completion finds nothing arrived", async () => {
    const room = await lane();
    const begun = await begin(room);
    expect(begun.statusCode).toBe(201);
    const artifactId = begun.json().artifact.artifactId as string;

    const wrongBytes = await putGrant(begun.json().upload, Buffer.from("entirely different bytes"));
    expect(wrongBytes.statusCode).toBe(422);

    // Nothing landed, so completion refuses without failing the row: the
    // upload may still be coming.
    const early = await complete(artifactId, "uploaded");
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe("blob_missing");

    // The right bytes still complete it — a refused mismatch left no debris.
    const rightBytes = await putGrant(begun.json().upload, PNG_BYTES);
    expect(rightBytes.statusCode).toBe(200);
    const done = await complete(artifactId, "uploaded");
    expect(done.statusCode).toBe(200);
    expect(done.json().artifact.state).toBe("available");
  }, 30_000);

  it("refuses an upload whose length is not the authorized length", async () => {
    const room = await lane();
    const begun = await begin(room, {
      byteSize: PNG_BYTES.length + 10,
      sha256: sha256Of(Buffer.concat([PNG_BYTES, Buffer.from("0123456789")]))
    });
    const short = await putGrant(begun.json().upload, PNG_BYTES);
    expect(short.statusCode).toBe(422);
    expect(short.json().error.message).toContain("bytes");
  }, 30_000);

  it("refuses a tampered grant, an expired grant, and a bare guess at the key", async () => {
    const room = await lane();
    const begun = await begin(room);
    const grant = begun.json().upload as { url: string; headers: Record<string, string> };

    const tampered = new URL(grant.url);
    tampered.searchParams.set("size", "1");
    const forged = await harness.app.inject({
      method: "PUT",
      url: tampered.pathname + tampered.search,
      headers: grant.headers,
      payload: PNG_BYTES
    });
    expect(forged.statusCode).toBe(403);

    const bare = new URL(grant.url);
    const guessed = await harness.app.inject({
      method: "GET",
      url: bare.pathname
    });
    expect(guessed.statusCode).toBe(403);
  }, 30_000);

  it("records a failed upload as failed, with the reason, and never lets it become evidence", async () => {
    const room = await lane();
    const begun = await begin(room);
    const artifactId = begun.json().artifact.artifactId as string;
    const failed = await harness.app.inject({
      method: "POST",
      url: `/artifacts/${artifactId}/complete`,
      headers: bearer(kartik),
      payload: { outcome: "failed", failureReason: "The encoder crashed." }
    });
    expect(failed.statusCode).toBe(200);
    expect(failed.json().artifact.state).toBe("failed");
    expect(failed.json().artifact.failureReason).toBe("The encoder crashed.");

    // Terminal is terminal: it cannot be completed as uploaded afterwards.
    const late = await complete(artifactId, "uploaded");
    expect(late.statusCode).toBe(409);

    // And a failed artifact cannot be viewed or attached.
    const view = await harness.app.inject({
      method: "POST",
      url: `/artifacts/${artifactId}/view`,
      headers: bearer(kartik),
      payload: {}
    });
    expect(view.statusCode).toBe(409);

    const detail = await detailOf(room);
    expect(
      detail.events.some((event: { kind: string }) => event.kind === "artifact.failed")
    ).toBe(true);
  }, 30_000);

  it("lands a duplicate completion once: the second answers with the same artifact and records nothing new", async () => {
    const room = await lane();
    const artifactId = await captured(room);
    const again = await complete(artifactId, "uploaded");
    expect(again.statusCode).toBe(200);
    expect(again.json().artifact.state).toBe("available");
    const detail = await detailOf(room);
    const capturedEvents = detail.events.filter(
      (event: { kind: string; payload: { artifactId?: string } }) =>
        event.kind === "artifact.captured" && event.payload.artifactId === artifactId
    );
    expect(capturedEvents).toHaveLength(1);
    // A completed artifact can never become failed.
    const demote = await complete(artifactId, "failed");
    expect(demote.statusCode).toBe(409);
  }, 30_000);

  it("fails a pending upload the sweep finds abandoned, by name", async () => {
    const room = await lane();
    const begun = await begin(room);
    const artifactId = begun.json().artifact.artifactId as string;
    await harness.db.query(
      "update artifacts set created_at = now() - interval '20 minutes' where art_id = $1",
      [artifactId]
    );
    const swept = await sweepStalePendingArtifacts(harness.db);
    expect(swept).toBeGreaterThanOrEqual(1);
    const detail = await detailOf(room);
    const row = detail.artifacts.find(
      (artifact: { artifactId: string }) => artifact.artifactId === artifactId
    );
    expect(row.state).toBe("failed");
    expect(row.failureReason).toBe("The upload never completed.");
  }, 30_000);
});

describe("viewing (D-022)", () => {
  it("mints a temporary grant for a participant that serves the exact bytes, and tells a stranger nothing exists", async () => {
    const room = await lane();
    const artifactId = await captured(room);
    const view = await harness.app.inject({
      method: "POST",
      url: `/artifacts/${artifactId}/view`,
      headers: bearer(kartik),
      payload: {}
    });
    expect(view.statusCode).toBe(200);
    expect(view.json().mimeType).toBe("image/png");
    const url = new URL(view.json().url as string);
    const blob = await harness.app.inject({ method: "GET", url: url.pathname + url.search });
    expect(blob.statusCode).toBe(200);
    expect(blob.rawPayload.equals(PNG_BYTES)).toBe(true);
    expect(blob.headers["cache-control"]).toContain("no-store");

    // A viewer participant may view: reads are mission.view.
    const viewer = await joinMission(room, "viewer");
    const viewerView = await harness.app.inject({
      method: "POST",
      url: `/artifacts/${artifactId}/view`,
      headers: bearer(viewer),
      payload: {}
    });
    expect(viewerView.statusCode).toBe(200);

    // A person without mission access is told nothing exists — the id is not
    // a capability, exactly as a mission id is not.
    const stranger = await harness.signIn(`stranger-${randomUUID().slice(0, 8)}`);
    const unseen = await harness.app.inject({
      method: "POST",
      url: `/artifacts/${artifactId}/view`,
      headers: bearer(stranger),
      payload: {}
    });
    expect(unseen.statusCode).toBe(404);

    // An expired grant serves nothing: the signature is bound to its expiry.
    const expired = new URL(view.json().url as string);
    expired.searchParams.set("exp", String(Date.now() - 1000));
    const stale = await harness.app.inject({
      method: "GET",
      url: expired.pathname + expired.search
    });
    expect(stale.statusCode).toBe(403);
  }, 30_000);

  it("refuses to view what is not evidence yet", async () => {
    const room = await lane();
    const begun = await begin(room);
    const pendingView = await harness.app.inject({
      method: "POST",
      url: `/artifacts/${begun.json().artifact.artifactId}/view`,
      headers: bearer(kartik),
      payload: {}
    });
    expect(pendingView.statusCode).toBe(409);
    expect(pendingView.json().error.message).toContain("pending");
  }, 30_000);
});

describe("attachments (D-122)", () => {
  /** A named check on the lane, reported by its runner, returning chk_id. */
  async function reportCheck(room: Lane): Promise<string> {
    const reported = await harness.app.inject({
      method: "POST",
      url: "/runner/events",
      headers: runnerAuth(room.credential),
      payload: {
        executionId: null,
        events: [
          {
            originSeq: (originSeq += 1),
            event: {
              kind: "verification.completed",
              payload: {
                name: "tests",
                category: "test",
                outcome: "passed",
                origin: "participant",
                command: "pnpm test",
                exitCode: 0,
                ending: "exit",
                output: "1 passed",
                truncated: false,
                startedAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
                durationMs: 900,
                checkpointSha: room.checkpointSha
              }
            }
          }
        ]
      }
    });
    expect(reported.statusCode).toBe(200);
    const check = await harness.db.query(
      "select chk_id from verification_checks where mission_id = $1 order by observed_at desc limit 1",
      [room.missionId]
    );
    return check.rows[0].chk_id as string;
  }

  it("attaches beside a check, serves the relationship both ways, and detaches — with the artifact unchanged", async () => {
    const room = await lane();
    const artifactId = await captured(room);
    const checkId = await reportCheck(room);

    const attached = await harness.app.inject({
      method: "POST",
      url: `/artifacts/${artifactId}/attach`,
      headers: bearer(kartik),
      payload: { target: { kind: "check", id: checkId } }
    });
    expect(attached.statusCode).toBe(200);

    let detail = await detailOf(room);
    const check = detail.checks.find((row: { checkId: string }) => row.checkId === checkId);
    expect(check.artifactIds).toContain(artifactId);
    // Attaching is supporting evidence, never a verdict: the outcome is
    // exactly what the runner reported.
    expect(check.outcome).toBe("passed");
    const artifact = detail.artifacts.find(
      (row: { artifactId: string }) => row.artifactId === artifactId
    );
    expect(artifact.attachments).toEqual([
      { kind: "check", id: checkId, label: 'check "tests"' }
    ]);
    expect(artifact.sha256).toBe(sha256Of(PNG_BYTES));
    expect(
      detail.events.some((event: { kind: string }) => event.kind === "artifact.attached")
    ).toBe(true);

    // Attaching what is attached changes nothing and records nothing.
    await harness.app.inject({
      method: "POST",
      url: `/artifacts/${artifactId}/attach`,
      headers: bearer(kartik),
      payload: { target: { kind: "check", id: checkId } }
    });
    detail = await detailOf(room);
    expect(
      detail.events.filter((event: { kind: string }) => event.kind === "artifact.attached")
    ).toHaveLength(1);

    const detached = await harness.app.inject({
      method: "POST",
      url: `/artifacts/${artifactId}/detach`,
      headers: bearer(kartik),
      payload: { target: { kind: "check", id: checkId } }
    });
    expect(detached.statusCode).toBe(200);
    detail = await detailOf(room);
    expect(
      detail.checks.find((row: { checkId: string }) => row.checkId === checkId).artifactIds
    ).toEqual([]);
    expect(
      detail.events.some((event: { kind: string }) => event.kind === "artifact.detached")
    ).toBe(true);
  }, 30_000);

  it("refuses attachment without the capability, to another mission's check, and of anything that is not evidence", async () => {
    const room = await lane();
    const artifactId = await captured(room);
    const checkId = await reportCheck(room);

    const contributor = await joinMission(room, "contributor");
    const refused = await harness.app.inject({
      method: "POST",
      url: `/artifacts/${artifactId}/attach`,
      headers: bearer(contributor),
      payload: { target: { kind: "check", id: checkId } }
    });
    expect(refused.statusCode).toBe(403);

    // Cross-mission: a check from another mission is answered as not found.
    const foreign = await lane();
    const foreignCheck = await reportCheck(foreign);
    const crossed = await harness.app.inject({
      method: "POST",
      url: `/artifacts/${artifactId}/attach`,
      headers: bearer(kartik),
      payload: { target: { kind: "check", id: foreignCheck } }
    });
    expect(crossed.statusCode).toBe(404);

    // Pending is not evidence.
    const begun = await begin(room);
    const early = await harness.app.inject({
      method: "POST",
      url: `/artifacts/${begun.json().artifact.artifactId}/attach`,
      headers: bearer(kartik),
      payload: { target: { kind: "check", id: checkId } }
    });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe("not_evidence");
  }, 30_000);

  it("attaches to the tracked pull request and preserves the exact ids on the record", async () => {
    const room = await lane("github");
    const artifactId = await captured(room);
    const decided = await harness.app.inject({
      method: "POST",
      url: `/missions/${room.missionId}/decision`,
      headers: bearer(kartik),
      payload: {
        workstreamId: room.workstreamId,
        rationale: "The preview shows it working.",
        artifactIds: [artifactId]
      }
    });
    expect(decided.statusCode).toBe(201);
    // The remote-head guarantee first (D-099): the host serves the decided
    // revision, reported by the runner.
    await harness.app.inject({
      method: "POST",
      url: "/runner/events",
      headers: runnerAuth(room.credential),
      payload: {
        executionId: null,
        events: [
          {
            originSeq: (originSeq += 1),
            event: {
              kind: "workspace.pushed",
              payload: { branch: room.missionBranch, sha: room.checkpointSha }
            }
          }
        ]
      }
    });
    const pull = await harness.app.inject({
      method: "POST",
      url: `/missions/${room.missionId}/pull-request`,
      headers: bearer(kartik),
      payload: { workstreamId: room.workstreamId }
    });
    expect(pull.statusCode).toBe(201);
    const pullRequestId = pull.json().pullRequest.pullRequestId as string;

    const attached = await harness.app.inject({
      method: "POST",
      url: `/artifacts/${artifactId}/attach`,
      headers: bearer(kartik),
      payload: { target: { kind: "pull_request", id: pullRequestId } }
    });
    expect(attached.statusCode).toBe(200);

    const detail = await detailOf(room);
    expect(detail.pullRequest.artifactIds).toContain(artifactId);
    const artifact = detail.artifacts.find(
      (row: { artifactId: string }) => row.artifactId === artifactId
    );
    const kinds = artifact.attachments.map((ref: { kind: string }) => ref.kind).sort();
    expect(kinds).toEqual(["decision", "pull_request"]);
  }, 30_000);
});

describe("decisions and receipts (D-122)", () => {
  it("freezes the chosen artifact ids on the decision and refuses citing what is not evidence", async () => {
    const room = await lane();
    const artifactId = await captured(room);
    const begun = await begin(room);
    const pendingId = begun.json().artifact.artifactId as string;

    const refused = await harness.app.inject({
      method: "POST",
      url: `/missions/${room.missionId}/decision`,
      headers: bearer(kartik),
      payload: {
        workstreamId: room.workstreamId,
        rationale: "It works.",
        artifactIds: [pendingId]
      }
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.message).toContain("pending");

    const unknown = await harness.app.inject({
      method: "POST",
      url: `/missions/${room.missionId}/decision`,
      headers: bearer(kartik),
      payload: {
        workstreamId: room.workstreamId,
        rationale: "It works.",
        artifactIds: ["art_00000000000000000000"]
      }
    });
    expect(unknown.statusCode).toBe(422);

    const decided = await harness.app.inject({
      method: "POST",
      url: `/missions/${room.missionId}/decision`,
      headers: bearer(kartik),
      payload: {
        workstreamId: room.workstreamId,
        rationale: "The screenshot shows the page serving.",
        artifactIds: [artifactId]
      }
    });
    expect(decided.statusCode).toBe(201);
    const detail = await detailOf(room);
    expect(detail.decisions.at(-1).artifactIds).toEqual([artifactId]);
  }, 30_000);

  it("snapshots the evidence set into the receipt at close and reconstructs it on reopening", async () => {
    const room = await lane();
    const artifactId = await captured(room);
    // A pending upload at close never enters the receipt.
    await begin(room);
    const decided = await harness.app.inject({
      method: "POST",
      url: `/missions/${room.missionId}/decision`,
      headers: bearer(kartik),
      payload: {
        workstreamId: room.workstreamId,
        rationale: "The screenshot is the proof I trust.",
        artifactIds: [artifactId]
      }
    });
    expect(decided.statusCode).toBe(201);
    const closed = await harness.app.inject({
      method: "POST",
      url: `/missions/${room.missionId}/close`,
      headers: bearer(kartik),
      payload: { outcome: "completed" }
    });
    expect(closed.statusCode).toBe(200);

    const detail = await detailOf(room);
    expect(detail.receipt).not.toBeNull();
    expect(detail.receipt.artifacts).toHaveLength(1);
    expect(detail.receipt.artifacts[0].artifactId).toBe(artifactId);
    expect(detail.receipt.artifacts[0].sha256).toBe(sha256Of(PNG_BYTES));
    expect(detail.receipt.artifacts[0].attachedTo).toEqual(["the decision"]);
    expect(detail.receipt.decisions[0].artifactIds).toEqual([artifactId]);

    // Reopening reconstructs the same frozen set, and viewing the referenced
    // artifact mints a fresh grant — nothing durable was stored.
    const reopened = await detailOf(room);
    expect(reopened.receipt.artifacts).toEqual(detail.receipt.artifacts);
    const view = await harness.app.inject({
      method: "POST",
      url: `/artifacts/${artifactId}/view`,
      headers: bearer(kartik),
      payload: {}
    });
    expect(view.statusCode).toBe(200);

    // A closed mission accepts no new capture and no attachment change.
    const late = await begin(room);
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe("mission_closed");
  }, 30_000);
});

describe("the agent-requested path (D-123)", () => {
  it("begins under the runner credential for its own live execution, attributed to the agent's conversation", async () => {
    const room = await lane();
    // A live turn to request from: start a second direction so the execution
    // is non-terminal at begin.
    const submitted = await harness.app.inject({
      method: "POST",
      url: `/missions/${room.missionId}/direction`,
      headers: bearer(kartik),
      payload: { body: "Capture what you see", model: "claude-fable-5", effort: "high", workstreamId: room.workstreamId }
    });
    expect(submitted.statusCode).toBe(200);
    const execution = await harness.db.query(
      "select exe_id, session_id from executions where wst_id = $1 order by created_at desc limit 1",
      [room.workstreamId]
    );
    const executionId = execution.rows[0].exe_id as string;

    const begun = await harness.app.inject({
      method: "POST",
      url: "/runner/artifacts",
      headers: runnerAuth(room.credential),
      payload: {
        executionId,
        kind: "screenshot",
        mimeType: "image/png",
        byteSize: PNG_BYTES.length,
        sha256: sha256Of(PNG_BYTES),
        capturedAt: new Date().toISOString(),
        provenance: {
          processId: "prc_previewproc",
          processName: "web",
          origin: "http://127.0.0.1:4471",
          readiness: "ready",
          revisionSha: room.checkpointSha,
          revisionDirty: false
        }
      }
    });
    expect(begun.statusCode).toBe(201);
    const artifact = begun.json().artifact;
    expect(artifact.initiator).toBe("agent");
    expect(artifact.createdByLogin).toBeNull();
    expect(artifact.executionId).toBe(executionId);
    // The conversation is the execution's own, derived server-side.
    expect(artifact.sessionId).toBe(execution.rows[0].session_id);

    await putGrant(begun.json().upload, PNG_BYTES);
    const done = await harness.app.inject({
      method: "POST",
      url: `/runner/artifacts/${artifact.artifactId}/complete`,
      headers: runnerAuth(room.credential),
      payload: { outcome: "uploaded" }
    });
    expect(done.statusCode).toBe(200);
    expect(done.json().artifact.state).toBe("available");

    const detail = await detailOf(room);
    const event = detail.events.find(
      (row: { kind: string; payload: { artifactId?: string } }) =>
        row.kind === "artifact.captured" && row.payload.artifactId === artifact.artifactId
    );
    expect(event.actor.kind).toBe("harness");
  }, 30_000);

  it("refuses a foreign execution, an ended one, and a runner completing what it did not begin", async () => {
    const room = await lane();
    const foreign = await lane();
    const crossed = await harness.app.inject({
      method: "POST",
      url: "/runner/artifacts",
      headers: runnerAuth(room.credential),
      payload: {
        executionId: foreign.executionId,
        kind: "screenshot",
        mimeType: "image/png",
        byteSize: PNG_BYTES.length,
        sha256: sha256Of(PNG_BYTES),
        capturedAt: new Date().toISOString(),
        provenance: {
          processId: "prc_previewproc",
          processName: "web",
          origin: "http://127.0.0.1:4471",
          readiness: "ready",
          revisionSha: null,
          revisionDirty: false
        }
      }
    });
    expect(crossed.statusCode).toBe(404);

    // The lane's own first execution completed in the fixture: an ended turn
    // cannot begin a capture.
    const ended = await harness.app.inject({
      method: "POST",
      url: "/runner/artifacts",
      headers: runnerAuth(room.credential),
      payload: {
        executionId: room.executionId,
        kind: "screenshot",
        mimeType: "image/png",
        byteSize: PNG_BYTES.length,
        sha256: sha256Of(PNG_BYTES),
        capturedAt: new Date().toISOString(),
        provenance: {
          processId: "prc_previewproc",
          processName: "web",
          origin: "http://127.0.0.1:4471",
          readiness: "ready",
          revisionSha: null,
          revisionDirty: false
        }
      }
    });
    expect(ended.statusCode).toBe(409);
    expect(ended.json().error.code).toBe("execution_ended");

    // A person's artifact is not the runner's to complete.
    const personArtifact = await captured(room);
    const denied = await harness.app.inject({
      method: "POST",
      url: `/runner/artifacts/${personArtifact}/complete`,
      headers: runnerAuth(room.credential),
      payload: { outcome: "uploaded" }
    });
    expect(denied.statusCode).toBe(404);
  }, 30_000);
});

describe("an unconfigured store (D-122)", () => {
  it("answers with a named error instead of pretending storage exists", async () => {
    const previous = process.env.NOVUS_ARTIFACT_STORE;
    process.env.NOVUS_ARTIFACT_STORE = "";
    const bare = await createHarness("novus_test_artifacts_unconfigured", new FakeRepositoryProvider());
    // Assigning `undefined` to a process env var sets the *string*
    // "undefined", which is neither "local" nor "s3" — so every harness built
    // after this one in the same process silently had no artifact store. It
    // went unnoticed while this file owned the only store-dependent suite;
    // the D-150 suite is the second, and it failed on a 503 whose cause was
    // here. Unset means unset.
    if (previous === undefined) delete process.env.NOVUS_ARTIFACT_STORE;
    else process.env.NOVUS_ARTIFACT_STORE = previous;
    try {
      const person = await bare.signIn("kartik");
      const localId = randomUUID();
      await bare.app.inject({
        method: "POST",
        url: "/repositories/local",
        headers: bearer(person),
        payload: { localId, name: "novus/local", defaultBranch: "main", headSha: sha1(localId) }
      });
      const created = await bare.app.inject({
        method: "POST",
        url: "/missions",
        headers: bearer(person),
        payload: {
          goal: "No store configured",
          successCriteria: "The refusal is named",
          provider: "local",
          providerRepoId: localId,
          baseRef: "main",
          baseSha: sha1(localId),
          creationKey: randomUUID()
        }
      });
      const missionId = created.json().mission.missionId as string;
      const workstreamId = created.json().workstream.workstreamId as string;
      await bare.app.inject({
        method: "POST",
        url: `/workstreams/${workstreamId}/runner`,
        headers: bearer(person),
        payload: { workstreamId, label: "kartik-macbook" }
      });
      const refused = await bare.app.inject({
        method: "POST",
        url: `/missions/${missionId}/artifacts`,
        headers: bearer(person),
        payload: beginPayload({ missionId, workstreamId } as Lane, {
          provenance: {
            processId: "prc_previewproc",
            processName: "web",
            origin: "http://127.0.0.1:4471",
            readiness: "ready",
            revisionSha: null,
            revisionDirty: false
          }
        })
      });
      expect(refused.statusCode).toBe(503);
      expect(refused.json().error.code).toBe("artifact_store_unconfigured");
    } finally {
      await bare.close();
    }
  }, 30_000);
});
