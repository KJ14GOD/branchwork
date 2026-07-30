import { useEffect, useRef } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { bridge } from "../bridge.ts";
import type { Theme } from "../use-theme.ts";

/**
 * The terminal's colours, as literals, because xterm.js paints to its own
 * canvas outside the DOM — a `var()` reference means nothing here.
 *
 * TWO THINGS TO KNOW BEFORE EDITING:
 *
 * 1. `background` and `foreground` MUST stay equal to `--bg-well` and
 *    `--text` in the matching `:root` block of styles.css. Nothing enforces
 *    that; there is no compiler check and no test. If you change either
 *    token, change it here in the same commit.
 *
 * 2. The sixteen ANSI entries are new this pass and are the actual answer to
 *    "the terminal looks generic". Before, only background/foreground/cursor
 *    were set, so every program that emitted colour — `git`, `ls`, a test
 *    runner, a compiler's diagnostics — rendered in xterm's stock palette,
 *    which is bright, saturated, and belongs to a different product. These
 *    are desaturated toward this app's own palette (`--add`, `--del`,
 *    `--warn-text` are used verbatim for green, red and yellow) so coloured
 *    output reads as part of Novus rather than as a widget dropped into it.
 *    This is not decoration: a terminal that cannot show sixteen colours
 *    cannot show `git diff`, and a terminal showing them in someone else's
 *    palette is the thing that looked unconsidered.
 */
const TERMINAL_THEME: Record<Theme, ITheme> = {
  dark: {
    background: "#060607", // === --bg-well (dark)
    foreground: "#e7e7ea", // === --text (dark)
    cursor: "#e7e7ea",
    cursorAccent: "#060607",
    selectionBackground: "rgba(231, 231, 234, 0.18)",

    black: "#1b1b1f",
    red: "#d4564f", // === --del (dark)
    green: "#4ba85a", // === --add (dark)
    yellow: "#d3a84c", // === --warn-text (dark)
    blue: "#6a8cc7",
    magenta: "#a97bc4",
    cyan: "#5aa8a0",
    white: "#b9b9c2",

    brightBlack: "#56565e", // === --text-dim (dark)
    brightRed: "#e46b64",
    brightGreen: "#62c072",
    brightYellow: "#e6bd63",
    brightBlue: "#83a4dd",
    brightMagenta: "#c193dc",
    brightCyan: "#72c0b8",
    brightWhite: "#e7e7ea",
  },
  light: {
    background: "#eef0f2", // === --bg-well (light)
    foreground: "#17171a", // === --text (light)
    cursor: "#17171a",
    cursorAccent: "#eef0f2",
    selectionBackground: "rgba(23, 23, 26, 0.12)",

    black: "#2b2b30",
    red: "#b3382f", // === --del (light)
    green: "#1f7a3d", // === --add (light)
    yellow: "#7a5b16", // === --warn-text (light)
    blue: "#2f5aa8",
    magenta: "#7a3f96",
    cyan: "#10706a",
    white: "#5b5b64",

    brightBlack: "#85858e", // === --text-dim (light)
    brightRed: "#c2493f",
    brightGreen: "#2a8d4a",
    brightYellow: "#8d6b1e",
    brightBlue: "#3a68b8",
    brightMagenta: "#8a4ca6",
    brightCyan: "#17817a",
    brightWhite: "#17171a",
  },
};

/**
 * A real shell, bound to the open repository's directory.
 *
 * One xterm.js instance per mount, backed by one pty in the main process —
 * see the comment beside `terminals` in electron/main.ts for what this is
 * and is not a capability for. Unmounting disposes both ends; nothing here
 * outlives the panel that opened it.
 */
export const TerminalPanel = ({
  cwd,
  theme,
}: {
  cwd: string | null;
  theme: Theme;
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  // Applied on every theme change, not just at mount — a background tab
  // stays mounted (see the plane-of-tabs note in novus-ui/SKILL.md), so a
  // toggle needs to reach a terminal that already exists, not just the next
  // one created.
  useEffect(() => {
    if (!termRef.current) {
      // Not yet created (this mount's first pass — the create-terminal
      // effect below already applies the current theme), or already
      // disposed. Either way, nothing to update live.
      return;
    }

    termRef.current.options.theme = TERMINAL_THEME[theme];
  }, [theme]);

  useEffect(() => {
    const host = bridge();
    const container = containerRef.current;

    if (!host || !container) {
      return;
    }

    const term = new Terminal({
      // Matches the app's own well plane and mono stack — a terminal is
      // exactly the "raw output" the plane system already sinks below the
      // canvas, so it should look like it belongs there, not like a widget
      // dropped on top of it.
      theme: TERMINAL_THEME[theme],
      fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace',
      // 13px === --text-small, the same step the diff viewer and the file
      // viewer use. It was 12, which was a step below everything else that
      // shows code.
      fontSize: 13,
      lineHeight: 1.35,
      cursorBlink: true,
      // A bar rather than xterm's default block: the block cursor is the
      // single most recognisable "stock xterm" tell, and a bar matches every
      // other caret in the app.
      cursorStyle: "bar",
      cursorWidth: 2,
      scrollback: 5_000,
    });

    termRef.current = term;

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();

    let disposed = false;
    let unsubData: (() => void) | null = null;
    let unsubExit: (() => void) | null = null;
    let id: string | null = null;

    void host.terminal
      .create({ cwd: cwd ?? undefined, cols: term.cols, rows: term.rows })
      .then((createdId) => {
        if (disposed) {
          // The panel unmounted while the pty was still spawning — tear
          // down the one that just arrived rather than leaking it.
          host.terminal.dispose(createdId);

          return;
        }

        id = createdId;

        unsubData = host.terminal.onData(id, (data) => term.write(data));
        unsubExit = host.terminal.onExit(id, (exitCode) => {
          term.write(`\r\n[process exited with code ${exitCode}]\r\n`);
        });

        term.onData((data) => {
          if (id) {
            host.terminal.write(id, data);
          }
        });
      });

    const resizeObserver = new ResizeObserver(() => {
      fit.fit();

      if (id) {
        host.terminal.resize(id, term.cols, term.rows);
      }
    });

    resizeObserver.observe(container);

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      unsubData?.();
      unsubExit?.();

      if (id) {
        host.terminal.dispose(id);
      }

      termRef.current = null;
      term.dispose();
    };
    // cwd and theme intentionally not in the dependency list: switching
    // repositories does not tear down and respawn an open shell out from
    // under whatever command is running in it, and a theme change is
    // handled live by the effect above rather than by recreating the whole
    // terminal (which would lose scrollback and the running shell).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="terminal-panel" ref={containerRef} />;
};
