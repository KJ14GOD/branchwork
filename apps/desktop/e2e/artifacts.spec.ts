import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Artifact, NovusBridge } from "@novus/contracts";

declare global {
  interface Window {
    novus: NovusBridge;
  }
}

/**
 * Durable visual evidence, driven end to end (D-122, D-123).
 *
 * A real Electron window, a real project serving a real page in the embedded
 * preview, and a deterministic store behind the control plane — the local
 * adapter, which really signs, really hashes, and is never called live S3
 * proof. What a person does: run the app, open its preview, capture a
 * screenshot, find it in the Evidence section with its thumbnail actually
 * rendering (bytes through the artifact protocol, a fresh grant each time),
 * open it at reading size with its provenance and the honest claim. What an
 * agent does: ask for a capture through the `novus` tool, get a person's
 * approval, and the artifact lands attributed to its own execution and
 * conversation. What must refuse: a capture after the app stopped — a stale
 * preview is not evidence.
 */

const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const evidenceDir = join(desktopRoot, "e2e", "evidence");
const CP_PORT = 4499;
const CP_URL = `http://127.0.0.1:${CP_PORT}`;
const DB_NAME = "novus_e2e_artifacts";
const DB_URL = `postgres://novus:novus@127.0.0.1:5433/${DB_NAME}`;

let controlPlane: ChildProcess;
let userDataDir: string;
let localRepoDir: string;
let repoName: string;
let localId: string;
let missionId: string;
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

const shot = (target: Page, name: string) =>
  target.screenshot({ path: join(evidenceDir, name) }).catch(() => undefined);

async function artifactsOnWire(): Promise<Artifact[]> {
  return page.evaluate(async (id) => {
    const result = await window.novus.missions.get(id);
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    return result.value.artifacts;
  }, missionId);
}

/** Answers the one pending approval card in the window. */
async function approveOnce(): Promise<void> {
  const approve = page.getByTestId("approval-approve");
  await approve.waitFor({ timeout: 60_000 });
  await approve.click();
}

beforeAll(async () => {
  mkdirSync(evidenceDir, { recursive: true });
  userDataDir = mkdtempSync(join(tmpdir(), "novus-artifacts-"));

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
        NOVUS_DATABASE_URL: DB_URL,
        // The deterministic store: the local adapter on a scratch directory.
        NOVUS_ARTIFACT_STORE: "local",
        NOVUS_ARTIFACT_DIR: mkdtempSync(join(tmpdir(), "novus-artifact-store-")),
        NOVUS_ARTIFACT_SECRET: "e2e-artifact-secret"
      },
      stdio: "inherit"
    }
  );
  await waitForHealth();

  // The same honest fixture the preview spec runs: a loopback HTTP server on
  // the allocated port, readiness declared as a port probe (D-045, D-098).
  localRepoDir = mkdtempSync(join(tmpdir(), "novus-artifacts-repo-"));
  repoName = basename(localRepoDir);
  git(localRepoDir, ["init", "-b", "main"]);
  writeFileSync(join(localRepoDir, "README.md"), "# artifact fixture\n");
  writeFileSync(
    join(localRepoDir, "server.mjs"),
    [
      'import { createServer } from "node:http";',
      "const port = Number(process.env.NOVUS_PORT ?? 4600);",
      "const page = `<!doctype html><html><body style=\"background:#233\">",
      '<h1 id="title">Artifact fixture</h1>',
      '<div id="out">steady</div>',
      "</body></html>`;",
      "createServer((req, res) => {",
      '  res.setHeader("content-type", "text/html");',
      "  res.end(page);",
      '}).listen(port, "127.0.0.1");'
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
      "timeoutSeconds = 60"
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

  const launched = await electron.launch({
    args: [desktopRoot],
    env: {
      ...process.env,
      NOVUS_CP_URL: CP_URL,
      NOVUS_AUTH_AUTOVISIT: "1",
      NOVUS_FAKE_HARNESS: "1",
      // Every scripted turn asks before it acts, so both the person capture
      // and the agent-requested capture ride the real approval machinery.
      NOVUS_FAKE_HARNESS_APPROVAL: "1",
      NOVUS_USER_DATA_DIR: userDataDir
    }
  });
  app = launched;
  page = await launched.firstWindow();
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
  await page
    .getByTestId("new-mission-dialog")
    .getByTestId("composer-input")
    .fill("prove the page with visual evidence");
  await page.keyboard.press("Enter");
  // The scripted turn asks before writing; the person answers, once.
  await approveOnce();
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

  // Start the app and open its preview — the surface every capture is of.
  await page.getByTestId("run-control").click();
  await page.getByTestId("run-menu").waitFor();
  const appItem = page.getByTestId("run-item").filter({ hasText: "node server.mjs" });
  await appItem.waitFor({ timeout: 20_000 });
  await appItem.click();
  await page.getByTestId("run-live").waitFor({ timeout: 45_000 });
  await page.getByTestId("open-preview").click();
  await page.getByTestId("preview-surface").waitFor({ timeout: 20_000 });
  // expect.poll is test-only; the same wait, by hand. Two facts, separately:
  // the process's own word (D-045), and the page actually on screen — a
  // capture needs the second, and "running" never implies it.
  const deadline = Date.now() + 30_000;
  while ((await page.getByTestId("preview-word").textContent()) !== "running") {
    if (Date.now() > deadline) throw new Error("the preview never reached running");
    await new Promise((settle) => setTimeout(settle, 500));
  }
  await page
    .locator('[data-testid="preview-body"][data-phase="ready"]')
    .waitFor({ timeout: 30_000 });
}, 300_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  controlPlane?.kill("SIGTERM");
});

