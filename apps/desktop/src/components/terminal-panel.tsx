import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { bridge } from "../bridge.ts";

/**
 * A real shell, bound to the open repository's directory.
 *
 * One xterm.js instance per mount, backed by one pty in the main process —
 * see the comment beside `terminals` in electron/main.ts for what this is
 * and is not a capability for. Unmounting disposes both ends; nothing here
 * outlives the panel that opened it.
 */
export const TerminalPanel = ({ cwd }: { cwd: string | null }) => {
  const containerRef = useRef<HTMLDivElement>(null);

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
      theme: {
        background: "#060607",
        foreground: "#e7e7ea",
        cursor: "#e7e7ea",
        selectionBackground: "rgba(231, 231, 234, 0.18)",
      },
      fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace',
      fontSize: 12,
      cursorBlink: true,
      scrollback: 5_000,
    });

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

      term.dispose();
    };
    // cwd intentionally not in the dependency list: switching repositories
    // does not tear down and respawn an open shell out from under whatever
    // command is running in it. A fresh terminal for a fresh repository is
    // a new panel, not a side effect of this one re-running.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="terminal-panel" ref={containerRef} />;
};
