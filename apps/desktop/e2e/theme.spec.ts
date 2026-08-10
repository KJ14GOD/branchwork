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
 * The theme choice after first run (D-103, D-029): the sun-or-crescent at
 * the rail's foot — and ⌘, — open a block anchored right there; picking
 * Light moves the whole
 * product at once (the resolved theme lands on the document root, which is
 * the one thing every token consumer keys from); the preference survives a
 * relaunch and resolves before first paint. Screenshots are the light
 * palette's screen-proof, reviewed against DESIGN.md's composition rules.
 */

const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const evidenceDir = join(desktopRoot, "e2e", "evidence");
const CP_PORT = 4498;
const CP_URL = `http://127.0.0.1:${CP_PORT}`;
const DB_NAME = "novus_e2e_theme";
const DB_URL = `postgres://novus:novus@127.0.0.1:5433/${DB_NAME}`;

let controlPlane: ChildProcess;
let userDataDir: string;
let localRepoDir: string;
let repoName: string;
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

const resolvedTheme = (target: Page) =>
  target.evaluate(() => document.documentElement.dataset.theme ?? "unset");

/** A token's current value in the browser's own computed spelling, so
 *  assertions compare surfaces to the token system rather than to values
 *  written out here (AGENTS.md rule 14 reaches the tests too). */
const tokenAsRgb = (target: Page, token: string) =>
  target.evaluate((name) => {
    const probe = document.createElement("div");
    probe.style.color = getComputedStyle(document.documentElement).getPropertyValue(name);
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, token);

const shot = (target: Page, name: string) =>
  target.screenshot({ path: join(evidenceDir, name) }).catch(() => undefined);

beforeAll(async () => {
  mkdirSync(evidenceDir, { recursive: true });
  userDataDir = mkdtempSync(join(tmpdir(), "novus-theme-"));

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

  // One real project with one real mission, so the light palette is proven on
  // a populated room rather than an empty shell.
  localRepoDir = mkdtempSync(join(tmpdir(), "novus-theme-repo-"));
  repoName = basename(localRepoDir);
  git(localRepoDir, ["init", "-b", "main"]);
  writeFileSync(join(localRepoDir, "README.md"), "# theme fixture\n");
  git(localRepoDir, ["add", "-A"]);
  git(localRepoDir, ["-c", "user.name=T", "-c", "user.email=t@l", "commit", "-m", "fixture"]);
  const headSha = git(localRepoDir, ["rev-parse", "HEAD"]);

  const localId = randomUUID();
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

  await page.getByTestId("setup").waitFor({ timeout: 30_000 });
  await page.getByTestId("sign-in-button").click();
  await page.getByTestId("github-connected").waitFor({ timeout: 30_000 });
  await page.getByTestId("finish-setup").click();
  await page.getByTestId("project-shell").waitFor({ timeout: 30_000 });

  const projectRow = page.getByTestId("project-row").filter({ hasText: repoName });
  await projectRow.waitFor({ timeout: 30_000 });
  await projectRow.hover();
  await page.getByTestId("repo-new-mission").click();
  await page.getByTestId("new-mission-dialog").waitFor({ timeout: 30_000 });
  await page
    .getByTestId("new-mission-dialog")
    .getByTestId("composer-input")
    .fill("prove the light palette");
  await page.keyboard.press("Enter");
  await page
    .getByTestId("trace-outcome")
    .filter({ hasText: "Turn completed" })
    .waitFor({ timeout: 90_000 });
}, 240_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  controlPlane?.kill("SIGTERM");
});

describe("the theme choice after first run (D-102)", () => {
  it(
    "the block opens at the rail's foot, Light moves the product, and the choice survives a relaunch",
    async () => {
      // Dark is the default and the reference (DESIGN.md#tokens), and the
      // trigger wears the resolved theme: a crescent while dark (D-103).
      expect(await resolvedTheme(page)).toBe("dark");
      await expect
        .poll(async () => page.getByTestId("open-theme").getAttribute("data-resolved"))
        .toBe("dark");

      // Where desktop apps keep it: the account corner of the rail. The
      // control opens a block right there, never a page.
      await page.getByTestId("open-theme").click();
      await page.getByTestId("theme-popover").waitFor({ timeout: 10_000 });
      expect(await page.getByTestId("dialog-scrim").count()).toBe(0);
      await shot(page, "115-theme-popover-dark.png");

      // Picking Light applies immediately — no confirm, no restart — and the
      // trigger's glyph turns to the sun with it.
      await page.getByTestId("theme-light").click();
      expect(await resolvedTheme(page)).toBe("light");
      await expect
        .poll(async () => page.getByTestId("open-theme").getAttribute("data-resolved"))
        .toBe("light");
      // The ground itself moved: the body consumes light --bg, not a value of
      // its own.
      await expect
        .poll(async () =>
          page.evaluate(() => getComputedStyle(document.body).backgroundColor)
        )
        .toBe(await tokenAsRgb(page, "--bg"));
      // The popover plane consumes --surface-2; polling it settles any
      // eased backgrounds before the evidence shot.
      await expect
        .poll(async () =>
          page.evaluate(() => {
            const block = document.querySelector('[data-testid="theme-popover"]');
            return block ? getComputedStyle(block).backgroundColor : "gone";
          })
        )
        .toBe(await tokenAsRgb(page, "--surface-2"));
      await shot(page, "116-theme-popover-light.png");

      // Esc puts the block away, leaving the populated room in light for the
      // screen-proof.
      await page.keyboard.press("Escape");
      await expect
        .poll(async () => page.getByTestId("theme-popover").count())
        .toBe(0);
      await shot(page, "117-mission-room-light.png");

      // ⌘, is the platform's own chord for it.
      await page.keyboard.press("Meta+Comma");
      await page.getByTestId("theme-popover").waitFor({ timeout: 10_000 });

      // System follows the OS: the resolved theme must equal what the OS
      // reports, whichever that is on this machine — and the glyph follows
      // the resolution, not the word "System" (D-103).
      await page.getByTestId("theme-system").click();
      const osPrefers = await page.evaluate(() =>
        window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"
      );
      expect(await resolvedTheme(page)).toBe(osPrefers);
      await expect
        .poll(async () => page.getByTestId("open-theme").getAttribute("data-resolved"))
        .toBe(osPrefers);

      // Back to Light, then relaunch: the preference persists and resolves
      // before first paint — the setup surface never flashes dark first.
      await page.getByTestId("theme-light").click();
      expect(await resolvedTheme(page)).toBe("light");
      await app.close();
      const relaunched = await launch(userDataDir);
      app = relaunched.app;
      page = relaunched.page;
      await page.getByTestId("project-shell").waitFor({ timeout: 30_000 });
      expect(await resolvedTheme(page)).toBe("light");
      await shot(page, "118-shell-light-after-relaunch.png");

      // And back to the reference for whoever runs the suite next.
      await page.getByTestId("open-theme").click();
      await page.getByTestId("theme-popover").waitFor({ timeout: 10_000 });
      await page.getByTestId("theme-dark").click();
      expect(await resolvedTheme(page)).toBe("dark");
      await expect
        .poll(async () => page.getByTestId("open-theme").getAttribute("data-resolved"))
        .toBe("dark");
    },
    240_000
  );
});
