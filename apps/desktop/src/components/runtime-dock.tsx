import { useCallback, useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { ProcessKind, TerminalKind, TerminalSession } from "@novus/contracts";
import { novus } from "../bridge";
import { ProcessLogView } from "./process-log";

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
 * Rendering is `@xterm/xterm` rather than a parser of our own (D-046). The
 * custom renderer this replaces stripped escape sequences and printed the
 * remainder, which cannot show an alternate screen, cannot place a cursor,
 * cannot clear, and cannot colour — so `vim`, `less`, a pager, a progress bar,
 * and every coloured build log rendered as debris. A terminal that cannot run
 * the programs people run is not a terminal, and the honest way to have one is
 * to use an emulator somebody maintains.
 *
 * Output still stops here. It reaches this window from this machine's own main
 * process and goes nowhere else: never an event, never the control plane,
 * never evidence (D-041).
 */

/** What the room says when the workspace is somewhere else. One sentence,
 *  stated rather than implied (D-042). */
export const TERMINAL_ELSEWHERE =
  "A terminal opens only on the machine hosting this workspace — controlling the mission is not unrestricted access to the host machine.";

/** Lines kept per pane. Bounded and local, like the scrollback the main
 *  process keeps (DESIGN.md: scrollback is bounded and local). */
const SCROLLBACK_LINES = 5_000;

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

// --- Theme ----------------------------------------------------------------------

/**
 * One design token's resolved value, or undefined.
 *
 * Deliberately no fallback. A literal colour here would be exactly the local
 * design value AGENTS.md rule 14 forbids, and the gate greps for one — so a
 * token that is somehow absent yields nothing and the emulator keeps its own
 * default for that slot, which is a worse-looking terminal and not a wrong one.
 */
function token(name: string): string | undefined {
  if (typeof window === "undefined") return undefined;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === "" ? undefined : value;
}

/** The `ITheme` slot for each terminal token. Written as pairs so the mapping
 *  is one list to read rather than twenty near-identical lines. */
const THEME_TOKENS: [keyof ITheme, string][] = [
  ["background", "--term-bg"],
  ["foreground", "--term-fg"],
  ["cursor", "--term-cursor"],
  ["cursorAccent", "--term-cursor-text"],
  ["selectionBackground", "--term-selection"],
  ["black", "--term-black"],
  ["red", "--term-red"],
  ["green", "--term-green"],
  ["yellow", "--term-yellow"],
  ["blue", "--term-blue"],
  ["magenta", "--term-magenta"],
  ["cyan", "--term-cyan"],
  ["white", "--term-white"],
  ["brightBlack", "--term-bright-black"],
  ["brightRed", "--term-bright-red"],
  ["brightGreen", "--term-bright-green"],
  ["brightYellow", "--term-bright-yellow"],
  ["brightBlue", "--term-bright-blue"],
  ["brightMagenta", "--term-bright-magenta"],
  ["brightCyan", "--term-bright-cyan"],
  ["brightWhite", "--term-bright-white"]
];

/** The emulator's palette, read from the token system rather than written
 *  here, so a theme change moves the terminal with everything else (D-046). */
function terminalTheme(): ITheme {
  const theme: Record<string, string> = {};
  for (const [slot, name] of THEME_TOKENS) {
    const value = token(name);
    if (value !== undefined) theme[slot] = value;
  }
  return theme as ITheme;
}

function stateOf(session: TerminalSession): { tone: string; label: string } {
  if (session.state === "running") return { tone: "active", label: "running" };
  if (session.exitCode === null || session.exitCode === 0) return { tone: "neutral", label: "stopped" };
  return { tone: "danger", label: `failed ${session.exitCode}` };
}

// --- One pane --------------------------------------------------------------------

interface Pane {
  terminal: Terminal;
  fit: FitAddon;
  /** The element this pane's emulator was opened into, owned by the pane and
   *  never shared. `Terminal.open` builds its DOM once and returns early on
   *  every later call, so a pane that is detached from the screen can never be
   *  re-opened into it — the second switch back would show an empty box. Each
   *  pane keeps its own host, and switching tabs hides one and shows another. */
  host: HTMLDivElement;
  /** True once the session's existing scrollback has been written in, so a
   *  re-mount does not print everything twice. */
  seeded: boolean;
}

/**
 * The panes for this drawer, kept outside React state.
 *
 * A `Terminal` owns a canvas and a scrollback buffer; letting React recreate
 * one on re-render would clear the screen every time a tab's status changed.
 * Panes are created once per session and disposed when that session is closed
 * or the drawer unmounts.
 */
function usePanes(missionId: string) {
  const panes = useRef(new Map<string, Pane>());

  useEffect(() => {
    const held = panes.current;
    return () => {
      for (const pane of held.values()) {
        pane.terminal.dispose();
        pane.host.remove();
      }
      held.clear();
    };
  }, [missionId]);

  return panes;
}

// --- The dock ---------------------------------------------------------------------

/** What the dock is showing. Terminal sessions and the three kinds of project
 *  process, which are the four things that produce local output. */
type DockView = "terminal" | ProcessKind;

/**
 * The dock shows *logs*; the evidence panel shows the claims they support. The
 * two used the word "Verification" for both, which made one word mean the
 * durable attributed record in one place and a raw local log in another
 * (D-047). Only the panel says Verification now.
 */
const VIEWS: { view: DockView; label: string }[] = [
  { view: "terminal", label: "Terminal" },
  { view: "setup", label: "Setup" },
  { view: "run", label: "App" },
  { view: "verification", label: "Checks" }
];

export function RuntimeDock({ missionId }: { missionId: string }) {
  const [view, setView] = useState<DockView>("terminal");
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [heightVh, setHeightVh] = useState(DEFAULT_HEIGHT_VH);

  const screenRef = useRef<HTMLDivElement>(null);
  const panes = usePanes(missionId);
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeId;

  /** Builds the pane for a session, or returns the one that already exists. */
  const paneFor = useCallback(
    (sessionId: string): Pane => {
      const existing = panes.current.get(sessionId);
      if (existing) return existing;
      const terminal = new Terminal({
        // A real emulator's own defaults, with the product's type and palette.
        fontFamily: token("--font-mono"),
        fontSize: 13,
        lineHeight: 1.35,
        theme: terminalTheme(),
        scrollback: SCROLLBACK_LINES,
        cursorBlink: false,
        allowProposedApi: false,
        // Novus never writes into the terminal on the program's behalf: what
        // appears is what the PTY sent.
        convertEol: false
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      // Keystrokes go straight to the PTY. The emulator owns the encoding —
      // application cursor mode, function keys, bracketed paste, all of it —
      // which is the half a hand-written key map kept getting wrong.
      terminal.onData((data) => void novus().terminal.write({ sessionId, data }));
      terminal.onResize(({ cols, rows }) => void novus().terminal.resize({ sessionId, cols, rows }));
      const host = document.createElement("div");
      host.className = "terminal-pane";
      const pane: Pane = { terminal, fit, host, seeded: false };
      panes.current.set(sessionId, pane);
      return pane;
    },
    [panes]
  );

  // What already happened arrives with the session list, because the dock is
  // unmounted while it is closed and a session keeps running regardless. If
  // there is nothing open, one is started: showing the terminal is the request,
  // and a pane offering a button that opens a terminal is a door in front of a
  // door.
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
      if (result.value.length === 0) {
        const opened = await novus().terminal.open({ missionId, kind: "shell" });
        if (!live) return;
        if (!opened.ok) {
          setError(opened.message);
          return;
        }
        setSessions([opened.value]);
        setActiveId(opened.value.sessionId);
        return;
      }
      setActiveId((current) => current ?? result.value[result.value.length - 1]?.sessionId ?? null);
    })();
    return () => {
      live = false;
    };
  }, [missionId]);

  // Output is streamed from this machine's own main process and written into
  // the pane. It goes nowhere else (D-041).
  useEffect(() => {
    return novus().terminal.onOutput((chunk) => {
      const pane = panes.current.get(chunk.sessionId);
      if (pane && chunk.data !== "") pane.terminal.write(chunk.data);
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
  }, [panes]);

  // Every pane that has been opened stays in the screen; only the active one is
  // shown. Panes are never detached and re-opened, because an emulator builds
  // its DOM once — detaching one is how switching back to an earlier tab used
  // to leave a blank rectangle where a running shell was.
  useEffect(() => {
    const screen = screenRef.current;
    if (!screen || activeId === null || view !== "terminal") return;
    const pane = paneFor(activeId);
    if (pane.host.parentElement !== screen) screen.append(pane.host);
    for (const [sessionId, other] of panes.current) other.host.hidden = sessionId !== activeId;
    if (pane.terminal.element === undefined) pane.terminal.open(pane.host);
    /** Sizing is only meaningful once the element has been laid out. Fitting
     *  against a box the browser has not measured yet yields a one-row
     *  terminal, and the PTY is then *told* it is one row — so the shell wraps
     *  and scrolls everything a person wanted to read straight off the top. */
    const fitWhenLaidOut = () => {
      if (screen.clientHeight <= 0 || screen.clientWidth <= 0) return;
      try {
        pane.fit.fit();
      } catch {
        /* the pane was disposed between the frame and this callback */
      }
    };
    fitWhenLaidOut();
    const frame = requestAnimationFrame(fitWhenLaidOut);
    pane.terminal.focus();

    if (!pane.seeded) {
      pane.seeded = true;
      void (async () => {
        const result = await novus().terminal.scrollback(activeId);
        if (result.ok && result.value !== "") pane.terminal.write(result.value);
      })();
    }

    if (typeof ResizeObserver === "undefined") return () => cancelAnimationFrame(frame);
    const observer = new ResizeObserver(fitWhenLaidOut);
    observer.observe(screen);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [activeId, paneFor, panes, heightVh, view]);

  const active = sessions.find((session) => session.sessionId === activeId) ?? null;

  const create = async (kind: TerminalKind) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    // The size the reader can actually see, so a program that reads its
    // dimensions at start-up gets the right answer rather than 80×24.
    const current = activeId === null ? null : panes.current.get(activeId);
    const result = await novus().terminal.open({
      missionId,
      kind,
      ...(current ? { cols: current.terminal.cols, rows: current.terminal.rows } : {})
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setSessions((previous) => [...previous, result.value]);
    setActiveId(result.value.sessionId);
  };

  const end = async (sessionId: string) => {
    setError(null);
    const result = await novus().terminal.close(sessionId);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    const pane = panes.current.get(sessionId);
    pane?.terminal.dispose();
    pane?.host.remove();
    panes.current.delete(sessionId);
    const remaining = sessions.filter((session) => session.sessionId !== sessionId);
    setSessions(remaining);
    // A closed tab hands the screen to its neighbour; closing the last one
    // starts a fresh shell rather than leaving a dock with nothing in it, for
    // the same reason opening the dock opens a session.
    if (remaining.length === 0) {
      setActiveId(null);
      void create("shell");
    } else if (activeId === sessionId) {
      setActiveId(remaining[remaining.length - 1]?.sessionId ?? null);
    }
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
      aria-label="Runtime"
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
        {/* One dock, four views. Detailed local output lives here; the trace
            above shows the milestone and the evidence panel shows the bounded
            result that supports a claim — never the same output three times
            (D-045). */}
        <div className="dock-views" role="tablist" aria-label="Runtime views">
          {VIEWS.map((entry) => (
            <button
              key={entry.view}
              role="tab"
              aria-selected={view === entry.view}
              className={view === entry.view ? "dock-view active" : "dock-view"}
              onClick={() => setView(entry.view)}
              data-testid="dock-view"
              data-view={entry.view}
            >
              {entry.label}
            </button>
          ))}
        </div>

        {view === "terminal" && (
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
              <span
                key={session.sessionId}
                className={selected ? "terminal-tab active" : "terminal-tab"}
                data-testid="terminal-tab"
                data-kind={session.kind}
                data-name={session.name}
                data-state={tone.label}
              >
                <button
                  role="tab"
                  aria-selected={selected}
                  className="terminal-tab-open"
                  onClick={() => setActiveId(session.sessionId)}
                  onDoubleClick={() => setRenaming(session.sessionId)}
                  title={`${session.name} — ${tone.label}`}
                >
                  <TerminalGlyph />
                  <span className="terminal-tab-name">{session.name}</span>
                </button>
                {/* A tab closes from the tab, the way every terminal does. The
                    kind and the state were words nobody reads twice, on the row
                    with the least room to spare. */}
                <button
                  className="terminal-tab-close"
                  onClick={() => void end(session.sessionId)}
                  aria-label={`Close ${session.name}`}
                  title={`Close ${session.name}`}
                  data-testid="terminal-tab-close"
                >
                  ×
                </button>
              </span>
            );
          })}
          <button
            className="terminal-new"
            onClick={() => void create("shell")}
            disabled={busy}
            aria-label="New terminal"
            title="New terminal"
            data-testid="terminal-new"
          >
            +
          </button>
        </div>
        )}

        <span className="terminal-head-spacer" />

        {/* The dock closes from the same toggle that opened it. A second control
            that only does what the toggle does is a word on screen doing no
            work. */}
        {view === "terminal" && active && (
          <button
            className="btn btn-text"
            onClick={() => setRenaming(active.sessionId)}
            data-testid="terminal-rename-action"
          >
            Rename
          </button>
        )}
      </div>

      {error && (
        <p className="inline-error terminal-error" role="alert" data-testid="terminal-error">
          {error}
        </p>
      )}

      {view !== "terminal" ? (
        <ProcessLogView missionId={missionId} kind={view} />
      ) : (
        <>
          {/* The screen, always. Showing the terminal is the request, so a
              session is already starting when this renders empty — offering a
              button that opens a terminal is a door in front of a door. */}
          <div
            className="terminal-screen"
            ref={screenRef}
            role="group"
            aria-label={active === null ? "Terminal" : `${active.name} — ${stateOf(active).label}`}
            data-testid="terminal-screen"
          />
          {active?.state === "exited" && (
            <p className="terminal-ended" data-testid="terminal-ended">
              This session ended{active.exitCode === null ? "" : ` with code ${active.exitCode}`}. Start a
              new one to keep working.
            </p>
          )}
        </>
      )}
    </section>
  );
}
