import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { nativeImage } from "electron";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_EDGE,
  MAX_DOCUMENT_BYTES,
  attachmentForm,
  type AttachmentMime
} from "@novus/contracts";

/**
 * Preparing a file a person attached to a direction (D-150, widened by D-151).
 *
 * The rule this module exists to enforce: **nothing reaches the harness that
 * the harness was not observed to read.** Every type below was probed against
 * the real CLI, because the failure mode of guessing is not an error — a HEIC
 * passed straight through comes back as a confident, wrong answer about a
 * picture the model could not decode. A refusal is honest; that is not.
 *
 * So there are three outcomes and no fourth:
 *
 *  - **Carried** — PNG, JPEG, GIF, WebP (as images) and PDF (as a document).
 *  - **Converted** — HEIC/HEIF, TIFF, BMP and anything else `sips` can decode
 *    become PNG first, and the interface says the file was converted.
 *  - **Refused, by name** — everything else.
 *
 * Images are also normalized before upload: a phone screenshot is twelve
 * megapixels of a thing somebody wanted to point at, and it re-enters the
 * harness's context on every turn that re-reads the conversation. A PDF is
 * never resized — there is no smaller-but-still-readable version of a
 * contract — so it is carried whole or refused by size.
 */

/** What the bytes themselves say, rather than what the filename claims. */
export type SniffedType =
  | { kind: "carry"; mime: AttachmentMime }
  | { kind: "convert"; label: string }
  | { kind: "refuse" };

const startsWith = (bytes: Buffer, hex: string): boolean =>
  bytes.length >= hex.length / 2 && bytes.subarray(0, hex.length / 2).equals(Buffer.from(hex, "hex"));

export function sniffAttachment(bytes: Buffer): SniffedType {
  if (startsWith(bytes, "89504e470d0a1a0a")) return { kind: "carry", mime: "image/png" };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { kind: "carry", mime: "image/jpeg" };
  }
  if (bytes.length >= 6 && bytes.subarray(0, 4).toString("ascii") === "GIF8") {
    return { kind: "carry", mime: "image/gif" };
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { kind: "carry", mime: "image/webp" };
  }
  if (startsWith(bytes, "255044462d")) return { kind: "carry", mime: "application/pdf" };

  // HEIC/HEIF: an ISO base media file whose brand box says so. The brand sits
  // at offset 8, after the box length and the `ftyp` tag.
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = bytes.subarray(8, 12).toString("ascii");
    if (["heic", "heix", "hevc", "heim", "heis", "hevm", "mif1", "msf1"].includes(brand)) {
      return { kind: "convert", label: "HEIC" };
    }
  }
  // TIFF, either byte order.
  if (startsWith(bytes, "49492a00") || startsWith(bytes, "4d4d002a")) {
    return { kind: "convert", label: "TIFF" };
  }
  if (bytes.length >= 2 && bytes.subarray(0, 2).toString("ascii") === "BM") {
    return { kind: "convert", label: "BMP" };
  }
  return { kind: "refuse" };
}

/** Kept for the older call sites and the tests that name it: the carried
 *  image types only, or null for everything else. */
export function sniffImageMime(bytes: Buffer): AttachmentMime | null {
  const sniffed = sniffAttachment(bytes);
  return sniffed.kind === "carry" && sniffed.mime !== "application/pdf" ? sniffed.mime : null;
}

export interface PreparedFile {
  bytes: Buffer;
  mimeType: AttachmentMime;
  filename: string;
  /** True when the image was scaled down to fit the bound. */
  resized: boolean;
  /** Set when the file was decoded from a format the harness cannot read —
   *  the interface says so rather than silently sending something else. */
  convertedFrom: string | null;
}

export class AttachmentRefused extends Error {}

const megabytes = (bytes: number): number => Math.max(1, Math.round(bytes / 1_000_000));

/**
 * Converts a format the harness cannot read into a PNG it can, using the
 * platform's own decoder.
 *
 * `sips` is macOS's, and it is the only one wired: Chromium — and therefore
 * `nativeImage` — does not decode HEIC or TIFF, so there is nothing in-process
 * to fall back to. On a platform without it the file is refused **by name**,
 * which is the honest answer until that platform is actually supported.
 */
async function convertToPng(path: string, label: string): Promise<Buffer> {
  if (process.platform !== "darwin") {
    throw new AttachmentRefused(
      `Novus cannot read ${label} on this platform. Export it as PNG or JPEG and attach that.`
    );
  }
  const workDir = await mkdtemp(join(tmpdir(), "novus-attach-"));
  const out = join(workDir, "converted.png");
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        "sips",
        ["-s", "format", "png", path, "--out", out],
        { timeout: 30_000 },
        (error) => (error ? reject(error) : resolve())
      );
    });
    return await readFile(out);
  } catch {
    throw new AttachmentRefused(
      `That ${label} file could not be converted. Export it as PNG or JPEG and attach that.`
    );
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Scales an image down to the bound, re-encoding as PNG. Returns null when
 *  the image already fits and needs no work. */
function shrink(bytes: Buffer): Buffer | null {
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) return null;
  const size = image.getSize();
  const longest = Math.max(size.width, size.height);
  if (longest <= MAX_ATTACHMENT_EDGE && bytes.byteLength <= MAX_ATTACHMENT_BYTES) return null;
  const scale = longest <= MAX_ATTACHMENT_EDGE ? 1 : MAX_ATTACHMENT_EDGE / longest;
  return image
    .resize({
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
      quality: "good"
    })
    .toPNG();
}

export async function prepareAttachment(path: string): Promise<PreparedFile> {
  const raw = await readFile(path);
  const filename = basename(path).slice(0, 120) || "attachment";
  const sniffed = sniffAttachment(raw);

  if (sniffed.kind === "refuse") {
    throw new AttachmentRefused(
      "Novus can attach images (PNG, JPEG, GIF, WebP, HEIC, TIFF, BMP) and PDFs. That file is none of them."
    );
  }

  // A document is carried whole or not at all: there is no smaller version of
  // a PDF that is still the same PDF.
  if (sniffed.kind === "carry" && sniffed.mime === "application/pdf") {
    if (raw.byteLength > MAX_DOCUMENT_BYTES) {
      throw new AttachmentRefused(
        `That PDF is ${megabytes(raw.byteLength)} MB, and an attached document may be at most ${MAX_DOCUMENT_BYTES / 1_000_000} MB.`
      );
    }
    return { bytes: raw, mimeType: "application/pdf", filename, resized: false, convertedFrom: null };
  }

  // Everything else is an image, either already readable or decoded into one.
  const convertedFrom = sniffed.kind === "convert" ? sniffed.label : null;
  const decoded = sniffed.kind === "convert" ? await convertToPng(path, sniffed.label) : raw;
  const mime: AttachmentMime = sniffed.kind === "convert" ? "image/png" : sniffed.mime;

  // An animated GIF is left whole rather than flattened to its first frame: a
  // silently still animation is a worse answer than a large one.
  const shrunk = mime === "image/gif" ? null : shrink(decoded);
  const bytes = shrunk ?? decoded;
  const mimeType: AttachmentMime = shrunk ? "image/png" : mime;

  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentRefused(
      `That image is ${megabytes(bytes.byteLength)} MB after resizing, and an attached image may be at most ${MAX_ATTACHMENT_BYTES / 1_000_000} MB.`
    );
  }
  return { bytes, mimeType, filename, resized: shrunk !== null, convertedFrom };
}

/** Which content block this file becomes on the harness's stdin. */
export { attachmentForm };

export const sha256Of = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");
