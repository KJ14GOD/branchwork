import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TerminalKind, TerminalSession } from "@novus/contracts";
import { novus } from "../bridge";

/**
 * The terminal (DESIGN.md#component-behavior). A bottom dock in the room,
 * closed by default, sharing the room's width and never replacing the trace;
 * below the single-column threshold it becomes a dedicated full-room view.
 *
 * It is available only on the machine hosting the workspace, and the room says
 * why in words rather than hiding the control: controlling the mission is not
 * unrestricted access to the host machine (D-042). The restriction is real
 * rather than presentational — the runner protocol carries no shell verb at
 * all, so there is nothing here a remote participant could reach even if this
 * component rendered the button enabled.
 *
 * Deliberately not a terminal emulator. Output is plain monospace text in a
 * bounded scroll region with escape sequences stripped: enough to read what a
 * command said, and one dependency the product does not need yet.
 */

/** What the room says when the workspace is somewhere else. One sentence,
 *  stated rather than implied (D-042). */
export const TERMINAL_ELSEWHERE =
  "A terminal opens only on the machine hosting this workspace — controlling the mission is not unrestricted access to the host machine.";

/** What the renderer keeps per session. The main process bounds its own
 *  scrollback; this is the same bound on the display side. */
const MAX_BUFFER = 200 * 1024;

const MIN_HEIGHT_VH = 20;
const MAX_HEIGHT_VH = 60;
const DEFAULT_HEIGHT_VH = 32;

// --- The toggle ----------------------------------------------------------------

function TerminalGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
      <path d="M4.75 6.5L6.75 8.5l-2 2M8.75 10.75h2.5" />
    </svg>
  );
}

/**
 * One control in the room's workspace controls, beside `Run ▾` and the evidence
 * toggle — never a second navigation. When the repository is not on this
 * machine it stays visible and disabled, carrying the reason in words.
 */
export function TerminalToggle({
  open,
  onToggle,
  availableHere,
  disabled
}: {
  open: boolean;
  onToggle: () => void;
  /** False when this workstream's repository is not checked out here. */
  availableHere: boolean;
  /** True before a workstream exists at all — a draft tab has no workspace. */
  disabled?: boolean;
}) {
  const reason = availableHere ? undefined : TERMINAL_ELSEWHERE;
  const label = open ? "Hide the terminal" : "Show the terminal";
  return (
    <button
      className={open ? "icon-button active" : "icon-button"}
      onClick={onToggle}
      aria-pressed={open}
      aria-label={reason ? `${label} — ${reason}` : label}
      title={reason ?? label}
      disabled={disabled === true || !availableHere}
      data-testid="terminal-toggle"
      data-available={availableHere ? "true" : "false"}
    >
      <TerminalGlyph />
    </button>
  );
}

// --- Output ---------------------------------------------------------------------

// Escape sequences are removed rather than interpreted. CSI covers colour and
// cursor movement, OSC covers the title strings a shell sets, and the short
// form covers the remaining two-character escapes.
const CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const OSC = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g;
const SHORT_ESCAPE = /\u001b[@-Z\\-_]/g;
const BACKSPACE = /[^\n\b]\b/g;
/** Whatever is left that a text node cannot honestly show. */
const OTHER_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/**
 * Raw PTY bytes rendered as plain text. A carriage return overwrites its line
 * the way a terminal would, so a progress line replaces itself instead of
 * stacking; a backspace erases the character before it; anything still not
 * printable is dropped, because a control character in a text node is a
 * rendering trick rather than output.
 */
export function renderTerminalText(raw: string): string {
  const stripped = raw.replace(OSC, "").replace(CSI, "").replace(SHORT_ESCAPE, "");
  return stripped
    .split("\n")
    .map((line) => {
      const overwritten = line
        .split("\r")
        // Each segment starts again at column zero and overwrites what is
        // already there; whatever it does not cover stays visible.
        .reduce((current, segment) => segment + current.slice(segment.length), "");
      let erased = overwritten;
      let previous = "";
      while (erased !== previous) {
        previous = erased;
        erased = erased.replace(BACKSPACE, "");
      }
      return erased.replace(OTHER_CONTROL, "");
    })
    .join("\n");
}

/** The bytes a key press sends. Enough for a real shell: control characters,
 *  the arrows, and the editing keys a person actually uses. */
export function keyToBytes(event: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}): string | null {
  // The Command key belongs to the application, never to the shell.
  if (event.metaKey) return null;
  if (event.ctrlKey && event.key.length === 1) {
    const upper = event.key.toUpperCase();
    const code = upper.charCodeAt(0);
    if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
    if (upper === "?") return "\u007f";
    if (upper === " ") return "\u0000";
    return null;
  }
  switch (event.key) {
    case "Enter":
      return "\r";
    case "Backspace":
      return "\u007f";
    case "Tab":
      return "\t";
    case "Escape":
      return "\u001b";
    case "ArrowUp":
      return "\u001b[A";
    case "ArrowDown":
      return "\u001b[B";
    case "ArrowRight":
      return "\u001b[C";
    case "ArrowLeft":
      return "\u001b[D";
    case "Home":
      return "\u001b[H";
    case "End":
      return "\u001b[F";
    case "Delete":
      return "\u001b[3~";
    case "PageUp":
      return "\u001b[5~";
    case "PageDown":
      return "\u001b[6~";
    default:
      break;
  }
  if (event.key.length === 1) return event.altKey ? `\u001b${event.key}` : event.key;
  return null;
}

