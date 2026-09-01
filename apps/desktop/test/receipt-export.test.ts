import { describe, expect, it } from "vitest";
import { ReceiptSnapshotSchema, type ReceiptSnapshot } from "@novus/contracts";
import { renderReceipt, renderReceiptJson } from "../src/components/receipt-export";

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
  pullRequest: {
    number: 12,
    state: "merged",
    url: "https://github.com/novus/demo-app/pull/12",
    mergedBy: "maya",
    mergedAt: "2026-08-25T18:20:00.000Z"
  },
  eventRange: { fromSeq: 1, toSeq: 240 },
  sessions: [
    { workstreamName: "Current work", title: "write the guard", harness: "claude-code", createdByLogin: "kartik", directions: 3 },
    { workstreamName: "Current work", title: "review it", harness: "codex", createdByLogin: "maya", directions: 1 }
  ],
  directions: [
    {
      authorLogin: "kartik",
      body: "Refuse expired sessions with a named reason.",
      workstreamName: "Current work",
      sessionTitle: "write the guard",
      state: "applied",
      submittedAt: "2026-08-25T17:00:00.000Z",
      appliedAt: "2026-08-25T17:00:05.000Z"
    }
  ],
  approvals: [
    {
      toolName: "Write",
      displayName: "Write a file",
      summary: "src/auth/guard.ts",
      state: "approved",
      respondedByLogin: "kartik",
      respondedAt: "2026-08-25T17:01:00.000Z",
      requestedAt: "2026-08-25T17:00:50.000Z"
    },
    {
      toolName: "Bash",
      displayName: "Run a command",
      summary: "rm -rf dist",
      state: "denied",
      respondedByLogin: "accept_edits",
      respondedAt: "2026-08-25T17:02:00.000Z",
      requestedAt: "2026-08-25T17:01:50.000Z"
    }
  ],
  files: [
    { path: "src/auth/guard.ts", state: "modified", additions: 100, deletions: 30 },
    { path: "src/auth/guard.test.ts", state: "added", additions: 20, deletions: 10 }
  ]
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
    expect(doc).toContain("Pull request #12 · merged · merged by maya 2026-08-25T18:20:00.000Z · https://github.com/novus/demo-app/pull/12");
    expect(doc).toContain("events 1–240");
    // The D-234 sections: chats, directions verbatim, approvals with their
    // answerer (a person or the policy), and the files themselves.
    expect(doc).toContain("## Chats");
    expect(doc).toContain("- write the guard — Current work · claude-code · 3 directions · started by kartik");
    expect(doc).toContain("- review it — Current work · codex · 1 direction · started by maya");
    expect(doc).toContain("## Directions");
    expect(doc).toContain("- **kartik** · 2026-08-25T17:00:00.000Z · in \"write the guard\" · applied");
    expect(doc).toContain("  > Refuse expired sessions with a named reason.");
    expect(doc).toContain("## Approvals");
    expect(doc).toContain("- Write a file — approved by kartik · 2026-08-25T17:01:00.000Z · src/auth/guard.ts");
    expect(doc).toContain("- Run a command — denied by accept_edits");
    expect(doc).toContain("- src/auth/guard.ts — modified +100 −30");
  });

  it("exports the snapshot itself as JSON, deterministically and losslessly (D-234)", () => {
    const first = renderReceiptJson(snapshot, "msn_x");
    expect(first).toBe(renderReceiptJson(snapshot, "msn_x"));
    const parsed = JSON.parse(first) as { missionId: string; receipt: unknown };
    expect(parsed.missionId).toBe("msn_x");
    expect(ReceiptSnapshotSchema.parse(parsed.receipt)).toEqual(snapshot);
  });

  it("reads a snapshot from before D-234 without the new sections, and renders none of them", () => {
    const before = ReceiptSnapshotSchema.parse({
      ...snapshot,
      pullRequest: { number: 12, state: "merged" },
      sessions: undefined,
      directions: undefined,
      approvals: undefined,
      files: undefined
    });
    const doc = renderReceipt(before, "msn_x");
    expect(doc).not.toContain("## Chats");
    expect(doc).not.toContain("## Directions");
    expect(doc).not.toContain("## Approvals");
    expect(doc).toContain("Pull request #12 · merged\n");
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
