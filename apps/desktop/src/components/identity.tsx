import { useEffect, useState } from "react";
import { siClaudecode } from "simple-icons";
import type { Participant } from "@novus/contracts";
import { novus } from "../bridge";
import { initials } from "../format";

/**
 * Identity marks (DESIGN.md#identity-marks): humans are circles, harnesses are
 * rounded squares. The distinction is the whole point — at a glance, you can
 * tell a person from a machine without reading a word.
 */

/**
 * A person's own GitHub picture, keyed by the login they signed in with
 * (D-105). The main process fetches it and answers with a `data:` URI; this
 * side remembers what came back so a hundred marks ask once. Null — no
 * picture, no network — leaves the initials exactly as they were.
 */
const faces = new Map<string, string | null>();
const asked = new Map<string, Promise<string | null>>();

/**
 * The signed-in person's own picture, handed over with the auth status the
 * main process resolved before it announced sign-in — so their mark is right
 * on the first frame instead of turning from initials into a face a beat
 * later (D-105).
 */
export function seedFace(login: string, face: string | null): void {
  const key = login.toLowerCase();
  if (face === null && faces.get(key)) return;
  faces.set(key, face);
}

function useFace(login: string): string | null {
  const key = login.toLowerCase();
  const [face, setFace] = useState<string | null>(() => faces.get(key) ?? null);
  useEffect(() => {
    if (faces.has(key)) {
      setFace(faces.get(key) ?? null);
      return;
    }
    let live = true;
    let pending = asked.get(key);
    if (!pending) {
      pending = novus()
        .people.avatar(login)
        .then((result) => (result.ok ? result.value : null))
        .catch(() => null)
        .then((value) => {
          faces.set(key, value);
          asked.delete(key);
          return value;
        });
      asked.set(key, pending);
    }
    void pending.then((value) => {
      if (live) setFace(value);
    });
    return () => {
      live = false;
    };
  }, [key, login]);
  return face;
}

/** Leaving the account, from the rail's foot (D-105). */
export function SignOutGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6.25 2.75H3.75A1.5 1.5 0 0 0 2.25 4.25v7.5a1.5 1.5 0 0 0 1.5 1.5h2.5" />
      <path d="M10.5 5.25 13.25 8l-2.75 2.75M13.25 8H6.5" />
    </svg>
  );
}

/** An image, in the same stroke set as the rest of the glyphs (D-150): a
 *  frame with a horizon and a sun, which reads as a picture at 14px where a
 *  photograph outline does not. */
export function ImageGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" width="14" height="14" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true">
      <rect x="2.25" y="3.25" width="11.5" height="9.5" rx="1.5" />
      <path d="M2.5 10.5 5.75 7.5l2.5 2.25 2-1.75 3.25 2.75" />
      <circle cx="6" cy="6" r="1" />
    </svg>
  );
}

/** A document, in the same stroke set (D-151): a page with a folded corner
 *  and two lines of text — what a PDF looks like at 14px. */
export function DocumentGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" width="14" height="14" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true">
      <path d="M9.25 1.75H4.5A1.25 1.25 0 0 0 3.25 3v10A1.25 1.25 0 0 0 4.5 14.25h7A1.25 1.25 0 0 0 12.75 13V5.25z" />
      <path d="M9.25 1.75v3.5h3.5" />
      <path d="M5.75 9.25h4.5M5.75 11.25h3" />
    </svg>
  );
}

/**
 * A file's kind as the mark a person already knows (D-165 amended, the Codex
 * shape the owner pointed at): a filled page with a folded corner in the
 * kind's terminal-palette tint — the same fact-about-the-file family the
 * tree's extension badges established — with the kind's own three letters on
 * it. PDFs are red everywhere a person has ever seen one.
 */
export function FileBadge({ mime, size = 20 }: { mime: string; size?: number }) {
  const kind = mime.toLowerCase().split(";")[0]?.trim() ?? "";
  const tint =
    kind === "application/pdf"
      ? "var(--term-red)"
      : kind.startsWith("video/")
        ? "var(--term-magenta)"
        : kind.startsWith("audio/")
          ? "var(--term-cyan)"
          : kind.startsWith("image/")
            ? "var(--term-green)"
            : "var(--text-3)";
  const named: Record<string, string> = {
    "application/pdf": "PDF",
    "audio/mpeg": "MP3",
    "audio/mp4": "M4A",
    "video/quicktime": "MOV",
    "video/x-matroska": "MKV",
    "video/x-msvideo": "AVI"
  };
  const word = named[kind] ?? (kind.split("/")[1] ?? "").replace(/^x-/, "").slice(0, 3).toUpperCase();
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} aria-hidden="true">
      <path
        d="M6 2h6.6L17 6.4V16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z"
        fill={tint}
      />
      <path
        d="M12.6 2 17 6.4h-3.6a0.9 0.9 0 0 1-0.9-0.9Z"
        fill="color-mix(in srgb, var(--term-bg) 32%, transparent)"
      />
      <text
        x="10.5"
        y="14.6"
        textAnchor="middle"
        fontSize="5.4"
        fontWeight="700"
        fontFamily="var(--font-ui)"
        fill="var(--term-bg)"
      >
        {word}
      </text>
    </svg>
  );
}

export function GearGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" width="14" height="14" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true">
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 1.9v1.6M8 12.5v1.6M1.9 8h1.6M12.5 8h1.6M3.7 3.7l1.1 1.1M11.2 11.2l1.1 1.1M12.3 3.7l-1.1 1.1M4.8 11.2l-1.1 1.1" />
      <circle cx="8" cy="8" r="4.6" />
    </svg>
  );
}

export function ClaudeGlyph({ className = "harness-glyph" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" role="img" aria-label="Claude Code">
      <path d={siClaudecode.path} />
    </svg>
  );
}

export function HumanMark({
  login,
  name,
  large
}: {
  login: string;
  name?: string | null;
  large?: boolean;
}) {
  const face = useFace(login);
  return (
    <span
      className={large ? "mark mark-human mark-lg" : "mark mark-human"}
      title={name ?? login}
      aria-hidden="true"
      data-testid="human-mark"
    >
      {face ? <img className="mark-face" src={face} alt="" draggable={false} /> : initials(name ?? login)}
    </span>
  );
}

export function HarnessMark({ large }: { large?: boolean }) {
  return (
    <span
      className={large ? "mark mark-harness mark-lg" : "mark mark-harness"}
      title="Claude Code"
      data-testid="harness-mark"
    >
      <ClaudeGlyph />
    </span>
  );
}


export function roleLabel(role: Participant["role"]): string {
  switch (role) {
    case "mission_admin":
      return "Mission Admin";
    case "operator":
      return "Operator";
    case "contributor":
      return "Contributor";
    case "viewer":
      return "Viewer";
  }
}
