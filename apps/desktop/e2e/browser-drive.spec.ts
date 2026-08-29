import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { NovusBridge } from "@novus/contracts";

declare global {
  interface Window {
    novus: NovusBridge;
  }
}

/**
 * The agent drives the fenced browser (D-218), end to end in a real window.
 *
 * A real project serving a real interactive page in the embedded preview, and
 * a scripted turn that asks to browse, gets one approval, and then clicks and
 * types across the page on that one approval — proving the drive functions
 * move the real webview and that a single approval covers the turn's actions.
 *
 * What this does not reach: a live model choosing the coordinates (the
 * scripted harness supplies them), and the raw computer-use surface, which is
 * a separate native build (D-218). The mid-turn cut-off and the session's
 * stickiness are unit-proven in `test/artifact-mcp.test.ts` and the router in
 * `test/execution.test.ts`; here the page itself is the witness.
 */

const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const evidenceDir = join(desktopRoot, "e2e", "evidence");
const CP_PORT = 4501;
const CP_URL = `http://127.0.0.1:${CP_PORT}`;
const DB_NAME = "novus_e2e_browser";
const DB_URL = `postgres://novus:novus@127.0.0.1:5433/${DB_NAME}`;

let controlPlane: ChildProcess;
let userDataDir: string;
let localRepoDir: string;
let repoName: string;
let localId: string;
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

async function signIn(target: Page): Promise<void> {
  await target.getByTestId("setup").waitFor({ timeout: 30_000 });
  await target.getByTestId("sign-in-button").click();
  await target.getByTestId("github-connected").waitFor({ timeout: 30_000 });
  await target.getByTestId("finish-setup").click();
  await target.getByTestId("project-shell").waitFor({ timeout: 30_000 });
}

async function approveOnce(): Promise<void> {
  const approve = page.getByTestId("approval-approve");
  await approve.waitFor({ timeout: 60_000 });
  await approve.click();
}

/** The embedded page, as its own Playwright page — driving it is driving the
 *  real app. */
async function previewPage(timeoutMs = 30_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = app.windows().find((candidate) => candidate.url().startsWith("http://localhost:"));
    if (found) return found;
    await new Promise((settle) => setTimeout(settle, 200));
  }
  throw new Error("no embedded preview page attached");
}

