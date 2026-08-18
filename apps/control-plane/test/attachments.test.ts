import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { bearer, createHarness, type Harness, type SignedIn } from "./harness.ts";

/**
 * Attaching an image to a direction (D-150).
 *
 * These are about the ways an attachment could become a lie. A direction that
 * claims an image nobody uploaded. An image borrowed from another mission. A
 * captured screenshot passed off as something a person handed over, or the
 * reverse. Bytes that never arrived, carried into a turn as though the harness
 * had seen them. And a Viewer — who may not direct — illustrating anyway.
 */

let harness: Harness;
let kartik: SignedIn;
let maya: SignedIn;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const sha1 = (value: string) => createHash("sha1").update(value).digest("hex");

interface Room {
  missionId: string;
  workstreamId: string;
}

beforeAll(async () => {
  harness = await createHarness("novus_test_attachments");
  kartik = await harness.signIn("kartik");
  maya = await harness.signIn("maya");
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

async function mission(): Promise<Room> {
  const localId = randomUUID();
  const headSha = sha1(localId);
  await harness.app.inject({
    method: "POST",
    url: "/repositories/local",
    headers: bearer(kartik),
    payload: { localId, name: "novus/local", defaultBranch: "main", headSha }
  });
  const created = await harness.app.inject({
    method: "POST",
    url: "/missions",
    headers: bearer(kartik),
    payload: {
      goal: "Look at this and tell me what is wrong",
      successCriteria: "The agent sees what the person saw",
      provider: "local",
      providerRepoId: localId,
      baseRef: "main",
      baseSha: headSha,
      creationKey: randomUUID()
    }
  });
  expect(created.statusCode).toBe(201);
  return {
    missionId: created.json().mission.missionId as string,
    workstreamId: created.json().workstream.workstreamId as string
  };
}

/** Begins an attachment and uploads its bytes through the granted URL, the
 *  way a real client does — the store verifies what actually arrives. */
async function attach(
  room: Room,
  as: SignedIn,
  bytes: Buffer,
  overrides: Record<string, unknown> = {}
): Promise<{ status: number; artifactId: string | null; body: Record<string, unknown> }> {
  const begun = await harness.app.inject({
    method: "POST",
    url: `/missions/${room.missionId}/attachments`,
    headers: bearer(as),
    payload: {
      workstreamId: room.workstreamId,
      mimeType: "image/png",
      byteSize: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      filename: "screenshot.png",
      ...overrides
    }
  });
  if (begun.statusCode !== 201) {
    return { status: begun.statusCode, artifactId: null, body: begun.json() };
  }
  const artifactId = begun.json().artifact.artifactId as string;
  const grant = begun.json().upload as { url: string; headers: Record<string, string> };
  const put = await harness.app.inject({
    method: "PUT",
    url: grant.url,
    headers: grant.headers,
    payload: bytes
  });
  expect(put.statusCode).toBeLessThan(300);
  const completed = await harness.app.inject({
    method: "POST",
    url: `/artifacts/${artifactId}/complete`,
    headers: bearer(as),
    payload: { outcome: "uploaded" }
  });
  expect(completed.statusCode).toBe(200);
  return { status: 201, artifactId, body: begun.json() };
}

async function direct(
  room: Room,
  as: SignedIn,
  body: string,
  attachmentIds: string[]
): Promise<{ statusCode: number; message: string }> {
  const response = await harness.app.inject({
    method: "POST",
    url: `/missions/${room.missionId}/direction`,
    headers: bearer(as),
    payload: { body, workstreamId: room.workstreamId, attachmentIds }
  });
  const parsed = response.statusCode >= 400 ? (response.json() as { error?: { message?: string } }) : null;
  return { statusCode: response.statusCode, message: parsed?.error?.message ?? "" };
}

describe("attaching an image to a direction", () => {
  it("uploads, verifies the bytes, and carries the image on the direction", async () => {
    const room = await mission();
    const bytes = Buffer.from("a-real-png-would-be-here", "utf8");
    const attached = await attach(room, kartik, bytes);
    expect(attached.status).toBe(201);

    const submitted = await direct(room, kartik, "What is wrong with this screen?", [
      attached.artifactId as string
    ]);
    expect(submitted.statusCode).toBe(200);

    const detail = await harness.app.inject({
      method: "GET",
      url: `/missions/${room.missionId}`,
      headers: bearer(kartik)
    });
    const directions = detail.json().directions as {
      body: string;
      attachments: { artifactId: string; label: string; state: string; mimeType: string }[];
    }[];
    const carrying = directions.find((row) => row.body === "What is wrong with this screen?");
    expect(carrying?.attachments).toHaveLength(1);
    expect(carrying?.attachments[0]?.artifactId).toBe(attached.artifactId);
    expect(carrying?.attachments[0]?.state).toBe("available");
    expect(carrying?.attachments[0]?.label).toBe("screenshot.png");
    expect(carrying?.attachments[0]?.mimeType).toBe("image/png");
  }, 30_000);

  it("records it as supplied, never as something Novus captured", async () => {
    const room = await mission();
    const attached = await attach(room, kartik, Buffer.from("supplied", "utf8"));
    const artifacts = (
      await harness.app.inject({
        method: "GET",
        url: `/missions/${room.missionId}`,
        headers: bearer(kartik)
      })
    ).json().artifacts as {
      artifactId: string;
      kind: string;
      captureSource: string;
      processId: string | null;
      origin: string | null;
    }[];
    const found = artifacts.find((row) => row.artifactId === attached.artifactId);
    expect(found?.kind).toBe("attachment");
    expect(found?.captureSource).toBe("upload");
    // The whole point: no invented producer.
    expect(found?.processId).toBeNull();
    expect(found?.origin).toBeNull();
  }, 30_000);

  it("refuses a direction claiming an image that never finished uploading", async () => {
    const room = await mission();
    const bytes = Buffer.from("never-arrives", "utf8");
    const begun = await harness.app.inject({
      method: "POST",
      url: `/missions/${room.missionId}/attachments`,
      headers: bearer(kartik),
      payload: {
        workstreamId: room.workstreamId,
        mimeType: "image/png",
        byteSize: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        filename: "pending.png"
      }
    });
    expect(begun.statusCode).toBe(201);
    const pendingId = begun.json().artifact.artifactId as string;

    const submitted = await direct(room, kartik, "Look at this", [pendingId]);
    expect(submitted.statusCode).toBe(422);
    expect(submitted.message).toContain("has not finished uploading");
  }, 30_000);

  it("refuses an image borrowed from another mission", async () => {
    const mine = await mission();
    const other = await mission();
    const elsewhere = await attach(other, kartik, Buffer.from("not-yours", "utf8"));

    const submitted = await direct(mine, kartik, "Look at this", [elsewhere.artifactId as string]);
    expect(submitted.statusCode).toBe(422);
    expect(submitted.message).toContain("not this mission's");
  }, 30_000);

  it("refuses the same image twice", async () => {
    const room = await mission();
    const attached = await attach(room, kartik, Buffer.from("once", "utf8"));
    const id = attached.artifactId as string;
    const submitted = await direct(room, kartik, "Look at this", [id, id]);
    expect(submitted.statusCode).toBe(422);
    expect(submitted.message).toContain("twice");
  }, 30_000);

  it("refuses someone who is not in the mission, without confirming it exists", async () => {
    const room = await mission();
    const begun = await harness.app.inject({
      method: "POST",
      url: `/missions/${room.missionId}/attachments`,
      headers: bearer(maya),
      payload: {
        workstreamId: room.workstreamId,
        mimeType: "image/png",
        byteSize: 10,
        sha256: sha("x"),
        filename: "intruder.png"
      }
    });
    expect(begun.statusCode).toBe(404);
  }, 30_000);

  it("refuses a MIME type nothing downstream can read", async () => {
    const room = await mission();
    const begun = await harness.app.inject({
      method: "POST",
      url: `/missions/${room.missionId}/attachments`,
      headers: bearer(kartik),
      payload: {
        workstreamId: room.workstreamId,
        mimeType: "application/zip",
        byteSize: 10,
        sha256: sha("x"),
        filename: "payload.zip"
      }
    });
    expect(begun.statusCode).toBe(422);
  }, 30_000);

  it("refuses bytes that do not match the promise, leaving nothing available", async () => {
    const room = await mission();
    const promised = Buffer.from("the-promise", "utf8");
    const begun = await harness.app.inject({
      method: "POST",
      url: `/missions/${room.missionId}/attachments`,
      headers: bearer(kartik),
      payload: {
        workstreamId: room.workstreamId,
        mimeType: "image/png",
        byteSize: promised.byteLength,
        sha256: createHash("sha256").update(promised).digest("hex"),
        filename: "swapped.png"
      }
    });
    expect(begun.statusCode).toBe(201);
    const artifactId = begun.json().artifact.artifactId as string;
    const grant = begun.json().upload as { url: string; headers: Record<string, string> };
    // Same length, different bytes: only the digest catches this.
    const swapped = Buffer.from("the-promisE", "utf8");
    expect(swapped.byteLength).toBe(promised.byteLength);
    const put = await harness.app.inject({
      method: "PUT",
      url: grant.url,
      headers: grant.headers,
      payload: swapped
    });
    expect(put.statusCode).toBeGreaterThanOrEqual(400);

    const submitted = await direct(room, kartik, "Look at this", [artifactId]);
    expect(submitted.statusCode).toBe(422);
  }, 30_000);
});
