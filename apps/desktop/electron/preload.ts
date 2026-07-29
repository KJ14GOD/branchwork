import { contextBridge, ipcRenderer } from "electron";

/**
 * The only surface the renderer has onto the host.
 *
 * Three calls, all mediated by the main process: where the worker is listening,
 * the token that lets the renderer talk to it, and a native directory chooser.
 * No filesystem, no Node, no shell.
 */
contextBridge.exposeInMainWorld("novus", {
  workerUrl: (): Promise<string> => ipcRenderer.invoke("novus:worker-url"),
  accessToken: (): Promise<string> => ipcRenderer.invoke("novus:access-token"),
  pickDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke("novus:pick-directory"),
});
