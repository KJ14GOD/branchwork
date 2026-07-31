import { contextBridge, ipcRenderer } from "electron";

import type { FileContent, TreeEntry } from "./fs-browser.ts";

/**
 * The only surface the renderer has onto the host.
 *
 * All mediated by the main process: where the worker is listening, the token
 * that lets the renderer talk to it, a native directory chooser, a real
 * shell, and read-only file browsing. The shell and the file browser are
 * both deliberate widenings for the *human* operating this window — see the
 * comment beside `terminals` in main.ts for the shell, and beside the
 * `novus:fs-*` handlers for the browser — neither is a new capability for
 * the agent, and neither is reachable over the worker's HTTP API a remote
 * guest could ever touch. Everything else stays out: no raw filesystem
 * access, no Node globals in the renderer.
 */
contextBridge.exposeInMainWorld("novus", {
  /**
   * Whether this window was launched to host or to join, and the invite a
   * join launch may have carried. Hosting is the default; the renderer only
   * ever changes shape on an explicit join launch.
   */
  launch: (): Promise<{ mode: "host" | "join"; invite: string | null }> =>
    ipcRenderer.invoke("novus:launch"),
  /** Null in a joining window, which has no worker of its own. */
  workerUrl: (): Promise<string | null> => ipcRenderer.invoke("novus:worker-url"),
  /** Null in a joining window — its credential is the pasted invite token. */
  accessToken: (): Promise<string | null> =>
    ipcRenderer.invoke("novus:access-token"),
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

  fs: {
    list: (repositoryPath: string, relativePath: string): Promise<TreeEntry[]> =>
      ipcRenderer.invoke("novus:fs-list", repositoryPath, relativePath),
    read: (repositoryPath: string, relativePath: string): Promise<FileContent> =>
      ipcRenderer.invoke("novus:fs-read", repositoryPath, relativePath),
    registerRepository: (repositoryPath: string): void =>
      ipcRenderer.send("novus:fs-register-repository", repositoryPath),
  },
});
