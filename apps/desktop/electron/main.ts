import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";

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

  worker.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[worker] ${chunk.toString("utf8")}`);
  });

  worker.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[worker] ${chunk.toString("utf8")}`);
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

  const devServer = process.env.VITE_DEV_SERVER_URL;

  if (devServer) {
    void window.loadURL(devServer);
  } else {
    void window.loadFile(resolve(here, "../dist/index.html"));
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

void app.whenReady().then(async () => {
  startWorker();

  const healthy = await waitForWorker();

  if (!healthy) {
    dialog.showErrorBox(
      "Novus could not reach its worker",
      `The worker did not start listening on ${WORKER_URL} within ${HEALTH_TIMEOUT_MS / 1000}s.`,
    );
  }

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

const stopWorker = (): void => {
  worker?.kill();
  worker = null;
};

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", stopWorker);
process.on("exit", stopWorker);
