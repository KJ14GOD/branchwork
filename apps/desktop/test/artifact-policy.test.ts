import { describe, expect, it } from "vitest";
import type { PreviewStatus, ProcessLog } from "@novus/contracts";
import {
  SECRET_SCAN_MIN_LENGTH,
  artifactLabel,
  captureProvenance,
  captureRefusal,
  secretOnPage,
  secretOnPageRefusal
} from "../electron/artifact-policy";

/**
 * The capture policy (D-123), in plain Node: the only pixels Novus may
 * photograph are the named lane's live preview showing a page right now, and
 * every other request is a refusal in words. Stale, foreign, loading, and
 * dead previews are the cases that matter — a stale preview presented as
 * evidence would be the product lying about the one thing it exists to say.
 */

const status = (overrides: Partial<PreviewStatus> = {}): PreviewStatus => ({
  workstreamId: "wst_lane",
  url: "http://127.0.0.1:4600/",
  origin: "http://127.0.0.1:4600",
  processId: "prc_live",
  processName: "app",
  phase: "ready",
  detail: null,
  ...overrides
});

const liveLog = (overrides: Partial<ProcessLog> = {}): ProcessLog => ({
  processId: "prc_live",
  workstreamId: "wst_lane",
  kind: "run",
  name: "app",
  command: "node server.mjs",
  state: "running",
  readiness: "ready",
  exitCode: null,
  ending: null,
  failureReason: null,
  previewUrl: "http://127.0.0.1:4600/",
  startedAt: new Date().toISOString(),
  endedAt: null,
  output: "",
  truncated: false,
  ...overrides
});

describe("capture policy (D-123)", () => {
  it("allows exactly the named lane's live preview showing a page", () => {
    expect(captureRefusal(status(), "wst_lane", [liveLog()])).toBeNull();
  });

  it("refuses when no preview is open, in words", () => {
    expect(captureRefusal(null, "wst_lane", [liveLog()])).toContain("No preview is open");
  });

  it("refuses another lane's preview — a capture never crosses lanes", () => {
    expect(captureRefusal(status(), "wst_other", [liveLog()])).toContain("another lane");
  });

  it("refuses a page that is not on screen yet, and every dead phase by name", () => {
    expect(captureRefusal(status({ phase: "loading" }), "wst_lane", [liveLog()])).toContain(
      "no page on screen"
    );
    expect(captureRefusal(status({ phase: "unreachable" }), "wst_lane", [liveLog()])).toContain(
      "did not answer"
    );
    expect(captureRefusal(status({ phase: "crashed" }), "wst_lane", [liveLog()])).toContain(
      "crashed"
    );
    expect(captureRefusal(status({ phase: "stopped" }), "wst_lane", [liveLog()])).toContain(
      "stale preview is not evidence"
    );
  });

  it("refuses a preview whose reporting process has ended — stale is stale even before the surface notices", () => {
    const ended = liveLog({ state: "exited", ending: "exit", exitCode: 0 });
    expect(captureRefusal(status(), "wst_lane", [ended])).toContain("has ended");
    // A different live process on the lane does not vouch for this one.
    const other = liveLog({ processId: "prc_other" });
    expect(captureRefusal(status(), "wst_lane", [other])).toContain("has ended");
  });

  it("binds provenance to the reporting process's own declared readiness", () => {
    const pending = liveLog({ readiness: "pending" });
    expect(captureProvenance(status(), [pending])).toEqual({
      processId: "prc_live",
      processName: "app",
      origin: "http://127.0.0.1:4600",
      readiness: "pending"
    });
  });

  it("generates a concise label that is never a filename", () => {
    expect(artifactLabel("screenshot", "web")).toBe("Screenshot · web");
    expect(artifactLabel("recording", "app")).toBe("Recording · app");
  });
});

/**
 * A page showing a known secret is not photographed (D-238). The scan is
 * exact and case-sensitive over what the page shows, names the variable and
 * never the value, and ignores values too short to be anything but prose.
 */
describe("a known secret on the page (D-238)", () => {
  const secrets = [
    { name: "STRIPE_KEY", value: "novus-fixture-SecretValue-Only" },
    { name: "SHORT", value: "abc" }
  ];

  it("names the secret the page shows, and never its value", () => {
    const hit = secretOnPage("Settings\nAPI key: novus-fixture-SecretValue-Only\nSave", secrets);
    expect(hit).toBe("STRIPE_KEY");
    const refusal = secretOnPageRefusal(hit!);
    expect(refusal).toContain("STRIPE_KEY");
    expect(refusal).not.toContain("novus-fixture");
  });

  it("is exact: a different case or a fragment is not the secret", () => {
    expect(secretOnPage("NOVUS-FIXTURE-SECRETVALUE-ONLY", secrets)).toBeNull();
    expect(secretOnPage("novus-fixture-Secret", secrets)).toBeNull();
  });

  it("ignores a value too short to be anything but prose, and an empty page", () => {
    expect(SECRET_SCAN_MIN_LENGTH).toBe(8);
    expect(secretOnPage("abc is in this sentence", secrets)).toBeNull();
    expect(secretOnPage("", secrets)).toBeNull();
    expect(secretOnPage("anything", [])).toBeNull();
  });
});
