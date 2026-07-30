import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { bridge } from "../bridge.ts";
import type { Theme } from "../use-theme.ts";

// xterm.js paints to its own canvas, outside the DOM/CSS the rest of the app
// themes through custom properties — a var() reference means nothing here,
// so the well plane's two colors are mirrored as literals. Keep these equal
// to --bg-well/--text in both :root blocks of styles.css; nothing enforces
// that equality, the way nothing enforces most of this file's hand mirroring
// of design tokens into a canvas API.
const TERMINAL_THEME: Record<Theme, { background: string; foreground: string; selection: string }> = {
  dark: {
    background: "#060607",
    foreground: "#e7e7ea",
    selection: "rgba(231, 231, 234, 0.18)",
  },
  light: {
    background: "#eef0f2",
    foreground: "#17171a",
    selection: "rgba(23, 23, 26, 0.12)",
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

    const colors = TERMINAL_THEME[theme];

    termRef.current.options.theme = {
      background: colors.background,
      foreground: colors.foreground,
      cursor: colors.foreground,
      selectionBackground: colors.selection,
    };
  }, [theme]);

  useEffect(() => {
    const host = bridge();
    const container = containerRef.current;

    if (!host || !container) {
      return;
    }

    const colors = TERMINAL_THEME[theme];

    const term = new Terminal({
      // Matches the app's own well plane and mono stack — a terminal is
      // exactly the "raw output" the plane system already sinks below the
      // canvas, so it should look like it belongs there, not like a widget
      // dropped on top of it.
      theme: {
        background: colors.background,
        foreground: colors.foreground,
        cursor: colors.foreground,
        selectionBackground: colors.selection,
      },
      fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace',
      fontSize: 12,
      cursorBlink: true,
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
