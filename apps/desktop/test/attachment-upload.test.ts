import { describe, expect, it } from "vitest";
import { IpcDirectInputSchema, MAX_DIRECTION_ATTACHMENTS } from "@novus/contracts";
import { sniffAttachment, sniffImageMime } from "../electron/attachment-upload.ts";

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

/**
 * What each format is routed to (D-151).
 *
 * Every verdict here was decided by probing the real CLI, not by reading a
 * spec. The one that matters most is HEIC: passed through it does **not**
 * error — one probe answered "Red green" about a red-on-blue picture, and
 * another refused. A format that makes the model confidently wrong is worse
 * than one that fails, so it converts or it does not go.
 */
describe("how a picked file is routed", () => {
  const heic = Buffer.concat([
    Buffer.from("00000018", "hex"),
    Buffer.from("ftypheic", "ascii"),
    Buffer.alloc(8)
  ]);
  const tiffLE = Buffer.concat([Buffer.from("49492a00", "hex"), Buffer.alloc(8)]);
  const tiffBE = Buffer.concat([Buffer.from("4d4d002a", "hex"), Buffer.alloc(8)]);
  const bmp = Buffer.concat([Buffer.from("BM", "ascii"), Buffer.alloc(12)]);
  const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n", "ascii"), Buffer.alloc(8)]);

  it("carries the four image types the harness reads", () => {
    expect(sniffAttachment(png)).toEqual({ kind: "carry", mime: "image/png" });
    expect(sniffAttachment(jpeg)).toEqual({ kind: "carry", mime: "image/jpeg" });
    expect(sniffAttachment(gif)).toEqual({ kind: "carry", mime: "image/gif" });
    expect(sniffAttachment(webp)).toEqual({ kind: "carry", mime: "image/webp" });
  });

  it("carries a PDF, which the harness reads as a document rather than sees", () => {
    expect(sniffAttachment(pdf)).toEqual({ kind: "carry", mime: "application/pdf" });
  });

  it("converts the formats the harness cannot read, rather than hoping", () => {
    expect(sniffAttachment(heic)).toEqual({ kind: "convert", label: "HEIC" });
    expect(sniffAttachment(tiffLE)).toEqual({ kind: "convert", label: "TIFF" });
    expect(sniffAttachment(tiffBE)).toEqual({ kind: "convert", label: "TIFF" });
    expect(sniffAttachment(bmp)).toEqual({ kind: "convert", label: "BMP" });
  });

  it("refuses everything else, including a video and a zip", () => {
    const zip = Buffer.from("504b03041400000008", "hex");
    const mp4 = Buffer.concat([
      Buffer.from("00000018", "hex"),
      Buffer.from("ftypmp42", "ascii"),
      Buffer.alloc(8)
    ]);
    expect(sniffAttachment(zip)).toEqual({ kind: "refuse" });
    // Same ISO container family as HEIC — the brand is what separates them,
    // so an mp4 must not sneak in through the HEIC branch.
    expect(sniffAttachment(mp4)).toEqual({ kind: "refuse" });
  });

  it("still reports only carried images through the narrower helper", () => {
    // A PDF is an attachment but never an image: the composer and the trace
    // both branch on this, and a PDF rendered into an <img> shows nothing.
    expect(sniffImageMime(pdf)).toBeNull();
    expect(sniffImageMime(heic)).toBeNull();
    expect(sniffImageMime(png)).toBe("image/png");
  });
});
