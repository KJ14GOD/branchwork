/**
 * Handing an artifact's bytes to the operating system (D-165).
 *
 * A person clicks their own uploaded or captured file and it opens in the
 * app their machine would open it with — the Claude-desktop pattern the
 * owner pointed at. The boundary is this allowlist: only media and documents
 * whose default handler is a *viewer* are ever written to disk and opened.
 * Nothing executable, nothing scriptable, nothing whose extension the OS
 * might hand to an interpreter — those are refused in words, not sniffed
 * around. `shell.openPath`, never `openExternal`; the file lands in the
 * app's own 0700 temp corner and is swept on quit.
 */

const OPENABLE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/tiff": "tiff",
  "image/bmp": "bmp",
  "application/pdf": "pdf",
  "video/webm": "webm",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/x-m4v": "m4v",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/ogg": "ogg"
};

/** The extension a fetched artifact is written under, or null when this kind
 *  of file is not handed to another application at all. */
export function openableExtensionOf(mimeType: string): string | null {
  return OPENABLE[mimeType.toLowerCase().split(";")[0]?.trim() ?? ""] ?? null;
}

/** The refusal, in words a row can show. */
export function openRefusalFor(mimeType: string): string {
  return `Novus does not hand ${mimeType || "this kind of file"} to another application.`;
}
