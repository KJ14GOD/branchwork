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
  const trigger = useRef<HTMLButtonElement | null>(null);

  // Asked once the menu is first wanted rather than at mount: it reads the
  // filesystem, and a room nobody opened this in should not pay for it.
  useEffect(() => {
    if (!open || targets.length > 0) return;
    void (async () => {
      const found = await novus().workspace.openTargets();
      if (found.ok) setTargets(found.value);
    })();
  }, [open, targets.length]);

  const choose = async (target: OpenTarget) => {
    if (missionId === null || workstreamId === null) return;
    setError(null);
    // The menu closes before the act, not after: launching another
    // application takes the operating system a visible beat, and a menu that
    // hangs open while Finder comes forward reads as the click not taking.
    // The rare failure — an application gone since detection — reopens the
    // menu with its reason, which is also the only place the reason renders.
    setOpen(false);
    // The person's attention just went to another application. When they come
    // back, this window regains focus and the browser re-decides that the
    // still-focused trigger was reached by keyboard — drawing a ring around a
    // button nobody navigated to. D-106 hit exactly this on a dialog's opener
    // and named it in the same words; the same suppression applies, and the
    // ring returns the moment the keyboard is genuinely used again.
    quietFocus(trigger.current);
    const result = await novus().workspace.openWorkspaceIn({ missionId, workstreamId, target });
    if (!result.ok) {
      setError(result.message);
      setOpen(true);
      return;
    }
    // Copying is silent otherwise: the one action with no visible effect
    // anywhere says so itself.
    if (target === "copy-path") {
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    }
  };

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        return;
      }
      // The numbers beside the rows are real (D-159 amended): while the menu
      // is open, its own digits choose. Scoped to the open menu and nothing
      // else — a number typed anywhere else in the room is a number, and a
      // global shortcut on a bare digit would take them all.
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const position = Number.parseInt(event.key, 10);
      if (!Number.isInteger(position) || position < 1 || position > targets.length) return;
      event.preventDefault();
      const target = targets[position - 1];
      if (target) void choose(target.id);
    };
    window.addEventListener("mousedown", dismiss);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", dismiss);
      window.removeEventListener("keydown", key);
    };
  });


  const unavailable = disabled
    ? "Available once a mission is open"
    : !availableHere
      ? "This lane's workspace is on another machine, so there is nothing here to open"
      : null;

  return (
    <span className="chip-wrap" ref={wrap}>
      <button
        ref={trigger}
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
              {/* The application's own icon, read off this machine (D-159
                  amended): an app is recognized by its icon before its name is
                  read. An entry that has none — Copy path — keeps the space so
                  the labels stay on one axis. */}
              {target.icon ? (
                <img className="open-in-icon" src={target.icon} alt="" aria-hidden="true" />
              ) : (
                <span className="open-in-icon" aria-hidden="true" />
              )}
              <span>{target.label}</span>
              {/* The digit, and it works while this menu is open. */}
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

/**
 * Keeps the focus and suppresses the ring, until the keyboard is used again
 * (D-106's pattern, applied to a control that hands attention to another
 * application rather than to a dialog).
 */
function quietFocus(element: HTMLElement | null): void {
  if (!element) return;
  element.dataset.focusQuiet = "true";
  // Cleared on the next key press and **not** on blur, which is where this
  // differs from D-106's dialog. Leaving another application blurs the
  // element, so a blur listener would lift the suppression on the way out and
  // the ring would be waiting on the way back — the exact thing being
  // suppressed. A person who tabs here later clears it with the Tab itself,
  // which fires before focus lands.
  const speak = () => {
    delete element.dataset.focusQuiet;
    window.removeEventListener("keydown", speak, true);
  };
  window.addEventListener("keydown", speak, true);
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
