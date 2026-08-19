import { useEffect, useRef, useState } from "react";
import type { OpenTarget, OpenTargetOption } from "@novus/contracts";
import { novus } from "../bridge";

/**
 * Opening a lane's checkout where a person already works (D-159).
 *
 * The corner beside Run and the evidence toggle, and deliberately the same
 * shape as its neighbours: an icon button that opens one menu, never a second
 * navigation. What it lists is what **this machine actually has** — Finder and
 * Copy path always, an editor or a terminal only when it is installed — because
 * a menu of things that do nothing is worse than a short menu.
 *
 * It stays visible and disabled when the workspace is on somebody else's
 * machine, saying why: the house rule is disabled-with-reason, never hidden.
 */
export function OpenInControl({
  missionId,
  workstreamId,
  availableHere,
  disabled
}: {
  missionId: string | null;
  workstreamId: string | null;
  /** False when this lane's checkout lives on another person's machine. */
  availableHere: boolean;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState<OpenTargetOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const wrap = useRef<HTMLSpanElement | null>(null);

  // Asked once the menu is first wanted rather than at mount: it reads the
  // filesystem, and a room nobody opened this in should not pay for it.
  useEffect(() => {
    if (!open || targets.length > 0) return;
    void (async () => {
      const found = await novus().workspace.openTargets();
      if (found.ok) setTargets(found.value);
    })();
  }, [open, targets.length]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", dismiss);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("mousedown", dismiss);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);

  const choose = async (target: OpenTarget) => {
    if (missionId === null || workstreamId === null) return;
    setError(null);
    const result = await novus().workspace.openWorkspaceIn({ missionId, workstreamId, target });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setOpen(false);
    // Copying is silent otherwise: the one action with no visible effect
    // anywhere says so itself.
    if (target === "copy-path") {
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    }
  };

  const unavailable = disabled
    ? "Available once a mission is open"
    : !availableHere
      ? "This lane's workspace is on another machine, so there is nothing here to open"
      : null;

  return (
    <span className="chip-wrap" ref={wrap}>
      <button
        className={open ? "icon-button active" : "icon-button"}
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Open this workspace elsewhere"
        title={unavailable ?? "Open this workspace in another app"}
        disabled={unavailable !== null}
        data-testid="open-in"
      >
        <OpenInGlyph />
      </button>
      {open && (
        <div className="chip-menu open-in-menu" role="menu" data-testid="open-in-menu">
          {targets.map((target, index) => (
            <button
              key={target.id}
              role="menuitem"
              className="chip-menu-row"
              onClick={() => void choose(target.id)}
              data-testid={`open-in-${target.id}`}
            >
              <span>{target.label}</span>
              {/* The position, as a menu of a few things can honestly show —
                  not a keyboard shortcut, which would be a claim we do not
                  keep. */}
              <span className="chip-menu-index">{index + 1}</span>
            </button>
          ))}
          {targets.length === 0 && (
            <p className="chip-menu-note">Novus can only open a workspace on macOS so far.</p>
          )}
          {error && (
            <p className="inline-error chip-menu-note" role="alert" data-testid="open-in-error">
              {error}
            </p>
          )}
        </div>
      )}
      {copied && (
        <span className="open-in-copied" role="status" data-testid="open-in-copied">
          Path copied
        </span>
      )}
    </span>
  );
}

/** An arrow leaving a frame: the stroke set's way of saying "out of here". */
function OpenInGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13.25 9.5v3a1.25 1.25 0 0 1-1.25 1.25H3.5A1.25 1.25 0 0 1 2.25 12.5V4a1.25 1.25 0 0 1 1.25-1.25h3" />
      <path d="M9.75 2.25h4v4M13.25 2.75 7.5 8.5" />
    </svg>
  );
}
