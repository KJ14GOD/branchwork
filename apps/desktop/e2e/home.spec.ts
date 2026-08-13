import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

/**
 * The Home board in a real window (D-120): every active mission grouped by
 * what it needs, cards carrying the list's own facts, and the card's one
 * action landing INSIDE the thing that is asking — the blocked conversation
 * with its approval card on screen, which is the open-at instruction the
 * working set never took (the D-093 gap, closed). Also pinned here: Home is a
 * glance, not a purge — open tabs survive the visit.
 */

const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const evidenceDir = join(desktopRoot, "e2e", "evidence");
const CP_PORT = 4488;
const CP_URL = `http://127.0.0.1:${CP_PORT}`;
const DB_NAME = "novus_e2e_home";
const DB_URL = `postgres://novus:novus@127.0.0.1:5433/${DB_NAME}`;

let controlPlane: ChildProcess;
let app: ElectronApplication;
let page: Page;
let repoName: string;

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

/** Creates a mission from the ask-dialog and waits for its named settle. */
async function createMission(goal: string): Promise<void> {
  const projectRow = page.getByTestId("project-row").filter({ hasText: repoName });
  await projectRow.hover();
  await page.getByTestId("repo-new-mission").click();
  await page.getByTestId("new-mission-dialog").waitFor({ timeout: 30_000 });
  await page.getByTestId("new-mission-dialog").getByTestId("composer-input").fill(goal);
  await page.keyboard.press("Enter");
}

beforeAll(async () => {
  mkdirSync(evidenceDir, { recursive: true });
  const userDataDir = mkdtempSync(join(tmpdir(), "novus-home-"));

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

  const localRepoDir = mkdtempSync(join(tmpdir(), "novus-home-repo-"));
  repoName = basename(localRepoDir);
  git(localRepoDir, ["init", "-b", "main"]);
  writeFileSync(join(localRepoDir, "README.md"), "# home fixture\n");
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
      // Every fake turn stops at its permission question, so a blocked
      // mission is a stable fixture rather than a race.
      NOVUS_FAKE_HARNESS_APPROVAL: "1",
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
  await page.getByTestId("project-row").filter({ hasText: repoName }).waitFor({ timeout: 30_000 });

  // Mission one settles into Waiting: its turn asks, the question is answered
  // in the room, and the turn completes with a checkpoint — churn on the card.
  await createMission("ship the health endpoint");
  const approve = page.getByTestId("approval-approve");
  await approve.waitFor({ timeout: 90_000 });
  await approve.click();
  await page
    .getByTestId("trace-outcome")
    .filter({ hasText: "Turn completed" })
    .waitFor({ timeout: 90_000 });

  // Mission two stays blocked on its question: the board's Needs-you card.
  await createMission("block on the approval");
  await page.getByTestId("approval-approve").waitFor({ timeout: 90_000 });
}, 300_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  controlPlane?.kill("SIGTERM");
});

