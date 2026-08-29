import { useCallback, useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { TerminalKind, TerminalSession } from "@novus/contracts";
import { novus } from "../bridge";
import { THEME_EVENT } from "../theme";

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
  /** True before a mission exists at all — a draft has no workspace. */
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
function usePanes(missionId: string, workstreamId?: string) {
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
  }, [missionId, workstreamId]);

  return panes;
}

// --- The dock ---------------------------------------------------------------------

/**
 * The dock is the terminal (D-049).
 *
 * It carried a four-way switch — Terminal, Setup, App, Checks — so pressing the
 * terminal control landed on a *page about* terminals with the shell one click
 * further away. Every other view had its own contextual surface already: setup
 * is the setup dialog the mission state and `Run ▾` both open, the app is
 * `Run ▾` with Stop and Open preview, and a check's attributed result is the
 * evidence panel's ledger. A switch in front of a shell is a navigation nobody
 * asked for on the one surface where the request is unambiguous.
 */
export function RuntimeDock({
  missionId,
  workstreamId,
  prime,
  onPrimed,
  side = "bottom",
  onToggleSide
}: {
  missionId: string;
  /** The lane whose worktree the shell opens in — the room's active approach.
   *  Switching lanes remounts the dock, so a session in one worktree is never
   *  presented as the other's (D-080). */
  workstreamId?: string;
  /** A command to type into a shell on arrival (D-199) — typed, never
   *  submitted: the person presses Enter in their own session or does not.
   *  Null asks for nothing. */
  prime?: string | null;
  onPrimed?: () => void;
  /** Where the dock stands (D-228): the room's bottom edge, or its right as a
   *  full-height column — the inspector's own posture. */
  side?: "bottom" | "right";
  /** Moves the dock to the other edge; absent hides the control. */
  onToggleSide?: () => void;
}) {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [heightVh, setHeightVh] = useState(DEFAULT_HEIGHT_VH);

  const screenRef = useRef<HTMLDivElement>(null);
  const panes = usePanes(missionId, workstreamId);
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
      const result = await novus().terminal.list(missionId, workstreamId);
      if (!live) return;
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setSessions(result.value);
      if (result.value.length === 0) {
        const opened = await novus().terminal.open({
          missionId,
          ...(workstreamId ? { workstreamId } : {}),
          kind: "shell"
        });
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
  }, [missionId, workstreamId]);

  // A theme change moves the terminal with everything else (D-046): the
  // palette was copied out of CSS at pane creation, so live panes are handed
  // the newly resolved tokens when the person flips theme.
  useEffect(() => {
    const repaint = () => {
      const palette = terminalTheme();
      for (const [, pane] of panes.current) pane.terminal.options.theme = palette;
    };
    window.addEventListener(THEME_EVENT, repaint);
    return () => window.removeEventListener(THEME_EVENT, repaint);
  }, [panes]);

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
    if (!screen || activeId === null) return;
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
  }, [activeId, paneFor, panes, heightVh]);

  const active = sessions.find((session) => session.sessionId === activeId) ?? null;

  /** The primed command (D-199): typed into the dock's own shell — the one
   *  the mount effect opens — without a newline, so nothing runs that a
   *  person did not fire themselves. The effect waits for that shell rather
   *  than racing it with a second one, and consumes the prime exactly once,
   *  after the shell has spoken (bytes fired into a still-initialising line
   *  editor are eaten). */
  const primed = useRef<string | null>(null);
  useEffect(() => {
    if (!prime || primed.current === prime) return;
    const shell = sessions.find((session) => session.kind === "shell");
    if (!shell) return; // the mount effect is still opening it; deps re-run us
    primed.current = prime;
    setActiveId(shell.sessionId);
    void (async () => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const read = await novus().terminal.scrollback(shell.sessionId);
        if (read.ok && read.value.length > 0) break;
        await new Promise((settle) => setTimeout(settle, 250));
      }
      await novus().terminal.write({ sessionId: shell.sessionId, data: prime });
      onPrimed?.();
    })();
  }, [prime, sessions, onPrimed]);

  const create = async (kind: TerminalKind) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    // The size the reader can actually see, so a program that reads its
    // dimensions at start-up gets the right answer rather than 80×24.
    const current = activeId === null ? null : panes.current.get(activeId);
    const result = await novus().terminal.open({
      missionId,
      ...(workstreamId ? { workstreamId } : {}),
      kind,
      ...(current ? { cols: current.terminal.cols, rows: current.terminal.rows } : {})
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setSessions((previous) => [...previous, result.value]);
    // Selected and focused, because opening a shell is asking to type in it.
    // The attach effect below focuses whichever pane becomes active, and this
    // is the same act one render earlier.
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
      className={side === "right" ? "terminal-dock dock-right" : "terminal-dock"}
      style={side === "right" ? undefined : { height: `${heightVh}vh` }}
      aria-label="Runtime"
      data-testid="terminal-dock"
      data-side={side}
    >
      {side === "bottom" && (
        <div
          className="terminal-grip"
          onPointerDown={onGrab}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the terminal"
          data-testid="terminal-grip"
        />
      )}

      {/* One row: the sessions and a `+`. The dock closes from the same toggle
          that opened it, and a tab is named from the repository rather than by
          hand — a second control that only does what another control does, and
          a label a person has to maintain, are both words on screen doing no
          work (D-049). */}
      <div className="terminal-head">
        <div className="terminal-tabs" role="tablist" aria-label="Terminal tabs">
          {sessions.map((session) => {
            const tone = stateOf(session);
            const selected = session.sessionId === activeId;
            return (
              <span
                key={session.sessionId}
                className={selected ? "terminal-tab active" : "terminal-tab"}
                data-testid="terminal-tab"
                data-session={session.sessionId}
                data-kind={session.kind}
                data-name={session.name}
                data-state={tone.label}
              >
                <button
                  role="tab"
                  aria-selected={selected}
                  className="terminal-tab-open"
                  onClick={() => setActiveId(session.sessionId)}
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

        <span className="terminal-head-spacer" />
        {onToggleSide && (
          <button
            className="btn btn-text terminal-side-toggle"
            onClick={onToggleSide}
            title={side === "right" ? "Dock the terminal at the bottom" : "Dock the terminal on the right"}
            data-testid="terminal-side-toggle"
          >
            {side === "right" ? "Dock bottom" : "Dock right"}
          </button>
        )}
      </div>

      {error && (
        <p className="inline-error terminal-error" role="alert" data-testid="terminal-error">
          {error}
        </p>
      )}

      {/* The screen, always. Showing the terminal is the request, so a session
          is already starting when this renders empty — offering a button that
          opens a terminal is a door in front of a door. */}
      <div
        className="terminal-screen"
        ref={screenRef}
        role="group"
        aria-label={active === null ? "Terminal" : `${active.name} — ${stateOf(active).label}`}
        data-testid="terminal-screen"
      />
      {active?.state === "exited" && (
        <p className="terminal-ended" data-testid="terminal-ended">
          This shell ended{active.exitCode === null ? "" : ` with code ${active.exitCode}`}. Start a new
          one to keep working.
        </p>
      )}
    </section>
  );
}