function stateOf(session: TerminalSession): { tone: string; label: string } {
  if (session.state === "running") return { tone: "active", label: "running" };
  if (session.exitCode === null || session.exitCode === 0) return { tone: "neutral", label: "stopped" };
  return { tone: "danger", label: `failed ${session.exitCode}` };
}

// --- The dock ---------------------------------------------------------------------

export function TerminalDrawer({
  missionId,
  onHide
}: {
  missionId: string;
  onHide: () => void;
}) {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [buffers, setBuffers] = useState<Record<string, string>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [heightVh, setHeightVh] = useState(DEFAULT_HEIGHT_VH);

  const screenRef = useRef<HTMLDivElement>(null);
  const metricRef = useRef<HTMLSpanElement>(null);
  const pinnedRef = useRef(true);
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeId;

  // What already happened arrives with the session list, because the dock is
  // unmounted while it is closed and a session keeps running regardless.
  useEffect(() => {
    let live = true;
    void (async () => {
      const result = await novus().terminal.list(missionId);
      if (!live) return;
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setSessions(result.value);
      setBuffers(Object.fromEntries(result.value.map((session) => [session.sessionId, session.scrollback])));
      setActiveId((current) => current ?? result.value[result.value.length - 1]?.sessionId ?? null);
    })();
    return () => {
      live = false;
    };
  }, [missionId]);

  // Output is streamed from this machine's own main process and rendered here.
  // It goes nowhere else: it is never an event and never evidence (D-041).
  useEffect(() => {
    return novus().terminal.onOutput((chunk) => {
      setBuffers((previous) => {
        const grown = (previous[chunk.sessionId] ?? "") + chunk.data;
        return {
          ...previous,
          [chunk.sessionId]: grown.length > MAX_BUFFER ? grown.slice(grown.length - MAX_BUFFER) : grown
        };
      });
      if (chunk.state === "exited") {
        setSessions((previous) =>
          previous.map((session) =>
            session.sessionId === chunk.sessionId
              ? { ...session, state: "exited", exitCode: chunk.exitCode }
              : session
          )
        );
      }
    });
  }, []);

  const active = sessions.find((session) => session.sessionId === activeId) ?? null;
  const text = useMemo(
    () => (activeId === null ? "" : renderTerminalText(buffers[activeId] ?? "")),
    [activeId, buffers]
  );

  // Stay at the bottom on new output unless the reader scrolled up, the same
  // rule the trace above keeps.
  useEffect(() => {
    const element = screenRef.current;
    if (element && pinnedRef.current) element.scrollTop = element.scrollHeight;
  }, [text]);

  /** The PTY is told the size the reader can actually see, measured from one
   *  monospace character rather than guessed. */
  const measure = useCallback(() => {
    const screen = screenRef.current;
    const metric = metricRef.current;
    const sessionId = activeRef.current;
    if (!screen || !metric || sessionId === null) return;
    const box = metric.getBoundingClientRect();
    const charWidth = box.width / 10;
    const lineHeight = box.height;
    if (charWidth <= 0 || lineHeight <= 0) return;
    const cols = Math.max(2, Math.floor(screen.clientWidth / charWidth));
    const rows = Math.max(1, Math.floor(screen.clientHeight / lineHeight));
    void novus().terminal.resize({ sessionId, cols, rows });
  }, []);

  useEffect(() => {
    measure();
    const element = screenRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure, activeId, heightVh]);

  const create = async (kind: TerminalKind) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await novus().terminal.open({ missionId, kind });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setSessions((previous) => [...previous, result.value]);
    setBuffers((previous) => ({ ...previous, [result.value.sessionId]: result.value.scrollback }));
    setActiveId(result.value.sessionId);
    pinnedRef.current = true;
  };

  const end = async (sessionId: string) => {
    setError(null);
    const result = await novus().terminal.close(sessionId);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setSessions((previous) => previous.filter((session) => session.sessionId !== sessionId));
    setBuffers((previous) => {
      const next = { ...previous };
      delete next[sessionId];
      return next;
    });
    setActiveId((current) => (current === sessionId ? null : current));
  };

  const rename = async (sessionId: string, name: string) => {
    setRenaming(null);
    const trimmed = name.trim();
    if (trimmed === "") return;
    const result = await novus().terminal.rename({ sessionId, name: trimmed });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setSessions((previous) =>
      previous.map((session) => (session.sessionId === sessionId ? { ...session, name: trimmed } : session))
    );
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (activeId === null || active?.state !== "running") return;
    const bytes = keyToBytes(event);
    if (bytes === null) return;
    event.preventDefault();
    pinnedRef.current = true;
    void novus().terminal.write({ sessionId: activeId, data: bytes });
  };

  const onPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    if (activeId === null || active?.state !== "running") return;
    const pasted = event.clipboardData.getData("text");
    if (pasted === "") return;
    event.preventDefault();
    void novus().terminal.write({ sessionId: activeId, data: pasted });
  };

  const onScroll = () => {
    const element = screenRef.current;
    if (!element) return;
    pinnedRef.current = element.scrollTop + element.clientHeight >= element.scrollHeight - 24;
  };

  /** Dragging the top edge. The height stays a proportion of the viewport, the
   *  same measure the composer's own ceiling uses, so no new value is minted. */
  const onGrab = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = heightVh;
    const viewport = window.innerHeight || 1;
    const move = (moveEvent: PointerEvent) => {
      const deltaVh = ((startY - moveEvent.clientY) / viewport) * 100;
      setHeightVh(Math.min(MAX_HEIGHT_VH, Math.max(MIN_HEIGHT_VH, startHeight + deltaVh)));
    };
    const release = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", release);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", release);
  };

  return (
    <section
      className="terminal-dock"
      style={{ height: `${heightVh}vh` }}
      aria-label="Terminal"
      data-testid="terminal-dock"
    >
      <div
        className="terminal-grip"
        onPointerDown={onGrab}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the terminal"
        data-testid="terminal-grip"
      />

      <div className="terminal-head">
        <div className="terminal-tabs" role="tablist" aria-label="Terminal sessions">
          {sessions.map((session) => {
            const tone = stateOf(session);
            const selected = session.sessionId === activeId;
            return renaming === session.sessionId ? (
              <input
                key={session.sessionId}
                className="input terminal-rename"
                defaultValue={session.name}
                autoFocus
                aria-label={`Rename ${session.name}`}
                onBlur={(event) => void rename(session.sessionId, event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void rename(session.sessionId, event.currentTarget.value);
                  else if (event.key === "Escape") setRenaming(null);
                }}
                data-testid="terminal-rename"
              />
            ) : (
              <button
                key={session.sessionId}
                role="tab"
                aria-selected={selected}
                className={selected ? "terminal-tab active" : "terminal-tab"}
                onClick={() => setActiveId(session.sessionId)}
                onDoubleClick={() => setRenaming(session.sessionId)}
                title={`${session.name} — ${session.kind}, ${tone.label}`}
                data-testid="terminal-tab"
                data-kind={session.kind}
              >
                <span className={`status-dot ${tone.tone}`} />
                <span className="terminal-tab-name">{session.name}</span>
                <span className="terminal-tab-kind">{session.kind}</span>
                <span className="terminal-tab-state">{tone.label}</span>
              </button>
            );
          })}
          <button
            className="btn btn-text terminal-new"
            onClick={() => void create("shell")}
            disabled={busy}
            data-testid="terminal-new"
          >
            + New terminal
          </button>
        </div>

        <span className="terminal-head-spacer" />

        {active && (
          <>
            <button
              className="btn btn-text"
              onClick={() => setRenaming(active.sessionId)}
              data-testid="terminal-rename-action"
            >
              Rename
            </button>
            <button
              className="btn btn-text"
              onClick={() => void end(active.sessionId)}
              data-testid="terminal-end"
            >
              End session
            </button>
          </>
        )}
        <button className="btn btn-text" onClick={onHide} data-testid="terminal-hide">
          Hide
        </button>
      </div>

      {error && (
        <p className="inline-error terminal-error" role="alert" data-testid="terminal-error">
          {error}
        </p>
      )}

      {/* One character, measured rather than assumed, so the PTY is told the
          size the reader can actually see. */}
      <span className="terminal-metric mono" ref={metricRef} aria-hidden="true">
        MMMMMMMMMM
      </span>

      {active === null ? (
        <div className="terminal-empty" data-testid="terminal-empty">
          <p>No terminal open — a session lives only as long as this Novus window does.</p>
          <button
            className="btn btn-secondary"
            onClick={() => void create("shell")}
            disabled={busy}
            data-testid="terminal-empty-new"
          >
            New terminal
          </button>
        </div>
      ) : (
        <div
          className="terminal-screen"
          ref={screenRef}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onScroll={onScroll}
          role="group"
          aria-label={`${active.name} — ${stateOf(active).label}`}
          data-testid="terminal-screen"
        >
          <pre className="terminal-text mono">{text}</pre>
          {active.state === "exited" && (
            <p className="terminal-ended" data-testid="terminal-ended">
              This session ended{active.exitCode === null ? "" : ` with code ${active.exitCode}`}. Start a
              new one to keep working.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
