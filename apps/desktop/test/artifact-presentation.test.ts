import { describe, expect, it } from "vitest";
import { ArtifactSchema, type Artifact } from "@novus/contracts";
import {
  artifactActorLine,
  artifactAttachmentsLine,
  artifactClaim,
  artifactIsEvidence,
  artifactMetaLine,
  artifactProvenanceRows,
  artifactProvenanceText,
  artifactStateWord
} from "../src/components/artifacts";

/**
 * The artifact's words (D-122), pinned pure. What matters most: an artifact
 * that is not evidence says exactly what it is; absence is stated rather
 * than dropped; and nothing anywhere claims a picture proves correctness —
 * the claim sentence says the opposite, on every artifact.
 */

const artifact = (overrides: Partial<Artifact> = {}): Artifact =>
  ArtifactSchema.parse({
    artifactId: "art_00000000000000000001",
    missionId: "msn_00000000000000000001",
    workstreamId: "wst_00000000000000000001",
    sessionId: null,
    executionId: null,
    kind: "screenshot",
    mimeType: "image/png",
    byteSize: 20_480,
    sha256: "a".repeat(64),
    state: "available",
    failureReason: null,
    interruptionReason: null,
    label: "Screenshot · web",
    capturedAt: "2026-08-14T10:30:00.000Z",
    createdAt: "2026-08-14T10:30:01.000Z",
    createdByLogin: "kartik",
    initiator: "person",
    captureSource: "preview",
    processId: "prc_live",
    processName: "web",
    origin: "http://127.0.0.1:4600",
    readiness: "ready",
    revisionSha: "b".repeat(40),
    revisionDirty: false,
    checkpointId: null,
    environment: "local runner (kartik-macbook)",
    durationMs: null,
    hasThumbnail: true,
    redaction: "metadata_only",
    attachments: [],
    ...overrides
  });

describe("artifact words (D-122)", () => {
  it("gives plain available evidence no badge, and every other state its word in its tone", () => {
    expect(artifactStateWord(artifact())).toBeNull();
    expect(artifactStateWord(artifact({ state: "pending" }))).toEqual({
      word: "uploading",
      tone: "quiet"
    });
    expect(artifactStateWord(artifact({ state: "interrupted" }))).toEqual({
      word: "interrupted",
      tone: "warn"
    });
    expect(artifactStateWord(artifact({ state: "failed" }))).toEqual({
      word: "failed",
      tone: "danger"
    });
  });

  it("counts available and interrupted as evidence, and nothing else", () => {
    expect(artifactIsEvidence(artifact())).toBe(true);
    expect(artifactIsEvidence(artifact({ state: "interrupted" }))).toBe(true);
    expect(artifactIsEvidence(artifact({ state: "pending" }))).toBe(false);
    expect(artifactIsEvidence(artifact({ state: "failed" }))).toBe(false);
  });

  it("states the revision honestly: short when known, dirty when dirty, unknown when unknown", () => {
    expect(artifactMetaLine(artifact())).toContain("bbbbbbbb");
    expect(artifactMetaLine(artifact({ revisionDirty: true }))).toContain("uncommitted changes");
    expect(artifactMetaLine(artifact({ revisionSha: null }))).toContain("revision unknown");
  });

  it("says who caused a capture without ambiguity", () => {
    expect(artifactActorLine(artifact())).toBe("Captured by kartik");
    expect(artifactActorLine(artifact({ initiator: "agent", createdByLogin: null }))).toBe(
      "Requested by the agent, approved in the room"
    );
  });

  it("prints the honest claim by kind, and never a claim of correctness", () => {
    expect(artifactClaim(artifact())).toContain("does not prove the application is correct");
    expect(artifactClaim(artifact({ kind: "recording", mimeType: "video/webm" }))).toContain(
      "does not prove the application is correct"
    );
    const text = artifactProvenanceText(artifact());
    expect(text).not.toMatch(/proves the application is correct/i);
  });

  it("keeps the provenance ledger honest about absence and about endings", () => {
    const unknownRevision = artifactProvenanceRows(artifact({ revisionSha: null }));
    expect(unknownRevision.find((row) => row.label === "Revision")?.value).toContain("unknown");
    const interrupted = artifactProvenanceRows(
      artifact({ state: "interrupted", interruptionReason: "The app exited mid-recording." })
    );
    expect(interrupted.find((row) => row.label === "Interrupted")?.value).toBe(
      "The app exited mid-recording."
    );
    const failed = artifactProvenanceRows(artifact({ state: "failed", failureReason: null }));
    expect(failed.find((row) => row.label === "Failed")?.value).toContain("did not complete");
    const digest = artifactProvenanceRows(artifact()).find((row) => row.label === "Digest");
    expect(digest?.value).toBe(`sha256 ${"a".repeat(64)}`);
  });

  it("says where the artifact is evidence, or that it is not yet", () => {
    expect(artifactAttachmentsLine(artifact())).toBe("Not attached to anything yet.");
    expect(
      artifactAttachmentsLine(
        artifact({
          attachments: [
            { kind: "check", id: "chk_1", label: 'check "tests"' },
            { kind: "decision", id: "dec_1", label: "the decision" }
          ]
        })
      )
    ).toBe('Evidence for check "tests", the decision.');
  });
});