beforeAll(async () => {
  mkdirSync(evidenceDir, { recursive: true });
  userDataDir = mkdtempSync(join(tmpdir(), "novus-browser-"));

  const pg = await import("pg");
  const admin = new pg.default.Pool({ connectionString: "postgres://novus:novus@127.0.0.1:5433/novus" });
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
      env: { ...process.env, NOVUS_FAKE_GITHUB: "1", NOVUS_CP_PORT: String(CP_PORT), NOVUS_DATABASE_URL: DB_URL },
      stdio: "inherit"
    }
  );
  await waitForHealth();

  // An interactive fixture with its controls at KNOWN CSS-pixel positions, so
  // a scripted click lands deterministically: a button at (20,20) 120×40 →
  // centre (80,40) that writes CLICKED, and a field at (20,80) 200×30 →
  // centre (120,95) that mirrors what is typed.
  localRepoDir = mkdtempSync(join(tmpdir(), "novus-browser-repo-"));
  repoName = basename(localRepoDir);
  git(localRepoDir, ["init", "-b", "main"]);
  writeFileSync(join(localRepoDir, "README.md"), "# browser-drive fixture\n");
  writeFileSync(
    join(localRepoDir, "server.mjs"),
    [
      'import { createServer } from "node:http";',
      "const port = Number(process.env.NOVUS_PORT ?? 4600);",
      "const page = [",
      "  '<!doctype html><html><body style=\"margin:0\">',",
      "  '<button id=\"btn\" style=\"position:absolute;left:20px;top:20px;width:120px;height:40px\">Press</button>',",
      "  '<input id=\"field\" style=\"position:absolute;left:20px;top:80px;width:200px;height:30px\">',",
      "  '<div id=\"out\" style=\"position:absolute;left:20px;top:130px\">steady</div>',",
      "  '<script>',",
      "  \"document.getElementById('btn').addEventListener('click',function(){document.getElementById('out').textContent='CLICKED'});\",",
      "  \"document.getElementById('field').addEventListener('input',function(e){document.getElementById('out').textContent='TYPED:'+e.target.value});\",",
      "  '</script></body></html>'",
      "].join('');",
      'createServer((req, res) => { res.setHeader("content-type", "text/html"); res.end(page); }).listen(port, "127.0.0.1");'
    ].join("\n")
  );
  mkdirSync(join(localRepoDir, ".novus"), { recursive: true });
  writeFileSync(
    join(localRepoDir, ".novus", "settings.toml"),
    [
      'defaultRun = "app"',
      "",
      "[[run]]",
      'name = "app"',
      'command = "node server.mjs"',
      "",
      "[run.readiness]",
      'kind = "port"',
      "timeoutSeconds = 60",
      "",
      "[timeouts]",
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

  app = await electron.launch({
    args: [desktopRoot],
    env: {
      ...process.env,
      NOVUS_CP_URL: CP_URL,
      NOVUS_AUTH_AUTOVISIT: "1",
      NOVUS_FAKE_HARNESS: "1",
      NOVUS_FAKE_CONNECTORS: "[]",
      NOVUS_FAKE_HARNESS_APPROVAL: "1",
      // Pace the scripted turn so the "Agent is browsing" banner is observable
      // while the actions run, rather than gone before the poll.
      NOVUS_FAKE_HARNESS_PACE_MS: "400",
      NOVUS_USER_DATA_DIR: userDataDir
    }
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await app.evaluate(async ({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
  });
  await new Promise((settle) => setTimeout(settle, 250));
  await signIn(page);

  const projectRow = page.getByTestId("project-row").filter({ hasText: repoName });
  await projectRow.waitFor({ timeout: 30_000 });
  await projectRow.hover();
  await page.getByTestId("repo-new-mission").click();
  await page.getByTestId("new-mission-dialog").waitFor({ timeout: 30_000 });
  await page.getByTestId("new-mission-dialog").getByTestId("composer-input").fill("drive the app's own page");
  await page.keyboard.press("Enter");
  await approveOnce();
  await page.getByTestId("trace-outcome").filter({ hasText: "Turn completed" }).waitFor({ timeout: 90_000 });

  // Start the app and open its preview — the surface the agent drives.
  await page.getByTestId("run-control").click();
  await page.getByTestId("run-menu").waitFor();
  const appItem = page.getByTestId("run-item").filter({ hasText: "node server.mjs" });
  await appItem.waitFor({ timeout: 20_000 });
  await appItem.click();
  await page.getByTestId("run-live").waitFor({ timeout: 45_000 });
  await page.getByTestId("open-preview").click();
  await page.getByTestId("preview-surface").waitFor({ timeout: 20_000 });
  const deadline = Date.now() + 30_000;
  while ((await page.getByTestId("preview-word").textContent()) !== "running") {
    if (Date.now() > deadline) throw new Error("the preview never reached running");
    await new Promise((settle) => setTimeout(settle, 500));
  }
  await page.locator('[data-testid="preview-body"][data-phase="ready"]').waitFor({ timeout: 30_000 });
}, 300_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  controlPlane?.kill("SIGTERM");
});

describe("the agent drives the fenced browser (D-218)", () => {
  it("one approval covers the turn: the agent clicks and types across the real page", async () => {
    const embedded = await previewPage();
    await embedded.waitForLoadState("domcontentloaded");
    expect(await embedded.locator("#out").textContent()).toBe("steady");

    // Back to the conversation, where the approval card lives.
    await page.getByTestId("room-tab").click();
    await page.getByTestId("chat").waitFor({ timeout: 20_000 });
    // One ask (browser_navigate), then the session covers click, click, type
    // — the direction encodes the sequence the scripted harness performs.
    await page
      .getByTestId("composer-input")
      .fill("[fake-ask:mcp__novus__browser_navigate] [browser:navigate /][browser:click 80 40][browser:click 120 95][browser:type hello]");
    await page.keyboard.press("Enter");

    // Exactly one approval — for the whole turn's browsing.
    await approveOnce();

    // The page itself is the witness: the button was clicked (CLICKED), then
    // the field was focused and typed into (TYPED:hello) — both on one
    // approval, both through the real webview.
    await expect
      .poll(async () => embedded.locator("#out").textContent(), { timeout: 30_000 })
      .toBe("TYPED:hello");

    await page.getByTestId("trace-outcome").filter({ hasText: "Turn completed" }).last().waitFor({ timeout: 90_000 });

    // A second approval never came: the turn's browsing rode one grant. The
    // approval card is gone, and only the one we clicked was ever shown.
    expect(await page.getByTestId("approval-approve").count()).toBe(0);

    // The room showed the agent had the page (the banner), and it clears when
    // the turn ends — the preview surface stays mounted, so its status is the
    // honest signal. Cleanup runs just after the outcome, so poll for it.
    await expect
      .poll(
        async () => {
          const result = await page.evaluate(async () => window.novus.workspace.preview.status());
          return result.ok ? result.value?.agentDriving : true;
        },
        { timeout: 15_000 }
      )
      .toBe(false);

    await page.getByTestId("preview-tab").click();
    await page.getByTestId("preview-surface").waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(evidenceDir, "224-agent-drove-the-page.png") });
  }, 180_000);

  it("raw computer use is gated by the machine opt-in, and refuses honestly with no backend (D-218)", async () => {
    await page.getByTestId("room-tab").click();
    await page.getByTestId("chat").waitFor({ timeout: 20_000 });

    // Off by default: a computer action is refused outright — no approval card
    // ever appears, and the harness is told why.
    await page
      .getByTestId("composer-input")
      .fill("[fake-ask:mcp__novus__computer_click] [computer:click 5000 3000]");
    await page.keyboard.press("Enter");
    await page.getByTestId("chat").getByText("off for this Mac", { exact: false }).last().waitFor({ timeout: 90_000 });
    await page.getByTestId("trace-outcome").filter({ hasText: "Turn completed" }).last().waitFor({ timeout: 90_000 });
    // No card was ever shown for it.
    expect(await page.getByTestId("approval-approve").count()).toBe(0);

    // The owner turns it on (machine-local; the agent cannot).
    await page.evaluate(async () => window.novus.computerUse.setEnabled(true));

    // Now the first action asks; a person approves; and the structural fence
    // refuses a click that lands on Novus's own window — deterministic on any
    // machine and with any backend, because the fence bites before the driver,
    // so no real input is ever synthesized. The click target is Novus's own
    // window centre, read live.
    const bounds = await app.evaluate(async ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getBounds() ?? null);
    if (!bounds) throw new Error("no Novus window to aim the fence at");
    const cx = Math.round(bounds.x + bounds.width / 2);
    const cy = Math.round(bounds.y + bounds.height / 2);
    await page
      .getByTestId("composer-input")
      .fill(`[fake-ask:mcp__novus__computer_click] [computer:click ${cx} ${cy}]`);
    await page.keyboard.press("Enter");
    await approveOnce();
    await page
      .getByTestId("chat")
      .getByText("on Novus's own window", { exact: false })
      .last()
      .waitFor({ timeout: 90_000 });
    await page.getByTestId("trace-outcome").filter({ hasText: "Turn completed" }).last().waitFor({ timeout: 90_000 });

    // Put it back off, so the machine ends as it began.
    await page.evaluate(async () => window.novus.computerUse.setEnabled(false));
  }, 180_000);

  it("the agent reads the page as text through the same session", async () => {
    await page.getByTestId("room-tab").click();
    await page.getByTestId("chat").waitFor({ timeout: 20_000 });
    await page
      .getByTestId("composer-input")
      .fill("[fake-ask:mcp__novus__browser_read] [browser:read]");
    await page.keyboard.press("Enter");
    await approveOnce();
    // The read comes back as the turn's own text: the field's typed value is
    // in the page, so the snapshot carries it.
    await page.getByTestId("chat").getByText("TYPED:hello", { exact: false }).last().waitFor({ timeout: 90_000 });
    await page.getByTestId("trace-outcome").filter({ hasText: "Turn completed" }).last().waitFor({ timeout: 90_000 });
  }, 180_000);
});
