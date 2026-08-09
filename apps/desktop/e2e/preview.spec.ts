import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { NovusBridge, PreviewStatus } from "@novus/contracts";

declare global {
  interface Window {
    novus: NovusBridge;
  }
}

/**
 * The preview surface, driven end to end (D-098).
 *
 * A real Electron window, a real project whose run command is a real HTTP
 * server on this machine's loopback, a real embedded view. What a person
 * does: start the app from Run, watch the room say *starting* until the
 * declared readiness signal answers, open the preview inside Novus, click
 * and type **in the running app**, stop the app and read that the preview
 * says so plainly, run it again, and get the preview back on the same
 * workstream. What an attacker does is here too: the bridge is asked
 * directly for addresses nothing reported, addresses with smuggled
 * credentials, and foreign origins, and refuses each in words.
 *
 * Screenshots are supporting evidence. The assertions are the test.
 */

const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const evidenceDir = join(desktopRoot, "e2e", "evidence");
const CP_PORT = 4497;
const CP_URL = `http://127.0.0.1:${CP_PORT}`;
const DB_NAME = "novus_e2e_preview";
const DB_URL = `postgres://novus:novus@127.0.0.1:5433/${DB_NAME}`;

let controlPlane: ChildProcess;
let userDataDir: string;
let localRepoDir: string;
let repoName: string;
let localId: string;
let missionId: string;
let workstreamId: string;
let app: ElectronApplication;
let page: Page;

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd }).toString().trim();

async function waitForHealth(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${CP_URL}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((settle) => setTimeout(settle, 500));
  }
  throw new Error("control plane never became healthy");
}

async function mintToken(): Promise<string> {
  const started = await fetch(`${CP_URL}/auth/github/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  const { state, authorizeUrl } = (await started.json()) as { state: string; authorizeUrl: string };
  await fetch(authorizeUrl, { redirect: "follow" });
  const claimed = await fetch(`${CP_URL}/auth/github/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state })
  });
  const { token } = (await claimed.json()) as { token?: string };
  if (!token) throw new Error("auth claim did not return a token");
  return token;
}

async function launch(dataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const launched = await electron.launch({
    args: [desktopRoot],
    env: {
      ...process.env,
      NOVUS_CP_URL: CP_URL,
      NOVUS_AUTH_AUTOVISIT: "1",
      NOVUS_FAKE_HARNESS: "1",
      NOVUS_USER_DATA_DIR: dataDir
    }
  });
  const window = await launched.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await launched.evaluate(async ({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
  });
  await new Promise((settle) => setTimeout(settle, 250));
  return { app: launched, page: window };
}

async function signIn(target: Page): Promise<void> {
  await target.getByTestId("setup").waitFor({ timeout: 30_000 });
  await target.getByTestId("sign-in-button").click();
  await target.getByTestId("github-connected").waitFor({ timeout: 30_000 });
  await target.getByTestId("finish-setup").click();
  await target.getByTestId("project-shell").waitFor({ timeout: 30_000 });
}

const shot = (target: Page, name: string) =>
  target.screenshot({ path: join(evidenceDir, name) }).catch(() => undefined);

/** The lane's one live run process, from the wire the room itself polls. */
async function liveRun(): Promise<{
  processId: string;
  state: string;
  readiness: string;
  previewUrl: string | null;
} | null> {
  return page.evaluate(async (id) => {
    const result = await window.novus.missions.get(id);
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    const live = result.value.processes.find(
      (process) =>
        process.kind === "run" && (process.state === "running" || process.state === "starting")
    );
    return live
      ? {
          processId: live.processId,
          state: live.state,
          readiness: live.readiness,
          previewUrl: live.previewUrl
        }
      : null;
  }, missionId);
}

/**
 * The embedded page, as a Playwright page of its own: the `WebContentsView`'s
 * webContents is an ordinary renderer target, so it attaches beside the main
 * window. Interacting through it is interacting with the running app.
 */
async function previewPage(timeoutMs = 30_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = app
      .windows()
      .find((candidate) => candidate.url().startsWith("http://localhost:"));
    if (found) return found;
    await new Promise((settle) => setTimeout(settle, 200));
  }
  throw new Error(
    `no embedded preview page attached; windows were [${app
      .windows()
      .map((candidate) => candidate.url())
      .join(", ")}]`
  );
}

