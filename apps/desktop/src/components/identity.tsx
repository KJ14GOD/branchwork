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
