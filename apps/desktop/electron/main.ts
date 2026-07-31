import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import * as pty from "node-pty";

import { listDirectory, readFileForViewer } from "./fs-browser.ts";
import { choosePort, launchPlan } from "./launch.ts";
import { serveRenderer, type RendererHost } from "./renderer-host.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "../../..");
const workerEntry = resolve(repositoryRoot, "apps/worker/src/worker.ts");
const envFile = resolve(repositoryRoot, ".env");

/**
 * Hosting or joining, decided by how the app was launched — see launch.ts.
 *
 * Everything host-shaped below (the worker, its token, the terminal, the
 * file browser, the directory picker) is conditional on this. A joining
 * window is a teammate's window onto someone else's session: it holds no
 * repository, spawns no worker, and gets no host credential to leak.
 */
const plan = launchPlan(process.argv, process.env);

const PREFERRED_WORKER_PORT = Number(process.env.NOVUS_PORT ?? 4319);
const WORKER_PORT_PINNED = process.env.NOVUS_PORT !== undefined;
/**
 * Minted here rather than read back from the worker's output.
 *
 * The main process is the only party that needs to know it before the worker
 * exists, and parsing a secret out of a child's stdout would mean it had been
 * printed. This way it is passed in and never logged. Minted even when a
 * join launch will never use it — minting is free and branching here would
 * buy nothing — but a join launch never *hands it out*: the IPC below
 * answers null, because there is no worker for it to be a credential to.
 */
const ACCESS_TOKEN =
  process.env.NOVUS_TOKEN?.trim() || randomBytes(32).toString("base64url");
/** Known once the worker's port is settled; stays null for a join launch. */
let workerUrl: string | null = null;
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
const startWorker = (port: number): void => {
  worker = spawn(
    "node",
    [`--env-file=${envFile}`, "--experimental-strip-types", workerEntry],
    {
      cwd: resolve(repositoryRoot, "apps/worker"),
      env: {
        ...process.env,
        NOVUS_TOKEN: ACCESS_TOKEN,
        // Explicit even when it matches the default: when the default port
        // was taken, this is how the worker learns the free one main chose.
        NOVUS_PORT: String(port),
      },
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

const waitForWorker = async (url: string): Promise<boolean> => {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`);

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

// How the renderer learns which kind of window it is. Hosting is the default
// and carries no invite; a join launch may carry the pasted link so the join
// screen starts filled in.
ipcMain.handle("novus:launch", () =>
  plan.mode === "join"
    ? { mode: "join", invite: plan.invite }
    : { mode: "host", invite: null },
);

ipcMain.handle("novus:worker-url", () => workerUrl);
// The renderer needs it to call the worker at all. It stays out of the page URL
// and out of the DOM; the preload bridge is the only way across. A joining
// window gets null: there is no worker here, so there is nothing this would
// be a credential to — a joined session's credential is the invite token,
// which the person pastes and the renderer holds.
ipcMain.handle("novus:access-token", () =>
  plan.mode === "host" ? ACCESS_TOKEN : null,
);

ipcMain.handle("novus:pick-directory", async () => {
  // A joining window has no repository to choose. The join UI never shows
  // the button; this is the backstop behind it.
  if (!window || plan.mode === "join") {
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
    if (plan.mode === "join") {
      // The widening above is argued for the *host's* window. A joining
      // window is a teammate's view of someone else's session; nothing about
      // joining entitles it to a shell on this machine, so the capability is
      // refused at the boundary rather than merely not rendered.
      throw new Error("A joining window has no host terminal.");
    }

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
 * that the named repository was a *selected* one. registeredRepositories,
 * populated by a real session open/resume (see registerRepository in
 * use-session.ts), fixes that for an honest caller — a typo, a stale path, a
 * bug elsewhere in the renderer naming the wrong root.
 *
 * Say plainly what it does not fix: registerRepository is exposed on the
 * same unauthenticated contextBridge surface as list/read themselves, so a
 * genuinely compromised renderer can call `fs.registerRepository("/")` and
 * then read anything the OS user running Novus can read — the gate does not
 * distinguish a real session's registration from a forged one. That is the
 * same actual exposure the terminal already carries (an arbitrary shell with
 * an arbitrary cwd), just reached a different way, so this is not a new hole
 * relative to what already existed — but do not describe this Set as
 * confinement against a hostile renderer. It only confines an honest one.
 * Closing the real gap would mean main deciding which repositories are
 * legitimately open from a source the renderer cannot write to at all — e.g.
 * asking the worker's own /sessions with main's own token — not a Set the
 * renderer can populate.
 */
const registeredRepositories = new Set<string>();

ipcMain.on(
  "novus:fs-register-repository",
  (_event, repositoryPath: string) => {
    // A joining window never legitimately opens a repository, so nothing it
    // says can make one browsable — fs-list and fs-read then refuse every
    // path, because the set stays empty.
    if (plan.mode === "join") {
      return;
    }

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
  // The delineation, in one branch: hosting spawns the worker and waits for
  // it, exactly as this app always has; joining spawns nothing, because a
  // joining window has no repository and no business holding the standard
  // worker port — it reads someone else's session over the invite's own
  // transport instead.
  if (plan.mode === "host") {
    const chosen = await choosePort(PREFERRED_WORKER_PORT, WORKER_PORT_PINNED);

    if (chosen.kind === "refused") {
      dialog.showErrorBox("Novus could not start its worker", chosen.reason);
      app.quit();

      return;
    }

    if (chosen.fallback) {
      // Almost always another Novus already hosting on this machine. Moving
      // is safe: the renderer learns the URL over IPC and every invite link
      // this instance mints carries the real endpoint.
      console.log(
        `[novus] port ${PREFERRED_WORKER_PORT} is taken (another Novus?) — this worker will listen on ${chosen.port} instead`,
      );
    }

    workerUrl = `http://127.0.0.1:${chosen.port}`;
    startWorker(chosen.port);

    const healthy = await waitForWorker(workerUrl);

    if (!healthy) {
      dialog.showErrorBox(
        "Novus could not reach its worker",
        `The worker did not start listening on ${workerUrl} within ${HEALTH_TIMEOUT_MS / 1000}s.`,
      );
    }
  }

  if (!(await prepareRenderer())) {
    app.quit();

    return;
  }

  if (plan.mode === "host" && workerUrl !== null) {
    // Printed here rather than forwarded from the worker. The worker prints
    // its own invite line, and main strips the token out of what it re-emits
    // so the credential does not land in the launching shell's scrollback —
    // which left the printed link carrying "[redacted]" where the token
    // should be, and no way to invite anybody. Main holds the token, so main
    // is the right place to compose the one usable line.
    const guestPort = Number(process.env.NOVUS_GUEST_PORT ?? 5274);

    console.log("");
    console.log(
      "A teammate on this machine joins from their own Novus app: they paste",
    );
    console.log(
      "an invite from the session's Invite panel, or you can hand them this",
    );
    console.log("host-level link (full owner access — prefer a role-scoped invite):");
    console.log("");
    console.log(
      `  http://127.0.0.1:${guestPort}/?endpoint=${encodeURIComponent(workerUrl)}&token=${ACCESS_TOKEN}`,
    );
    console.log("");
    console.log(
      "The same link opens in the read-only browser guest (pnpm --filter @novus/guest dev).",
    );
    console.log("");
  } else {
    console.log(
      "[novus] join launch — no worker was started; this window joins another host's session",
    );
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