beforeAll(async () => {
  mkdirSync(evidenceDir, { recursive: true });
  userDataDir = mkdtempSync(join(tmpdir(), "novus-preview-"));

  const pg = await import("pg");
  const admin = new pg.default.Pool({
    connectionString: "postgres://novus:novus@127.0.0.1:5433/novus"
  });
  if ((await admin.query(`select 1 from pg_database where datname='${DB_NAME}'`)).rowCount === 0) {
    await admin.query(`create database ${DB_NAME}`);
  }
  await admin.end();
  const scrub = new pg.default.Pool({ connectionString: DB_URL });
  await scrub.query("drop schema public cascade; create schema public;");
  await scrub.end();

  controlPlane = spawn(
    process.execPath,
    ["--experimental-strip-types", join(repoRoot, "apps", "control-plane", "src", "main.ts")],
    {
      env: {
        ...process.env,
        NOVUS_FAKE_GITHUB: "1",
        NOVUS_CP_PORT: String(CP_PORT),
        NOVUS_DATABASE_URL: DB_URL
      },
      stdio: "inherit"
    }
  );
  await waitForHealth();

  // A real project whose run command actually serves: a loopback HTTP server
  // on the port Novus allocates, with an interactive page — a button that
  // writes CLICKED, a field that mirrors what is typed, a same-origin link,
  // and an external link the embedded view must refuse to follow. Readiness
  // is declared as a port probe, so "ready" is the signal answering and never
  // the process merely existing (D-045).
  localRepoDir = mkdtempSync(join(tmpdir(), "novus-preview-repo-"));
  repoName = basename(localRepoDir);
  git(localRepoDir, ["init", "-b", "main"]);
  writeFileSync(join(localRepoDir, "README.md"), "# preview fixture\n");
  writeFileSync(
    join(localRepoDir, "server.mjs"),
    [
      'import { createServer } from "node:http";',
      "const port = Number(process.env.NOVUS_PORT ?? 4600);",
      "const page = `<!doctype html><html><body>",
      '<h1 id="title">Fixture app</h1>',
      "<button id=\"btn\" onclick=\"document.getElementById('out').textContent='CLICKED'\">Press</button>",
      '<input id="field">',
      '<div id="out"></div>',
      '<a id="deeper" href="/other">other page</a>',
      '<a id="external" href="https://example.com/">external</a>',
      "<script>document.getElementById('field').addEventListener('input',(e)=>{document.getElementById('out').textContent='TYPED:'+e.target.value});</script>",
      "</body></html>`;",
      "createServer((req, res) => {",
      '  if (req.url === "/other") {',
      '    res.setHeader("content-type", "text/html");',
      '    res.end(\'<h1 id="other">OTHER</h1>\');',
      "    return;",
      "  }",
      '  res.setHeader("content-type", "text/html");',
      "  res.end(page);",
      '}).listen(port, "127.0.0.1", () => {',
      '  console.log("serving on http://localhost:" + port);',
      "});"
    ].join("\n")
  );
  mkdirSync(join(localRepoDir, ".novus"), { recursive: true });
  writeFileSync(
    join(localRepoDir, ".novus", "settings.toml"),
    [
      'defaultRun = "app"',
      "",
      "[setup]",
      'command = "echo prepared > prepared.txt"',
      "",
      "[[run]]",
      'name = "app"',
      'command = "node server.mjs"',
      "",
      "[run.readiness]",
      'kind = "port"',
      "timeoutSeconds = 60",
      "",
      "[[verify]]",
      'name = "unit"',
      'command = "test -f server.mjs"',
      'category = "test"',
      "",
      "[timeouts]",
      "setupMinutes = 5",
      "verifyMinutes = 5"
    ].join("\n")
  );
  git(localRepoDir, ["add", "-A"]);
  git(localRepoDir, ["-c", "user.name=T", "-c", "user.email=t@l", "commit", "-m", "fixture"]);
  const headSha = git(localRepoDir, ["rev-parse", "HEAD"]);

  localId = randomUUID();
  const token = await mintToken();
  const registered = await fetch(`${CP_URL}/repositories/local`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ localId, name: repoName, defaultBranch: "main", headSha })
  });
  expect(registered.ok).toBe(true);
  writeFileSync(join(userDataDir, "local-repos.json"), JSON.stringify({ [localId]: localRepoDir }));

  const launched = await launch(userDataDir);
  app = launched.app;
  page = launched.page;
  await signIn(page);

  // Import the project by starting a mission in it (D-077): words create it
  // and the first fake-harness turn runs to completion.
  const projectRow = page.getByTestId("project-row").filter({ hasText: repoName });
  await projectRow.waitFor({ timeout: 30_000 });
  await projectRow.hover();
  await page.getByTestId("repo-new-mission").click();
  await page.getByTestId("new-mission-dialog").waitFor({ timeout: 30_000 });
  await page
    .getByTestId("new-mission-dialog")
    .getByTestId("composer-input")
    .fill("see the app running");
  await page.keyboard.press("Enter");
  await page
    .getByTestId("trace-outcome")
    .filter({ hasText: "Turn completed" })
    .waitFor({ timeout: 90_000 });

  missionId = await page.evaluate(async (repositoryId) => {
    const result = await window.novus.missions.list();
    if (!result.ok) throw new Error(result.message);
    return (
      result.value.find((mission) => mission.repository?.providerRepoId === repositoryId)
        ?.missionId ?? ""
    );
  }, localId);
  expect(missionId).toMatch(/^msn_/);
  workstreamId = await page.evaluate(async (mission) => {
    const result = await window.novus.missions.get(mission);
    if (!result.ok) throw new Error(result.message);
    return result.value.workstream?.workstreamId ?? "";
  }, missionId);
  expect(workstreamId).toMatch(/^wst_/);
}, 240_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  controlPlane?.kill("SIGTERM");
});

