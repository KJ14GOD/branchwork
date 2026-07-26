import { contextBridge, ipcRenderer } from "electron";

/**
 * The only surface the renderer has onto the host.
 *
 * Two calls, both mediated by the main process: where the worker is listening,
 * and a native directory chooser. No filesystem, no Node, no shell.
 */
contextBridge.exposeInMainWorld("novus", {
  workerUrl: (): Promise<string> => ipcRenderer.invoke("novus:worker-url"),
  pickDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke("novus:pick-directory"),
});