describe("durable visual evidence (D-122, D-123)", () => {
  it(
    "a person captures the live preview and the artifact carries its provenance",
    async () => {
      // The standing warning is at the capture point, before any capture.
      expect(await page.getByTestId("preview-capture-warning").textContent()).toContain(
        "may contain sensitive data"
      );

      await page.getByTestId("preview-capture").click();
      // A refusal renders as the surface's own note; failing with its words
      // beats failing with a timeout.
      await Promise.race([
        page.getByTestId("preview-captured").waitFor({ timeout: 30_000 }),
        page
          .locator(".preview-note")
          .waitFor({ timeout: 30_000 })
          .then(async () => {
            throw new Error(
              `capture refused: ${await page.locator(".preview-note").textContent()}`
            );
          })
      ]);
      expect(await page.getByTestId("preview-captured").textContent()).toContain("in Evidence");

      // The wire carries the artifact with its provenance, as evidence.
      const [artifact] = await artifactsOnWire();
      expect(artifact).toBeDefined();
      expect(artifact!.state).toBe("available");
      expect(artifact!.kind).toBe("screenshot");
      expect(artifact!.initiator).toBe("person");
      expect(artifact!.createdByLogin).toBeTruthy();
      expect(artifact!.label).toBe("Screenshot · app");
      expect(artifact!.origin).toContain("http://localhost:");
      expect(artifact!.readiness).toBe("ready");
      // The revision is the worktree's own HEAD at capture — the fake turn
      // committed, so it is the mission branch's head, clean.
      expect(artifact!.revisionSha).toMatch(/^[0-9a-f]{40}$/);
      expect(artifact!.revisionDirty).toBe(false);
      expect(artifact!.sessionId).toBeNull();
      expect(artifact!.executionId).toBeNull();

      // The Evidence section shows the restrained row, and the thumbnail's
      // bytes genuinely render through the artifact protocol: a fresh grant
      // was minted, spent, and never shown to the renderer.
      await page.getByTestId("panel-toggle").click();
      await page.getByTestId("inspector-tab-evidence").click();
      const row = page.getByTestId("evidence-row");
      await row.waitFor({ timeout: 20_000 });
      const thumb = row.locator("img.evidence-thumb");
      await thumb.waitFor({ timeout: 20_000 });
      await expect
        .poll(
          async () =>
            thumb.evaluate((element) => (element as HTMLImageElement).naturalWidth > 0),
          { timeout: 20_000 }
        )
        .toBe(true);
      await shot(page, "130-evidence-section.png");

      // Opening the row puts the artifact on the canvas at reading size, with
      // the provenance ledger and the honest claim.
      await row.click();
      await page.getByTestId("artifact-view").waitFor({ timeout: 20_000 });
      const image = page.getByTestId("artifact-image");
      await image.waitFor({ timeout: 20_000 });
      await expect
        .poll(
          async () =>
            image.evaluate((element) => (element as HTMLImageElement).naturalWidth > 0),
          { timeout: 20_000 }
        )
        .toBe(true);
      expect(await page.getByTestId("artifact-claim").textContent()).toContain(
        "does not prove the application is correct"
      );
      const provenance = await page.getByTestId("artifact-provenance").textContent();
      expect(provenance).toContain(artifact!.revisionSha!);
      expect(provenance).toContain("local runner");
      expect(provenance).toContain("sha256");
      await shot(page, "131-artifact-view.png");
      await page.getByTestId("artifact-back").click();
      await page.getByTestId("artifact-view").waitFor({ state: "detached", timeout: 10_000 });
    },
    240_000
  );

  it(
    "an agent requests a capture through the novus tool, a person approves, and the artifact is the execution's own",
    async () => {
      // Back to the conversation canvas: the approval card lives in the
      // thread that raises it, and the preview tab was still selected.
      await page.getByTestId("room-tab").click();
      await page.getByTestId("chat").waitFor({ timeout: 20_000 });
      await page.getByTestId("composer-input").fill("[fake-ask:mcp__novus__capture_screenshot] show the room what the page looks like");
      await page.keyboard.press("Enter");

      // The request reaches the room as an ordinary approval card; the person
      // answers it once, for this act.
      await approveOnce();

      // The turn's own reply carries the endpoint's honest sentence.
      await page
        .getByTestId("chat")
        .getByText("does not prove the application is correct", { exact: false })
        .first()
        .waitFor({ timeout: 90_000 });
      await page
        .getByTestId("trace-outcome")
        .filter({ hasText: "Turn completed" })
        .last()
        .waitFor({ timeout: 90_000 });

      const all = await artifactsOnWire();
      expect(all).toHaveLength(2);
      const agentArtifact = all.find((artifact) => artifact.initiator === "agent");
      expect(agentArtifact).toBeDefined();
      expect(agentArtifact!.state).toBe("available");
      // Attributed to the execution that asked and its own conversation —
      // derived server-side, never claimed (D-123).
      expect(agentArtifact!.executionId).toBeTruthy();
      expect(agentArtifact!.sessionId).toMatch(/^csn_/);
      expect(agentArtifact!.createdByLogin).toBeNull();

      // Both rows in Evidence now.
      await expect
        .poll(async () => page.getByTestId("evidence-row").count(), { timeout: 20_000 })
        .toBe(2);
      await shot(page, "132-agent-capture.png");
    },
    240_000
  );

  it(
    "a capture of a stopped app is refused in words — a stale preview is not evidence",
    async () => {
      // Back on the preview canvas, stop the app from Run — the honest way.
      await page.getByTestId("preview-tab").click();
      await page.getByTestId("preview-surface").waitFor({ timeout: 20_000 });
      await page.getByTestId("stop-run").click();
      await expect
        .poll(async () => page.getByTestId("preview-word").textContent(), { timeout: 30_000 })
        .toBe("stopped");

      const refused = await page.evaluate(async (id) => {
        return window.novus.artifacts.capture({ missionId: id });
      }, missionId);
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.message).toMatch(/stale preview is not evidence|has ended|stopped/i);
      }

      // Nothing pending, nothing failed appeared as evidence: still two.
      const all = await artifactsOnWire();
      expect(all).toHaveLength(2);
      expect(all.every((artifact) => artifact.state === "available")).toBe(true);
    },
    120_000
  );
});
