import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { nativeImage } from "electron";
import {
  ATTACHMENT_MIME_TYPES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_EDGE,
  type AttachmentMime
} from "@novus/contracts";

/**
 * Preparing and uploading an image a person attached to a direction (D-150).
 *
 * Two jobs, and the first is the one that matters. **Normalize before the
 * upload, never after.** A phone screenshot is twelve megapixels of a thing a
 * person wanted to point at; sending it whole costs the store, the wire, and —
 * the expensive one — the harness's own context on every turn that re-reads
 * the conversation. Scaling it to a readable size first is what makes an
 * attachment cheap enough to be ordinary. The approach is borrowed from
 * opencode, which resizes and caps images before handing them to a model; the
 * bound and the refusal wording are ours.
 *
 * The second job is the D-122 lifecycle, unchanged: promise the digest, PUT
 * exactly those bytes, and let the store's own verification be what moves the
 * row to available.
 */

/** What a file's own bytes say it is, rather than what its name claims. An
 *  extension is a person's guess; these are the formats' own signatures. */
export function sniffImageMime(bytes: Buffer): AttachmentMime | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6 && bytes.subarray(0, 6).toString("ascii").startsWith("GIF8")) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export interface PreparedAttachment {
  bytes: Buffer;
  mimeType: AttachmentMime;
  filename: string;
  /** True when the image was scaled down to fit the bound, so the interface
   *  can say so rather than silently sending something else. */
  resized: boolean;
}

export class AttachmentRefused extends Error {}

/**
 * Reads one file and makes it something the room and the harness can both
 * take. Refuses in words rather than sending bytes nothing downstream reads.
 *
 * The resize path deliberately re-encodes as PNG: `nativeImage` is Chromium's
 * own decoder, already in this process, and it gives back raw pixels — so the
 * output format is ours to choose and PNG is the one every consumer here
 * already handles. An animated GIF is left alone rather than being flattened
 * to its first frame, because a silently still animation is a worse answer
 * than a large one; if it does not fit the bound it is refused by size.
 */
export async function prepareAttachment(path: string): Promise<PreparedAttachment> {
  const raw = await readFile(path);
  const sniffed = sniffImageMime(raw);
  if (sniffed === null) {
    throw new AttachmentRefused(
      `That file is not an image Novus can attach. Attach a ${ATTACHMENT_MIME_TYPES.map((mime) => mime.replace("image/", "")).join(", ")}.`
    );
  }
  const filename = basename(path).slice(0, 120) || "image";

  const image = nativeImage.createFromBuffer(raw);
  const size = image.isEmpty() ? null : image.getSize();
  const longestEdge = size ? Math.max(size.width, size.height) : 0;
  const fitsEdge = longestEdge <= MAX_ATTACHMENT_EDGE;
  const fitsBytes = raw.byteLength <= MAX_ATTACHMENT_BYTES;

  // Animated GIFs and anything Chromium could not decode pass through as they
  // are; there is nothing honest to resize.
  if (sniffed === "image/gif" || size === null) {
    if (!fitsBytes) {
      throw new AttachmentRefused(
        `That image is ${Math.round(raw.byteLength / 1_000_000)} MB, and an attachment may be at most ${MAX_ATTACHMENT_BYTES / 1_000_000} MB.`
      );
    }
    return { bytes: raw, mimeType: sniffed, filename, resized: false };
  }

  if (fitsEdge && fitsBytes) {
    return { bytes: raw, mimeType: sniffed, filename, resized: false };
  }

  const scale = fitsEdge ? 1 : MAX_ATTACHMENT_EDGE / longestEdge;
  const resized = image.resize({
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
    quality: "good"
  });
  const bytes = resized.toPNG();
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentRefused(
      `That image is still ${Math.round(bytes.byteLength / 1_000_000)} MB after resizing, and an attachment may be at most ${MAX_ATTACHMENT_BYTES / 1_000_000} MB.`
    );
  }
  return { bytes, mimeType: "image/png", filename, resized: true };
}

export const sha256Of = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");
