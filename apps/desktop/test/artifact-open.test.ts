import { describe, expect, it } from "vitest";
import { openRefusalFor, openableExtensionOf } from "../electron/artifact-open";

/**
 * The allowlist is the boundary (D-165): only viewer-handled media and
 * documents are ever written to disk and handed to the OS. The refusals are
 * the test — an extension the OS might execute or interpret must never map.
 */
describe("openableExtensionOf", () => {
  it("maps the viewer kinds, parameters and case ignored", () => {
    expect(openableExtensionOf("application/pdf")).toBe("pdf");
    expect(openableExtensionOf("video/mp4")).toBe("mp4");
    expect(openableExtensionOf("audio/mpeg")).toBe("mp3");
    expect(openableExtensionOf("IMAGE/PNG")).toBe("png");
    expect(openableExtensionOf("image/jpeg; charset=binary")).toBe("jpg");
  });

  it("refuses everything that is not a viewer's file, in words", () => {
    for (const mime of [
      "application/octet-stream",
      "application/x-sh",
      "text/html",
      "application/javascript",
      "application/x-apple-diskimage",
      "text/plain",
      ""
    ]) {
      expect(openableExtensionOf(mime)).toBeNull();
    }
    expect(openRefusalFor("application/x-sh")).toContain("does not hand");
    expect(openRefusalFor("")).toContain("this kind of file");
  });
});
