import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

/**
 * Spoken direction, in a real window (D-240, D-241). The recognizer, the
 * editor, and the microphone are the deterministic stand-ins
 * (`NOVUS_FAKE_DICTATION`): a scripted take that says the same words every
 * run, one fixed edit, and a tone for a microphone. What this
 * proves is the product a person touches — the chip and its listening word,
 * the volatile tail under the field, the settled segments landing at the
 * caret, the refined words replacing them once the take settles with the
 * heard words one click away, the chord, and the Voice settings page. The
 * real microphone, the real recognizer, and the real CLI are proven only by
 * a live run, which PROGRESS states plainly.
 */

const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const evidenceDir = join(desktopRoot, "e2e", "evidence");
const CP_PORT = 4487;
const CP_URL = `http://127.0.0.1:${CP_PORT}`;
const DB_NAME = "novus_e2e_dictation";
const DB_URL = `postgres://novus:novus@127.0.0.1:5433/${DB_NAME}`;

const HEARD = "Refactor the composer dot T S X so it uses the dictation bridge";
const REFINED = "Refactor the composer.tsx so it uses the dictation bridge.";

let controlPlane: ChildProcess;
let app: ElectronApplication;
let page: Page;
let repoName: string;

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd }).toString().trim();

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

beforeAll(async () => {
  mkdirSync(evidenceDir, { recursive: true });
  const userDataDir = mkdtempSync(join(tmpdir(), "novus-dictation-"));

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

  const localRepoDir = mkdtempSync(join(tmpdir(), "novus-dictation-repo-"));
  repoName = basename(localRepoDir);
  git(localRepoDir, ["init", "-b", "main"]);
  writeFileSync(join(localRepoDir, "README.md"), "# dictation fixture\n");
  mkdirSync(join(localRepoDir, "src"));
  writeFileSync(join(localRepoDir, "src", "composer.tsx"), "export const composer = 1;\n");
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

  app = await electron.launch({
    args: [desktopRoot],
    env: {
      ...process.env,
      NOVUS_CP_URL: CP_URL,
      NOVUS_AUTH_AUTOVISIT: "1",
      NOVUS_FAKE_HARNESS: "1",
      NOVUS_FAKE_CONNECTORS: "[]",
      NOVUS_FAKE_DICTATION: "1",
      NOVUS_USER_DATA_DIR: userDataDir
    }
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await app.evaluate(async ({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
  });

  await page.getByTestId("setup").waitFor({ timeout: 30_000 });
  await page.getByTestId("sign-in-button").click();
  await page.getByTestId("github-connected").waitFor({ timeout: 30_000 });
  await page.getByTestId("finish-setup").click();
  await page.getByTestId("project-shell").waitFor({ timeout: 30_000 });
}, 240_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  controlPlane?.kill("SIGTERM");
});

async function openAsk(): Promise<void> {
  const projectRow = page.getByTestId("project-row").filter({ hasText: repoName });
  await projectRow.waitFor({ timeout: 30_000 });
  await projectRow.hover();
  await page.getByTestId("repo-new-mission").click();
  await page.getByTestId("new-mission-dialog").waitFor({ timeout: 30_000 });
}

describe("dictating a direction (D-240)", () => {
  it(
    "listens, lands the words at the caret, refines them, and keeps the heard words one click away",
    async () => {
      await openAsk();
      const ask = page.getByTestId("new-mission-dialog");
      const input = ask.getByTestId("composer-input");
      const chip = ask.getByTestId("dictate");
      await chip.waitFor({ timeout: 10_000 });
      expect(await chip.getAttribute("aria-pressed")).toBe("false");
      const state = ask.getByTestId("dictation-state");

      // Words already in the box stay; the take lands after them.
      await input.fill("Also ");
      await chip.click();
      await expect.poll(async () => (await state.textContent())?.trim(), { timeout: 10_000 }).toMatch(/^Listening · \d:\d\d$/);
      expect(await chip.getAttribute("aria-pressed")).toBe("true");
      // The volatile tail under the field, then the settled segment in it.
      await expect.poll(async () => ask.getByTestId("dictation-tail").textContent(), { timeout: 10_000 }).toContain("refactor the");
      // The settled segment lands as heard, then cleans itself up while the
      // take goes on (D-242): the editor answers for it in the background.
      await expect.poll(async () => input.inputValue(), { timeout: 10_000 }).toContain("Also Refactor the composer");
      await expect.poll(async () => input.inputValue(), { timeout: 10_000 }).toBe("Also Refactor the composer.tsx");
      expect(await input.getAttribute("readonly")).not.toBeNull();
      await page.screenshot({ path: join(evidenceDir, "243-dictation-listening.png") });

      // Every word said and every segment already refined, then stop from
      // the button: the stop waits for nothing but supplies the full stop.
      await expect.poll(async () => input.inputValue(), { timeout: 10_000 }).toBe("Also Refactor the composer.tsx so it uses the dictation bridge");
      await chip.click();
      await expect.poll(async () => input.inputValue(), { timeout: 15_000 }).toBe(`Also ${REFINED}`);
      const note = ask.getByTestId("dictation-note");
      await note.waitFor({ timeout: 10_000 });
      expect(await note.textContent()).toContain("Refined against this repository's names");
      expect(await chip.getAttribute("aria-pressed")).toBe("false");
      expect(await state.count()).toBe(0);
      expect(await input.getAttribute("readonly")).toBeNull();
      await page.screenshot({ path: join(evidenceDir, "244-dictation-refined.png") });

      // The heard words are one click away, and the refined ones one more.
      await ask.getByTestId("dictation-swap").click();
      expect(await input.inputValue()).toBe(`Also ${HEARD}`);
      expect(await note.textContent()).toContain("As heard");
      await ask.getByTestId("dictation-swap").click();
      expect(await input.inputValue()).toBe(`Also ${REFINED}`);

      // The chord starts a second take from the keyboard; Escape stops it.
      // The caret sits after the refined words, so the new take lands there.
      await input.focus();
      await page.keyboard.press("End");
      await page.keyboard.press("Meta+d");
      await expect.poll(async () => (await state.textContent())?.trim(), { timeout: 10_000 }).toMatch(/^Listening/);
      await expect.poll(async () => input.inputValue(), { timeout: 10_000 }).toContain("Also Refactor the composer.tsx so it uses the dictation bridge. Refactor");
      await page.keyboard.press("Escape");
      await expect.poll(async () => input.inputValue(), { timeout: 15_000 }).toBe(`Also ${REFINED} ${REFINED}`);
      // Escape stopped the take and did not close the dialog.
      expect(await ask.count()).toBe(1);

      // Enter sends the words the person read, as ever.
      await page.keyboard.press("Enter");
      await ask.waitFor({ state: "detached", timeout: 30_000 });
      const roomChip = page.getByTestId("composer").getByTestId("dictate");
      await roomChip.waitFor({ timeout: 30_000 });
      expect(await roomChip.getAttribute("aria-pressed")).toBe("false");
      await page.screenshot({ path: join(evidenceDir, "246-dictate-chip-in-room.png") });
    },
    240_000
  );

  it(
    "Settings → Voice states the engines on this Mac, the microphone, and keeps the dictionary",
    async () => {
      await page.getByTestId("open-settings").click();
      await page.getByTestId("settings-dialog").waitFor({ timeout: 10_000 });
      await page.getByTestId("settings-page-voice").click();
      const speech = page.getByTestId("voice-speech");
      await speech.waitFor({ timeout: 10_000 });
      expect(await speech.textContent()).toContain("on-device · en_US");
      expect(await page.getByTestId("voice-editor").textContent()).toContain("Claude Code · fake-editor");
      expect(await page.getByTestId("voice-microphone").textContent()).toContain("granted");
      // No key row exists anywhere on this page (D-241).
      expect(await page.getByText("OpenAI key").count()).toBe(0);
      expect(await page.getByTestId("voice-refine-on").getAttribute("aria-pressed")).toBe("true");

      // The dictionary is one field, a word per line, kept on this machine.
      const dictionary = page.getByTestId("voice-dictionary");
      await dictionary.fill("Kartik\nNovus Fleet\n\nKartik");
      await dictionary.blur();
      await page.getByTestId("voice-refine-off").click();
      await expect.poll(async () => page.getByTestId("voice-refine-off").getAttribute("aria-pressed")).toBe("true");
      await expect
        .poll(
          async () =>
            page.evaluate(async () => {
              const settings = await window.novus.dictation.settings();
              return settings.ok ? `${settings.value.refine}|${settings.value.dictionary.join(",")}` : settings.message;
            }),
          { timeout: 10_000 }
        )
        .toBe("false|Kartik,Novus Fleet");
      await page.getByTestId("voice-refine-on").click();
      await page.screenshot({ path: join(evidenceDir, "245-settings-voice.png") });

      // The chord is a rebindable row on the Keyboard page.
      await page.getByTestId("settings-page-keyboard").click();
      const row = page.getByTestId("key-dictate");
      await row.waitFor({ timeout: 10_000 });
      expect(await row.textContent()).toContain("⌘D");
      await page.getByTestId("settings-back").click();
    },
    120_000
  );
});
