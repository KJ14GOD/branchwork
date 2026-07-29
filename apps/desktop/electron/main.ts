import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";

import { serveRenderer, type RendererHost } from "./renderer-host.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "../../..");
const workerEntry = resolve(repositoryRoot, "apps/worker/src/worker.ts");
const envFile = resolve(repositoryRoot, ".env");

const WORKER_PORT = Number(process.env.NOVUS_PORT ?? 4319);
/**
 * Minted here rather than read back from the worker's output.
 *
 * The main process is the only party that needs to know it before the worker
 * exists, and parsing a secret out of a child's stdout would mean it had been
 * printed. This way it is passed in and never logged.
 */
const ACCESS_TOKEN =
  process.env.NOVUS_TOKEN?.trim() || randomBytes(32).toString("base64url");
const WORKER_URL = `http://127.0.0.1:${WORKER_PORT}`;
const HEALTH_TIMEOUT_MS = 15_000;

let worker: ChildProcess | null = null;
let window: BrowserWindow | null = null;
let rendererHost: RendererHost | null = null;
/**
 * The origin the window is allowed to be at.
 *
 * Vite's in development, the loopback file server's once there is no Vite. Both
 * are `http://127.0.0.1:<port>`, which is what the worker's origin rule admits;
 * `file://` is not, and was the bug.
 */
let rendererOrigin: string | null = null;

/**
 * Runs the worker as a child process.
 *
 * The renderer never gets Node, the filesystem, or a terminal — it reaches the
 * host only through this process and the worker's loopback HTTP API. A crash
 * in the agent loop takes the worker down, not the window.
 */
const startWorker = (): void => {
  worker = spawn(
    "node",
    [`--env-file=${envFile}`, "--experimental-strip-types", workerEntry],
    {
      cwd: resolve(repositoryRoot, "apps/worker"),
      env: { ...process.env, NOVUS_TOKEN: ACCESS_TOKEN },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  // The worker prints an invite line carrying the token, which is correct on a
  // host's own terminal but not here: forwarding it verbatim would put the
  // credential in the launching shell's scrollback, contradicting the whole
  // reason it is passed through IPC instead of the page URL.
  const withoutToken = (text: string): string =>
    text.split(ACCESS_TOKEN).join("[redacted:access-token]");

  worker.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[worker] ${withoutToken(chunk.toString("utf8"))}`);
  });

  worker.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[worker] ${withoutToken(chunk.toString("utf8"))}`);
  });

  worker.on("error", (error) => {
    dialog.showErrorBox(
      "Novus could not start its worker",
      `${error.message}\n\nNode.js must be on PATH.`,
    );
  });
};

const waitForWorker = async (): Promise<boolean> => {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${WORKER_URL}/health`);

      if (response.ok) {
        return true;
      }
    } catch {
      // Not listening yet.
    }

    await new Promise((settle) => setTimeout(settle, 200));
  }

  return false;
};

const createWindow = (): void => {
  window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0a0a0b",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 12 },
    webPreferences: {
      preload: resolve(here, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Links open in the user's browser, never inside the app window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);

    return { action: "deny" };
  });

  // The preload bridge hands out the worker's access token, so it must stay
  // attached to our own pages only. With a `file://` window this mattered less;
  // now that the renderer sits on an http origin, an ordinary link or a
  // scripted `location =` could carry a remote page into a window that answers
  // `novus:access-token`. It cannot leave the origin it was opened at.
  window.webContents.on("will-navigate", (event, url) => {
    if (rendererOrigin && new URL(url).origin === rendererOrigin) {
      return;
    }

    event.preventDefault();
    void shell.openExternal(url);
  });

  if (rendererOrigin) {
    void window.loadURL(rendererOrigin);
  }
};

ipcMain.handle("novus:worker-url", () => WORKER_URL);
// The renderer needs it to call the worker at all. It stays out of the page URL
// and out of the DOM; the preload bridge is the only way across.
ipcMain.handle("novus:access-token", () => ACCESS_TOKEN);

ipcMain.handle("novus:pick-directory", async () => {
  if (!window) {
    return null;
  }

  const result = await dialog.showOpenDialog(window, {
    title: "Choose a repository",
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: "Open",
  });

  return result.canceled ? null : (result.filePaths[0] ?? null);
});

/**
 * Decides where the window loads from, before there is a window.
 *
 * In development Vite is already serving the renderer and the dev server URL is
 * handed to us. Otherwise the build output is on disk and needs an origin, so
 * we serve it ourselves rather than opening it as a file — see
 * `renderer-host.ts` for why that distinction decides whether the app works at
 * all.
 */
const prepareRenderer = async (): Promise<boolean> => {
  const devServer = process.env.VITE_DEV_SERVER_URL;

  if (devServer) {
    rendererOrigin = new URL(devServer).origin;

    return true;
  }

  try {
    rendererHost = await serveRenderer(resolve(here, "../dist"));
    rendererOrigin = rendererHost.origin;

    return true;
  } catch (error) {
    dialog.showErrorBox(
      "Novus could not serve its interface",
      `${(error as Error).message}\n\nRun \`pnpm --filter @novus/desktop build\` first if this is a source checkout.`,
    );

    return false;
  }
};

void app.whenReady().then(async () => {
  startWorker();

  const healthy = await waitForWorker();

  if (!healthy) {
    dialog.showErrorBox(
      "Novus could not reach its worker",
      `The worker did not start listening on ${WORKER_URL} within ${HEALTH_TIMEOUT_MS / 1000}s.`,
    );
  }

  if (!(await prepareRenderer())) {
    app.quit();

    return;
  }

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

const shutdown = (): void => {
  worker?.kill();
  worker = null;

  void rendererHost?.close();
  rendererHost = null;
};

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", shutdown);
process.on("exit", shutdown);
