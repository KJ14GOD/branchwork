import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import * as pty from "node-pty";

import { listDirectory, readFileForViewer } from "./fs-browser.ts";
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

// Opt-in only, and never touched by a normal launch: lets this exact app be
// driven by a real CDP client (screenshots, DOM queries) during development
// instead of trusting "it typechecks" as proof a change looks right. Must be
// set before the app is ready, which is true of every module-level statement
// here since app.whenReady() is only ever called below.
if (process.env.NOVUS_CDP_PORT) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.NOVUS_CDP_PORT);
}

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
 * Real shells, for the host only.
 *
 * This is a deliberate widening of the boundary the preload comment above
 * used to state as absolute ("no filesystem, no Node, no shell") — but it
 * widens it for the human operating this window, not for the model. The
 * approval gate in apps/worker exists to constrain what the *agent* can run
 * on its own; a person typing into their own terminal inside their own app
 * is not a new capability for the agent, the same way Terminal.app already
 * open on this Mac is not. A guest never gets this: the bridge that exposes
 * it is loaded only in the host window, and nothing here is reachable over
 * the worker's HTTP API a remote guest could ever touch.
 */
const terminals = new Map<string, pty.IPty>();

ipcMain.handle(
  "novus:terminal-create",
  (event, options: { cwd?: string; cols: number; rows: number }) => {
    const id = randomBytes(8).toString("hex");
    const shellPath = process.env.SHELL || "/bin/zsh";

    const term = pty.spawn(shellPath, [], {
      name: "xterm-256color",
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd || app.getPath("home"),
      env: process.env as Record<string, string>,
    });

    terminals.set(id, term);

    term.onData((data) => {
      event.sender.send("novus:terminal-data", id, data);
    });

    term.onExit(({ exitCode }) => {
      event.sender.send("novus:terminal-exit", id, exitCode);
      terminals.delete(id);
    });

    return id;
  },
);

ipcMain.on("novus:terminal-write", (_event, id: string, data: string) => {
  terminals.get(id)?.write(data);
});

ipcMain.on(
  "novus:terminal-resize",
  (_event, id: string, cols: number, rows: number) => {
    // A pty that has already exited throws on resize rather than no-op —
    // the renderer's own resize observer can fire after the shell closed.
    try {
      terminals.get(id)?.resize(cols, rows);
    } catch {
      // Already gone; the exit event already told the renderer.
    }
  },
);

ipcMain.on("novus:terminal-dispose", (_event, id: string) => {
  terminals.get(id)?.kill();
  terminals.delete(id);
});

/**
 * The file browser's own filesystem access — "caveman mode": browse the
 * open repository, open a file, look at it, read-only. See fs-browser.ts
 * for why this is a second, independent confinement rather than a widening
 * of what the terminal above already grants: a shell the host typed into
 * themselves is not a new capability for the agent, but this IPC surface
 * genuinely is new, so it gets the same repository-relative-only,
 * symlink-resolved, .git/.env-refusing rules apps/worker's own tools use.
 *
 * That confinement is only as good as what it confines *to*. The first
 * version took repositoryPath as a per-call renderer-supplied argument and
 * trusted it outright — which is not a widening of the terminal's own reach
 * (a shell already has an arbitrary cwd), but it did mean the fs-list/fs-read
 * handlers did not actually satisfy CLAUDE.md's own stated invariant,
 * "repository access is confined to the selected repo": nothing here checked
 * that the named repository was a *selected* one. registeredRepositories is
 * populated only by a real, successful session open/resume (see
 * registerRepository in use-session.ts) — a path never opened as a session
 * is refused before listDirectory/readFileForViewer ever run, regardless of
 * what string the renderer sends.
 */
const registeredRepositories = new Set<string>();

ipcMain.on(
  "novus:fs-register-repository",
  (_event, repositoryPath: string) => {
    registeredRepositories.add(repositoryPath);
  },
);

ipcMain.handle(
  "novus:fs-list",
  (_event, repositoryPath: string, relativePath: string) => {
    if (!registeredRepositories.has(repositoryPath)) {
      throw new Error(`${repositoryPath} was never opened as a session.`);
    }

    return listDirectory(repositoryPath, relativePath);
  },
);

ipcMain.handle(
  "novus:fs-read",
  (_event, repositoryPath: string, relativePath: string) => {
    if (!registeredRepositories.has(repositoryPath)) {
      throw new Error(`${repositoryPath} was never opened as a session.`);
    }

    return readFileForViewer(repositoryPath, relativePath);
  },
);

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

  // Printed here rather than forwarded from the worker. The worker prints its
  // own invite line, and main strips the token out of what it re-emits so the
  // credential does not land in the launching shell's scrollback — which left
  // the printed link carrying "[redacted]" where the token should be, and no
  // way to invite anybody. Main holds the token, so main is the right place to
  // compose the one usable line.
  const guestPort = Number(process.env.NOVUS_GUEST_PORT ?? 5274);

  console.log("");
  console.log("Open a second, read-only viewer with:");
  console.log("");
  console.log(`  pnpm --filter @novus/guest dev`);
  console.log("");
  console.log("then open this, once you have opened a repository:");
  console.log("");
  console.log(
    `  http://127.0.0.1:${guestPort}/?endpoint=${encodeURIComponent(WORKER_URL)}&token=${ACCESS_TOKEN}`,
  );
  console.log("");

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

  for (const term of terminals.values()) {
    term.kill();
  }
  terminals.clear();

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
