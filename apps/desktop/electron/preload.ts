import { contextBridge, ipcRenderer } from "electron";

/**
 * The only surface the renderer has onto the host.
 *
 * Four things, all mediated by the main process: where the worker is
 * listening, the token that lets the renderer talk to it, a native directory
 * chooser, and a real shell. The shell is deliberate — see the comment beside
 * `terminals` in main.ts for why it does not widen what the *agent* can do.
 * Everything else stays out: no raw filesystem access, no Node globals in
 * the renderer.
 */
contextBridge.exposeInMainWorld("novus", {
  workerUrl: (): Promise<string> => ipcRenderer.invoke("novus:worker-url"),
  accessToken: (): Promise<string> => ipcRenderer.invoke("novus:access-token"),
  pickDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke("novus:pick-directory"),

  terminal: {
    create: (options: { cwd?: string; cols: number; rows: number }): Promise<string> =>
      ipcRenderer.invoke("novus:terminal-create", options),
    write: (id: string, data: string): void =>
      ipcRenderer.send("novus:terminal-write", id, data),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send("novus:terminal-resize", id, cols, rows),
    dispose: (id: string): void =>
      ipcRenderer.send("novus:terminal-dispose", id),
    // Returns an unsubscribe function, the way DOM/React listeners do —
    // callers dispose their own subscription rather than leaking one that
    // outlives the component that registered it.
    onData: (id: string, handler: (data: string) => void): (() => void) => {
      const listener = (_event: unknown, eventId: string, data: string) => {
        if (eventId === id) {
          handler(data);
        }
      };

      ipcRenderer.on("novus:terminal-data", listener);

      return () => ipcRenderer.off("novus:terminal-data", listener);
    },
    onExit: (id: string, handler: (exitCode: number) => void): (() => void) => {
      const listener = (_event: unknown, eventId: string, exitCode: number) => {
        if (eventId === id) {
          handler(exitCode);
        }
      };

      ipcRenderer.on("novus:terminal-exit", listener);

      return () => ipcRenderer.off("novus:terminal-exit", listener);
    },
  },
});
