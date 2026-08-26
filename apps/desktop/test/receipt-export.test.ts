import { describe, expect, it } from "vitest";
import { ReceiptSnapshotSchema, type ReceiptSnapshot } from "@novus/contracts";
import { renderReceipt } from "../src/components/receipt-export";

/**
 * The export projection (D-220) is deterministic and complete: same snapshot,
 * same document, and every section the receipt on screen shows appears in the
 * file — rationale verbatim, uncertainty never omitted, references never blobs.
 */

const snapshot: ReceiptSnapshot = ReceiptSnapshotSchema.parse({
  goal: "Harden the auth middleware",
  successCriteria: "Expired sessions are refused with a named reason.",
  outcome: "completed",
  closedByLogin: "kartik",
  closedAt: "2026-08-25T18:30:00.000Z",
  reason: null,
  participants: [
    { login: "kartik", role: "mission_admin" },
    { login: "maya", role: "contributor" }
  ],
  directionsApplied: 4,
  decisions: [
    {
      workstreamName: "Current work",
      checkpointSha: "abcdef0123456789",
      rationale: "The middleware version keeps the guard in one place.",
      acceptedRisks: "The legacy admin panel is untested.",
      decidedByLogin: "kartik",
      decidedAt: "2026-08-25T18:00:00.000Z",
      superseded: false,
      artifactIds: ["art_1"]
    }
  ],
  changes: { filesChanged: 3, additions: 120, deletions: 40 },
  checks: [
    {
      name: "pnpm test",
      outcome: "passed",
      origin: "declared",
      checkpointSha: "abcdef0123456789",
      currentAtClose: true
    },
    { name: "lint", outcome: "failed", origin: "declared", checkpointSha: null, currentAtClose: false }
  ],
  artifacts: [
    {
      artifactId: "art_1",
      kind: "screenshot",
      label: "Login refused",
      state: "available",
      sha256: "d".repeat(64),
      capturedAt: "2026-08-25T17:55:00.000Z",
      revisionSha: "abcdef0123456789",
      hasThumbnail: true,
      attachedTo: ["check: pnpm test"]
    }
  ],
  remainingUncertain: ["The legacy admin panel was never exercised."],
  pullRequest: { number: 12, state: "merged" },
  eventRange: { fromSeq: 1, toSeq: 240 }
});

describe("renderReceipt", () => {
  it("is deterministic: the same snapshot renders byte-identical documents", () => {
    expect(renderReceipt(snapshot, "msn_x")).toBe(renderReceipt(snapshot, "msn_x"));
  });

  it("carries every section of the receipt, verbatim where the record is words", () => {
    const doc = renderReceipt(snapshot, "msn_x");
    expect(doc).toContain("# Receipt · Harden the auth middleware");
    expect(doc).toContain("Completed by kartik · 2026-08-25T18:30:00.000Z");
    expect(doc).toContain("Expired sessions are refused with a named reason.");
    expect(doc).toContain("kartik — Mission Admin");
    expect(doc).toContain("Directions applied: 4");
    expect(doc).toContain("> The middleware version keeps the guard in one place.");
    expect(doc).toContain("Accepted risks: The legacy admin panel is untested.");
    expect(doc).toContain("3 files changed, +120 −40");
    expect(doc).toContain("- pnpm test — passed at abcdef01");
    expect(doc).toContain("- lint — failed (since superseded)");
    expect(doc).toContain(`sha256 ${"d".repeat(64)}`);
    expect(doc).toContain("- The legacy admin panel was never exercised.");
    expect(doc).toContain("Pull request #12 · merged");
    expect(doc).toContain("events 1–240");
  });

  it("says when nothing was uncertain rather than omitting the section", () => {
    const quiet = { ...snapshot, remainingUncertain: [], checks: [], artifacts: [], decisions: [] };
    const doc = renderReceipt(quiet, "msn_x");
    expect(doc).toContain("Nothing was recorded as uncertain.");
    expect(doc).toContain("No checks were observed.");
    // Absent evidence renders no heading over nothing.
    expect(doc).not.toContain("## Visual evidence");
    expect(doc).not.toContain("## Decisions");
  });

  it("quotes the cancellation reason in the person's own words", () => {
    const cancelled = {
      ...snapshot,
      outcome: "cancelled" as const,
      reason: "The endpoint shipped by hand instead."
    };
    const doc = renderReceipt(cancelled, "msn_x");
    expect(doc).toContain("Cancelled by kartik");
    expect(doc).toContain("> The endpoint shipped by hand instead.");
  });
});