describe("the preview surface (D-098)", () => {
  it(
    "starts the project, waits for declared readiness, and a person uses the app inside Novus",
    async () => {
      // --- Start the app from Run, the way a person does --------------------
      await page.getByTestId("run-control").click();
      await page.getByTestId("run-menu").waitFor();
      const appItem = page.getByTestId("run-item").filter({ hasText: "node server.mjs" });
      await appItem.waitFor({ timeout: 20_000 });
      await appItem.click();
      await page.getByTestId("run-live").waitFor({ timeout: 45_000 });

      // --- Readiness is the declared signal answering, not the spawn --------
      await expect
        .poll(async () => (await liveRun())?.readiness ?? "gone", { timeout: 60_000 })
        .toBe("ready");
      const running = await liveRun();
      expect(running?.previewUrl).toContain("http://localhost:");

      // --- Open the preview inside the window -------------------------------
      await page.getByTestId("open-preview").click();
      await page.getByTestId("preview-tab").waitFor({ timeout: 20_000 });
      await page.getByTestId("preview-surface").waitFor({ timeout: 20_000 });
      // The head's word is the process's own vocabulary.
      await expect
        .poll(async () => page.getByTestId("preview-word").textContent(), { timeout: 20_000 })
        .toBe("running");

      // --- The embedded page is the real app, and interaction is real -------
      const embedded = await previewPage();
      await embedded.waitForLoadState("domcontentloaded");
      expect(await embedded.locator("#title").textContent()).toBe("Fixture app");
      await embedded.click("#btn");
      await expect
        .poll(async () => embedded.locator("#out").textContent(), { timeout: 10_000 })
        .toBe("CLICKED");
      await embedded.fill("#field", "hello");
      await expect
        .poll(async () => embedded.locator("#out").textContent(), { timeout: 10_000 })
        .toBe("TYPED:hello");
      // The embedded page is a plain sandboxed web context: nothing of
      // Novus's bridge exists in it (D-098).
      expect(await embedded.evaluate(() => typeof (window as { novus?: unknown }).novus)).toBe(
        "undefined"
      );
      // Two captures, honestly split: the window's own raster cannot include
      // a native view, so the chrome and the page are photographed apart.
      await shot(page, "103-preview-inside-novus.png");
      await embedded
        .screenshot({ path: join(evidenceDir, "103b-preview-page-itself.png") })
        .catch(() => undefined);

      // --- Reload is a preview verb; the process is untouched ---------------
      const before = await liveRun();
      await page.getByTestId("preview-reload").click();
      await expect
        .poll(async () => embedded.locator("#out").textContent().catch(() => null), {
          timeout: 15_000
        })
        .toBe("");
      expect((await liveRun())?.processId).toBe(before?.processId);

      // --- Navigation within the approved origin works ----------------------
      await embedded.click("#deeper");
      await expect
        .poll(async () => embedded.locator("#other").textContent().catch(() => ""), {
          timeout: 10_000
        })
        .toBe("OTHER");
      const originUrl = embedded.url();

      // --- And navigation anywhere else is refused in the main process ------
      await embedded.evaluate(() => {
        const link = document.createElement("a");
        link.id = "evil";
        link.href = "https://example.com/";
        link.textContent = "leave";
        document.body.appendChild(link);
      });
      // `noWaitAfter`, because the click schedules a navigation the main
      // process refuses — there is nothing to wait for, which is the point.
      await embedded.click("#evil", { noWaitAfter: true });
      await new Promise((settle) => setTimeout(settle, 1_000));
      expect(embedded.url()).toBe(originUrl);
      // window.open to a foreign origin opens nothing either.
      await embedded.evaluate(() => window.open("https://example.com/", "_blank"));
      await new Promise((settle) => setTimeout(settle, 500));
      expect(
        app.windows().filter((candidate) => candidate.url().startsWith("https://")).length
      ).toBe(0);

      // --- The room around it still works: terminal dock and evidence panel -
      await page.getByTestId("panel-toggle").click();
      await page.getByTestId("inspector").waitFor({ timeout: 20_000 });
      await page.getByTestId("panel-toggle").click();

      // --- Three widths, the preview open at each (DESIGN.md#responsive) ----
      await app.evaluate(async ({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setContentSize(1000, 800);
      });
      await new Promise((settle) => setTimeout(settle, 600));
      await page.getByTestId("preview-surface").waitFor();
      await shot(page, "104-preview-medium.png");
      await app.evaluate(async ({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setContentSize(760, 700);
      });
      await new Promise((settle) => setTimeout(settle, 600));
      await page.getByTestId("preview-surface").waitFor();
      await shot(page, "105-preview-narrow.png");
      await app.evaluate(async ({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
      });
      await new Promise((settle) => setTimeout(settle, 600));
    },
    240_000
  );

  it("refuses malicious and unreported addresses at the bridge itself", async () => {
    // Straight at the bridge, the way a compromised renderer would ask — the
    // interface never offers these, and the main process must not care.
    const refusals = await page.evaluate(async (mission) => {
      const bounds = { x: 0, y: 0, width: 100, height: 100 };
      const asks = [
        "https://evil.example/",
        "http://localhost@evil.example/",
        "http://localtest.me:3000/",
        "file:///etc/passwd",
        "http://localhost:9999/", // loopback, but nothing reported it
        "http://0.0.0.0:4600/"
      ];
      const answers: { url: string; ok: boolean; message: string }[] = [];
      for (const url of asks) {
        const result = await window.novus.workspace.preview.open({ missionId: mission, url, bounds });
        answers.push({ url, ok: result.ok, message: result.ok ? "" : result.message });
      }
      return answers;
    }, missionId);
    for (const answer of refusals) {
      expect(answer.ok, answer.url).toBe(false);
    }
    expect(refusals[0]?.message).toContain("loopback");
    expect(refusals[4]?.message).toContain("Nothing running in this workspace");
  });

  it("says stopped plainly, never stops the app from its own close, and reopens on the same workstream", async () => {
    // --- Closing the tab closes a window onto the app, not the app ---------
    const before = await liveRun();
    expect(before).not.toBeNull();
    await page.getByTestId("preview-tab-close").click();
    await page
      .getByTestId("preview-surface")
      .waitFor({ state: "detached", timeout: 10_000 })
      .catch(() => undefined);
    await new Promise((settle) => setTimeout(settle, 500));
    const afterClose = await liveRun();
    expect(afterClose?.processId).toBe(before?.processId);

    // --- Reopening reuses the live process and workstream -------------------
    await page.getByTestId("open-preview").click();
    await page.getByTestId("preview-surface").waitFor({ timeout: 20_000 });
    // The surface opens the view asynchronously; the status is polled rather
    // than read the instant the rectangle exists.
    let status: PreviewStatus | null = null;
    await expect
      .poll(
        async () => {
          status = await page.evaluate(async () => {
            const result = await window.novus.workspace.preview.status();
            return result.ok ? result.value : null;
          });
          return status === null ? null : (status as PreviewStatus).processId;
        },
        { timeout: 20_000 }
      )
      .toBe(before?.processId);
    expect((status as unknown as PreviewStatus | null)?.workstreamId).toBe(workstreamId);

    // --- Stopping the app is the Run surface's verb, and the preview says so
    await page.getByTestId("stop-run").click();
    await expect
      .poll(async () => page.getByTestId("preview-word").textContent(), { timeout: 45_000 })
      .toBe("stopped");
    const panel = page.getByTestId("preview-panel");
    await panel.waitFor({ timeout: 20_000 });
    expect(await panel.textContent()).toContain("The app was stopped.");
    // A stopped preview is words, not a page nothing serves: the run control
    // is back and the surface offers exactly the honest next action.
    await page.getByTestId("preview-run-again").waitFor({ timeout: 20_000 });
    await shot(page, "106-preview-stopped.png");

    // --- Run it again from the preview's own next action --------------------
    await page.getByTestId("preview-run-again").click();
    await expect
      .poll(async () => (await liveRun())?.readiness ?? "gone", { timeout: 60_000 })
      .toBe("ready");
    // A fresh process reports the address again; the surface offers reopening
    // rather than pretending the old page is still being served.
    await page.getByTestId("preview-reopen").waitFor({ timeout: 20_000 });
    await page.getByTestId("preview-reopen").click();
    await expect
      .poll(async () => page.getByTestId("preview-word").textContent(), { timeout: 30_000 })
      .toBe("running");

    // --- And the reopened preview is the running app again ------------------
    const embedded = await previewPage();
    await embedded.waitForLoadState("domcontentloaded");
    await embedded.click("#btn");
    await expect
      .poll(async () => embedded.locator("#out").textContent(), { timeout: 10_000 })
      .toBe("CLICKED");
    const reopened = await liveRun();
    expect(reopened?.processId).not.toBe(before?.processId);
    await shot(page, "107-preview-reopened.png");
  }, 240_000);
});
