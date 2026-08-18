import { describe, expect, it } from "vitest";
import { IpcDirectInputSchema, MAX_DIRECTION_ATTACHMENTS } from "@novus/contracts";
import { sniffImageMime } from "../electron/attachment-upload.ts";

/**
 * Preparing an image a person attached (D-150).
 *
 * The sniffing half is what these cover, and it is the half that carries a
 * refusal: a file's *name* is a person's guess and its bytes are the truth, so
 * a `.png` that is really a zip is refused as what it is. The resize half runs
 * on Chromium's own decoder inside the Electron main process and is exercised
 * where that exists — here there is no `nativeImage` to be honest about.
 */

const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const jpeg = Buffer.from("ffd8ffe000104a46494600010100", "hex");
const gif = Buffer.from("474946383961" + "0100010080", "hex");
const webp = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from("24000000", "hex"),
  Buffer.from("WEBPVP8 ", "ascii")
]);

describe("what a file's own bytes say it is", () => {
  it("recognizes each format Novus will attach", () => {
    expect(sniffImageMime(png)).toBe("image/png");
    expect(sniffImageMime(jpeg)).toBe("image/jpeg");
    expect(sniffImageMime(gif)).toBe("image/gif");
    expect(sniffImageMime(webp)).toBe("image/webp");
  });

  it("refuses a file whose name lies about it", () => {
    // A zip called screenshot.png. The extension says image; the bytes do not.
    const zip = Buffer.from("504b03041400000008", "hex");
    expect(sniffImageMime(zip)).toBeNull();
  });

  it("refuses text, an empty file, and a truncated header", () => {
    expect(sniffImageMime(Buffer.from("just some words", "utf8"))).toBeNull();
    expect(sniffImageMime(Buffer.alloc(0))).toBeNull();
    // The first three bytes of a PNG signature and nothing more: not enough to
    // be one, and a length check is the only thing standing between this and a
    // read past the end.
    expect(sniffImageMime(Buffer.from("895047", "hex"))).toBeNull();
  });

  it("does not mistake a RIFF container that is not WebP", () => {
    const wav = Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      Buffer.from("24000000", "hex"),
      Buffer.from("WAVEfmt ", "ascii")
    ]);
    expect(sniffImageMime(wav)).toBeNull();
  });
});

/**
 * The bridge is a validation boundary, and a field it does not name is a field
 * it silently drops.
 *
 * This is the D-051 lesson costing a live run: the control-plane suite proved
 * the route carried images because it called the route, and every layer above
 * it typechecked — but `IpcDirectInputSchema` did not list `attachmentIds`, so
 * zod stripped it between the renderer and the main process. The whole path
 * was green and the harness answered "I don't see any image attached." A test
 * that calls a route directly does not prove the product calls it.
 */
describe("what the direction bridge carries", () => {
  it("keeps the attached image ids rather than stripping them", () => {
    const parsed = IpcDirectInputSchema.parse({
      missionId: "msn_abc",
      body: "Look at this",
      attachmentIds: ["art_one", "art_two"]
    });
    expect(parsed.attachmentIds).toEqual(["art_one", "art_two"]);
  });

  it("defaults to none, so every direction that carries nothing is unchanged", () => {
    const parsed = IpcDirectInputSchema.parse({ missionId: "msn_abc", body: "Just words" });
    expect(parsed.attachmentIds).toEqual([]);
  });

  it("refuses more images than a direction may carry, and ids of the wrong kind", () => {
    expect(() =>
      IpcDirectInputSchema.parse({
        missionId: "msn_abc",
        body: "Look",
        attachmentIds: Array.from({ length: MAX_DIRECTION_ATTACHMENTS + 1 }, (_, i) => `art_${i}`)
      })
    ).toThrow();
    expect(() =>
      IpcDirectInputSchema.parse({
        missionId: "msn_abc",
        body: "Look",
        attachmentIds: ["msn_not_an_artifact"]
      })
    ).toThrow();
  });
});
