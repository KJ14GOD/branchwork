import type { HarnessId } from "@novus/contracts";
import claudeIcon from "../assets/claude-icon.png";
import codexIcon from "../assets/codex-icon.png";

/**
 * Whose harness a chat is (D-232): the vendor's own mark, read off the
 * chat's latest turn, worn on its tab and its rail row. A chat that has not
 * run yet wears the caller's fallback — the generic chat glyph — because it
 * is nobody's until its first send picks a model.
 */
export function HarnessGlyph({
  harness,
  fallback
}: {
  harness: HarnessId | null;
  fallback: React.ReactNode;
}) {
  if (harness === null) return <>{fallback}</>;
  if (harness === "opencode") return <OpenCodeGlyph />;
  return (
    <img
      // The two bitmaps have opposite polarity: Codex's mark is dark and
      // inverts for dark theme; Claude's is light and inverts for light
      // theme (owner-hit: dark-on-dark in the rail, light-on-light in light).
      className={harness === "codex" ? "harness-glyph chip-glyph-bitmap" : "harness-glyph harness-glyph-light"}
      src={harness === "codex" ? codexIcon : claudeIcon}
      alt={harness === "codex" ? "Codex" : "Claude Code"}
      data-harness={harness}
    />
  );
}

/** A neutral terminal mark until a vendor asset is introduced (D-246). */
export function OpenCodeGlyph({ className = "harness-glyph" }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" role="img" aria-label="OpenCode" data-harness="opencode">
    <path d="M4 6h16v12H4zM7 10l2 2-2 2m5 0h4" />
  </svg>;
}