describe("the Home board (D-120)", () => {
  it(
    "groups missions by what they need, keeps the tabs, and opens at the thing that is asking",
    async () => {
      // Two tabs are open from creating the missions. Home is a glance, not a
      // purge: the board shows and the strip keeps both.
      await page.getByTestId("rail-home").click();
      await page.getByTestId("home-board").waitFor({ timeout: 20_000 });
      expect(await page.getByTestId("mission-tab").count()).toBe(2);

      // One mission, one card, exactly once — the first capture of this spec
      // caught a created mission carded twice out of a create-vs-poll race in
      // the shell's list state, fixed at the source (D-120).
      const carded = await page
        .getByTestId("board-card")
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-mission")));
      expect(carded.length).toBe(2);
      expect(new Set(carded).size).toBe(2);

      // The blocked mission is a Needs-you card wearing the attention in
      // words — the state, and the conversation it is asking in.
      const needsYou = page.getByTestId("board-column-needs_you");
      const blockedCard = needsYou
        .getByTestId("board-card")
        .filter({ hasText: "block on the approval" });
      await blockedCard.waitFor({ timeout: 20_000 });
      expect(await blockedCard.textContent()).toContain("waiting for an approval");
      expect(await blockedCard.textContent()).toContain(repoName);
      expect(await blockedCard.textContent()).toContain("has the baton");

      // The settled mission waits, carrying what its work touched as the
      // diff's own text arithmetic.
      const waitingCard = page
        .getByTestId("board-column-waiting")
        .getByTestId("board-card")
        .filter({ hasText: "ship the health endpoint" });
      await waitingCard.waitFor({ timeout: 20_000 });
      expect(await waitingCard.textContent()).toContain("+3");
      expect(await page.getByTestId("board-column-running").textContent()).toContain(
        "Nothing is running."
      );
      await page.screenshot({ path: join(evidenceDir, "127-home-board.png") });

      // The card's one action: open AT the asking thing. The room lands in
      // the blocked conversation with the question on screen — not wherever
      // the tab last was.
      await blockedCard.click();
      await page.getByTestId("approval-approve").waitFor({ timeout: 20_000 });
      expect(await page.getByTestId("approval-summary").textContent()).toContain(
        "NOVUS_FAKE_TURN.md"
      );
      await page.screenshot({ path: join(evidenceDir, "128-board-card-opens-at-the-question.png") });

      // And back: the board again, nothing purged, the strip intact.
      await page.getByTestId("rail-home").click();
      await page.getByTestId("home-board").waitFor({ timeout: 20_000 });
      expect(await page.getByTestId("mission-tab").count()).toBe(2);
    },
    180_000
  );

  it(
    "ends a mission from the room, freezes it as the receipt, and files it under Complete (D-121)",
    async () => {
      // Into the settled mission, from its own Waiting card.
      await page
        .getByTestId("board-column-waiting")
        .getByTestId("board-card")
        .filter({ hasText: "ship the health endpoint" })
        .click();
      await page.getByTestId("composer-input").waitFor({ timeout: 20_000 });

      // Ending lives with the machinery, behind a confirmation that states
      // the consequence and takes the person's own words.
      if ((await page.getByTestId("inspector").count()) === 0) {
        await page.getByTestId("panel-toggle").click();
      }
      await page.getByTestId("inspector").waitFor({ timeout: 20_000 });
      if ((await page.getByTestId("inspector-overview").count()) === 0) {
        await page.getByTestId("inspector-tab-overview").click();
      }
      await page.getByTestId("close-cancel").click();
      await page.getByTestId("close-reason").fill("The endpoint shipped by hand instead.");
      await page.getByTestId("close-cancel-confirm").click();

      // The room becomes the receipt: the terminal sentence, the frozen
      // document, and no composer — a terminal state never resumes.
      await page.getByTestId("receipt-view").waitFor({ timeout: 20_000 });
      const stateLine = page.getByTestId("state-line");
      expect(await stateLine.textContent()).toContain("Cancelled by spike-user");
      expect(await page.getByTestId("composer-input").count()).toBe(0);
      expect(await page.getByTestId("receipt-view").textContent()).toContain(
        "The endpoint shipped by hand instead."
      );
      expect(await page.getByTestId("close-ended").textContent()).toContain("receipt saved");
      await page.screenshot({ path: join(evidenceDir, "129-cancelled-receipt.png") });

      // The board files it under Complete — the fifth column the terminal
      // lifecycle finally earns — while the blocked mission stays Needs you.
      await page.getByTestId("rail-home").click();
      await page.getByTestId("home-board").waitFor({ timeout: 20_000 });
      const completeCard = page
        .getByTestId("board-column-complete")
        .getByTestId("board-card")
        .filter({ hasText: "ship the health endpoint" });
      await completeCard.waitFor({ timeout: 20_000 });
      expect(await completeCard.textContent()).toContain("cancelled by spike-user");
      expect(await page.getByTestId("board-column-waiting").textContent()).toContain(
        "Nothing is waiting."
      );
      await page.screenshot({ path: join(evidenceDir, "127-home-board.png") });
    },
    180_000
  );
});
