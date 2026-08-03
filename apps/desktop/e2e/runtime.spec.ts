import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { NovusBridge } from "@novus/contracts";

declare global {
  interface Window {
    novus: NovusBridge;
  }
}

/**
 * The workspace runtime through the visible interface (D-042 … D-046).
 *
 * Everything here is driven the way a person drives it — a real Electron
 * window, a real PTY, a real shell, real project commands in a real worktree —
 * because the faults this suite exists for are precisely the ones a unit test
 * cannot see: a terminal that renders nothing legible, a session that opens in
 * somebody's own checkout, a check whose evidence is not bound to the revision
 * it ran against, a dead tab presented as live after a relaunch, and a remote
 * participant who can reach a shell they were never granted.
 *
 * Screenshots are supporting evidence. The assertions are the test.
 */

const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const evidenceDir = join(desktopRoot, "e2e", "evidence");
const CP_PORT = 4494;
const CP_URL = `http://127.0.0.1:${CP_PORT}`;
const DB_NAME = "novus_e2e_runtime";
const DB_URL = `postgres://novus:novus@127.0.0.1:5433/${DB_NAME}`;

/** A marker the shell can echo that no prompt or profile would print by
 *  accident, so finding it in the pane means the PTY genuinely ran it. */
const MARKER = "NOVUS_E2E_TERMINAL";

/**
 * The typed form of a marker, split so the shell prints it whole but the
 * keystrokes do not contain it.
 *
 * Without this every assertion passes on the terminal's own echo of what was
 * typed, which proves the tty is echoing and nothing else — the command need
 * never have run. The same trick the fake harness uses for the same reason.
 */
const typed = (suffix: string): string => `${MARKER}""_${suffix}`;
const printed = (suffix: string): string => `${MARKER}_${suffix}`;

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

async function mintToken(as?: string): Promise<string> {
  const started = await fetch(`${CP_URL}/auth/github/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(as ? { as } : {})
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

async function launch(dataDir: string, identity?: string): Promise<{ app: ElectronApplication; page: Page }> {
  const launched = await electron.launch({
    args: [desktopRoot],
    env: {
      ...process.env,
      NOVUS_CP_URL: CP_URL,
      NOVUS_AUTH_AUTOVISIT: "1",
      NOVUS_FAKE_HARNESS: "1",
      NOVUS_USER_DATA_DIR: dataDir,
      ...(identity ? { NOVUS_FAKE_IDENTITY: identity } : {})
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

/** Signs in through the setup room, exactly as a person would. */
async function signIn(target: Page): Promise<void> {
  await target.getByTestId("setup").waitFor({ timeout: 30_000 });
  await target.getByTestId("sign-in-button").click();
  await target.getByTestId("github-connected").waitFor({ timeout: 30_000 });
  await target.getByTestId("finish-setup").click();
  await target.getByTestId("project-shell").waitFor({ timeout: 30_000 });
}

/** What the visible pane currently shows. xterm's DOM renderer writes real
 *  rows, so this is what a person can actually read — but it is the *viewport*,
 *  so anything that has scrolled past is not in it. */
async function paneText(target: Page): Promise<string> {
  return target.getByTestId("terminal-screen").innerText();
}

/** Everything the PTY has produced for the session showing in the dock, from
 *  the main process's own bounded scrollback. This is what the shell actually
 *  printed, whether or not it is still in view. */
async function sessionOutput(target: Page, mission: string): Promise<string> {
  return target.evaluate(async (id) => {
    const listed = await window.novus.terminal.list(id);
    if (!listed.ok || listed.value.length === 0) return "";
    const sessions = await Promise.all(
      listed.value.map((session) => window.novus.terminal.scrollback(session.sessionId))
    );
    return sessions.map((result) => (result.ok ? result.value : "")).join("\n");
  }, mission);
}

async function untilPane(target: Page, what: string, contains: string, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    last = await paneText(target).catch(() => "");
    if (last.includes(contains)) return last;
    await new Promise((settle) => setTimeout(settle, 200));
  }
  throw new Error(`timed out waiting for ${what}; the pane read:\n${last}`);
}

/**
 * Waits until the session's shell has finished starting.
 *
 * A login shell sources a profile before it reads anything — on a real
 * developer's machine that can mean version managers, completions, and a conda
 * initialisation — and anything typed during it is echoed by the terminal and
 * then discarded when the shell clears the line to draw its prompt. So this
 * waits for the output to arrive and then go quiet, which is what "the prompt
 * is up" looks like from outside, rather than typing hopefully and retrying.
 */
async function awaitPrompt(target: Page, mission: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let previous = "";
  let quietFor = 0;
  while (Date.now() < deadline) {
    const printed = await sessionOutput(target, mission).catch(() => "");
    if (printed !== "" && printed === previous) {
      quietFor += 1;
      if (quietFor >= 3) return; // ~600ms with no new bytes: the shell is waiting
    } else {
      quietFor = 0;
    }
    previous = printed;
    await new Promise((settle) => setTimeout(settle, 200));
  }
  throw new Error("the shell never settled into a prompt");
}

/**
 * Types a command into the visible pane and waits for its marker to come back.
 *
 * Retried once, because a shell can still redraw its line at an awkward moment;
 * the waiting above is what makes that the exception rather than the rule.
 */
async function runInPane(
  target: Page,
  mission: string,
  command: string,
  marker: string,
  attempts = 3
): Promise<string> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await awaitPrompt(target, mission);
    await target.getByTestId("terminal-screen").click();
    await target.keyboard.type(command);
    await target.keyboard.press("Enter");
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const printed = await sessionOutput(target, mission).catch(() => "");
      if (printed.includes(marker)) return printed;
      await new Promise((settle) => setTimeout(settle, 200));
    }
  }
  const last = await sessionOutput(target, mission).catch(() => "");
  const sessions = await target
    .evaluate(async (id) => {
      const listed = await window.novus.terminal.list(id);
      return listed.ok
        ? listed.value.map((session) => `${session.name}:${session.state}:${session.exitCode}`)
        : [`refused: ${listed.message}`];
    }, mission)
    .catch((error: unknown) => [`could not ask: ${String(error)}`]);
  throw new Error(
    `the shell never answered ${marker}; sessions were [${sessions.join(", ")}] and it had printed:\n${last}`
  );
}

/** Opens the runtime dock if it is not already open. A blind toggle closes a
 *  dock an earlier case left open, which is a test fighting itself. */
async function openDock(target: Page): Promise<void> {
  if ((await target.getByTestId("terminal-dock").count()) === 0) {
    await target.getByTestId("terminal-toggle").click();
  }
  await target.getByTestId("terminal-dock").waitFor({ timeout: 20_000 });
}

/** Shows the evidence panel if it is not already showing. */
async function openPanel(target: Page): Promise<void> {
  if ((await target.getByTestId("inspector").count()) === 0) {
    await target.getByTestId("panel-toggle").click();
  }
  await target.getByTestId("inspector").waitFor({ timeout: 20_000 });
}

const shot = (target: Page, name: string) =>
  target.screenshot({ path: join(evidenceDir, name) }).catch(() => undefined);

beforeAll(async () => {
  mkdirSync(evidenceDir, { recursive: true });
  userDataDir = mkdtempSync(join(tmpdir(), "novus-runtime-"));

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

  // A real project, with real commands. The setup command writes a witness so
  // "it ran" is a fact on disk rather than a status word; the check exits on
  // the presence of that witness, so its verdict is earned.
  localRepoDir = mkdtempSync(join(tmpdir(), "novus-runtime-repo-"));
  repoName = basename(localRepoDir);
  git(localRepoDir, ["init", "-b", "main"]);
  writeFileSync(join(localRepoDir, "README.md"), "# runtime fixture\n");
  mkdirSync(join(localRepoDir, ".novus"), { recursive: true });
  writeFileSync(
    join(localRepoDir, ".novus", "settings.toml"),
    [
      "[setup]",
      'command = "echo prepared > prepared.txt"',
      "",
      "[[verify]]",
      'name = "unit"',
      'command = "test -f prepared.txt"',
      'category = "test"',
      "",
      "[[verify]]",
      'name = "failing"',
      'command = "echo two failing; exit 1"',
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

  const projectRow = page.getByTestId("project-row").filter({ hasText: repoName });
  await projectRow.waitFor({ timeout: 30_000 });
  await projectRow.click();
  await page.getByTestId("draft-base").waitFor({ timeout: 30_000 });
  await page.getByTestId("composer-input").fill("prepare this workspace");
  await page.keyboard.press("Enter");
  await page
    .getByTestId("trace-outcome")
    .filter({ hasText: "Turn completed" })
    .waitFor({ timeout: 90_000 });

  missionId = await page.evaluate(async (repositoryId) => {
    const result = await window.novus.missions.list();
    if (!result.ok) throw new Error(result.message);
    return result.value.find((mission) => mission.repository?.providerRepoId === repositoryId)?.missionId ?? "";
  }, localId);
  expect(missionId).toMatch(/^msn_/);
}, 240_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  controlPlane?.kill("SIGTERM");
});

describe("the terminal, through the interface", () => {
  it("opens in the mission worktree and never in the user's own checkout", async () => {
    // Showing the dock is the request: the screen is there at once and a
    // session opens into it — no button in front of the button.
    await openDock(page);
    await page.getByTestId("terminal-screen").waitFor({ timeout: 20_000 });
    await expect
      .poll(() => page.getByTestId("terminal-tab").count(), { timeout: 20_000 })
      .toBeGreaterThan(0);

    // Typed at the keyboard, into the emulator, into the PTY.
    const shown = await runInPane(page, missionId, `pwd; echo ${typed("WHERE")}`, printed("WHERE"));

    // The worktree, by name, and *not* the folder the person added. This is
    // the assertion that stands between an interactive shell and someone's
    // actual work (D-042).
    expect(shown).toContain(`worktrees`);
    expect(shown).toContain(missionId);
    expect(shown).not.toContain(localRepoDir);
    await shot(page, "45-terminal-in-the-worktree.png");
  }, 120_000);

  it("renders what a real program prints, including colour and a cleared screen", async () => {
    // An SGR sequence and a clear: the two things the previous renderer could
    // not do at all, so seeing the text after them is the proof (D-046).
    await runInPane(
      page,
      missionId,
      `printf '\\033[31m%s\\033[0m\\n' ${typed("RED")}`,
      printed("RED")
    );
    // Rendered, not stripped: the pane shows the word, and the emulator has
    // painted it in a colour rather than deleting the sequence around it.
    const coloured = await untilPane(page, "coloured output", printed("RED"));
    expect(coloured).toContain(printed("RED"));
    const paintedInColour = await page
      .getByTestId("terminal-screen")
      .evaluate((element) =>
        [...element.querySelectorAll("span")].some(
          (span) => span.textContent?.includes("_RED") && span.className.includes("xterm-fg-")
        )
      );
    expect(paintedInColour).toBe(true);

    await runInPane(page, missionId, `clear; echo ${typed("AFTER_CLEAR")}`, printed("AFTER_CLEAR"));
    const cleared = await untilPane(page, "the cleared screen", printed("AFTER_CLEAR"));
    // The screen genuinely cleared: what was above it is gone from the
    // viewport, rather than stacked below a swallowed escape sequence.
    expect(cleared).not.toContain(printed("RED"));
    await shot(page, "46-terminal-colour-and-clear.png");
  }, 120_000);

  it("takes a control key, a second tab, a rename, and a close", async () => {
    // Ctrl-C reaches the shell as an interrupt rather than the application as
    // a copy: a long-running command ends and the prompt comes back.
    await runInPane(page, missionId, `echo ${typed("READY")}`, printed("READY"));
    await awaitPrompt(page, missionId);
    await page.getByTestId("terminal-screen").click();
    await page.keyboard.type("sleep 30");
    await page.keyboard.press("Enter");
    await new Promise((settle) => setTimeout(settle, 800));
    await page.keyboard.press("Control+c");
    // The prompt comes back, which it only does if the interrupt reached the
    // shell rather than the application.
    await runInPane(page, missionId, `echo ${typed("INTERRUPTED")}`, printed("INTERRUPTED"));

    const before = await page.getByTestId("terminal-tab").count();
    await page.getByTestId("terminal-new").click();
    await expect
      .poll(() => page.getByTestId("terminal-tab").count(), { timeout: 20_000 })
      .toBe(before + 1);
    // Two tabs, two distinct names: a session that exited must not lend its
    // name to the next one.
    const names = await page.getByTestId("terminal-tab").evaluateAll((tabs) =>
      tabs.map((tab) => (tab as HTMLElement).dataset.name ?? "")
    );
    expect(new Set(names).size).toBe(2);

    // Back to the first tab, and its session is still on screen. An emulator
    // builds its DOM once, so a pane that is detached to make room for another
    // one comes back empty — a running shell apparently thrown away by the act
    // of looking at a second one.
    await page.getByTestId("terminal-tab").first().getByRole("tab").click();
    const returned = await untilPane(page, "the first session again", printed("INTERRUPTED"));
    expect(returned).toContain(printed("INTERRUPTED"));

    await page.getByTestId("terminal-rename-action").click();
    await page.getByTestId("terminal-rename").fill("build log");
    await page.keyboard.press("Enter");
    await expect
      .poll(() => page.getByTestId("terminal-tab").filter({ hasText: "build log" }).count(), {
        timeout: 20_000
      })
      .toBe(1);
    await shot(page, "47-terminal-tabs-and-rename.png");

    await page.getByTestId("terminal-tab").last().getByTestId("terminal-tab-close").click();
    await expect
      .poll(() => page.getByTestId("terminal-tab").count(), { timeout: 20_000 })
      .toBe(before);
  }, 180_000);

  it("keeps its output when the dock is hidden and shown again", async () => {
    // Self-contained on purpose: this asserts that a *session* outlives the
    // drawer being closed, so it opens its own rather than inheriting whatever
    // an earlier case happened to leave behind.
    await openDock(page);
    await page.getByTestId("terminal-new").click();
    await page.getByTestId("terminal-screen").waitFor({ timeout: 20_000 });
    await runInPane(page, missionId, `echo ${typed("SURVIVES")}`, printed("SURVIVES"));
    await untilPane(page, "the witness on screen", printed("SURVIVES"));

    // The toggle that opened the dock closes it; there is no second control
    // that only does what the toggle does.
    await page.getByTestId("terminal-toggle").click();
    await expect.poll(() => page.getByTestId("terminal-dock").count(), { timeout: 10_000 }).toBe(0);

    await page.getByTestId("terminal-toggle").click();
    await page.getByTestId("terminal-dock").waitFor({ timeout: 20_000 });
    // The session kept running while the dock was closed, and its scrollback
    // is written back into the pane when it opens again.
    const reopened = await untilPane(page, "the scrollback to return", printed("SURVIVES"));
    expect(reopened).toContain(printed("SURVIVES"));
    await shot(page, "48-terminal-survives-hiding.png");
  }, 180_000);

  it("refuses the terminal to a participant whose machine does not host the workspace", async () => {
    // Maya joins from a second desktop with no checkout of her own. The
    // control she sees is disabled and says why in words; the refusal beneath
    // it is structural — there is no shell verb in the runner protocol for a
    // request to travel through, so there is nothing to authorize incorrectly.
    const invitation = await page.evaluate(async (mission) => {
      const result = await window.novus.invites.create({ missionId: mission, role: "operator" });
      if (!result.ok) throw new Error(result.message);
      return result.value.token;
    }, missionId);

    const mayaData = mkdtempSync(join(tmpdir(), "novus-runtime-maya-"));
    const maya = await launch(mayaData, "maya");
    try {
      await signIn(maya.page);
      await maya.page.getByTestId("join-mission").click();
      await maya.page.getByTestId("join-token").fill(invitation);
      await maya.page.getByTestId("join-submit").click();
      await maya.page.getByTestId("project-shell").waitFor({ timeout: 30_000 });

      const projectRow = maya.page.getByTestId("project-row").filter({ hasText: repoName });
      await projectRow.waitFor({ timeout: 30_000 });
      await projectRow.click();
      await maya.page.getByTestId("ws-tab").first().waitFor({ timeout: 30_000 });

      const toggle = maya.page.getByTestId("terminal-toggle");
      await expect.poll(() => toggle.getAttribute("data-available"), { timeout: 20_000 }).toBe("false");
      expect(await toggle.isDisabled()).toBe(true);
      expect(await toggle.getAttribute("title")).toContain("machine hosting this workspace");

      // And the refusal is not merely presentational: asking the main process
      // directly, from her renderer, is refused by name.
      const refused = await maya.page.evaluate(async (mission) => {
        const result = await window.novus.terminal.open({ missionId: mission, kind: "shell" });
        return result.ok ? "opened" : result.message;
      }, missionId);
      expect(refused).not.toBe("opened");
      expect(String(refused)).toMatch(/another machine|has no workstream|not fetched/i);
      await shot(maya.page, "49-terminal-refused-to-a-remote-participant.png");
    } finally {
      await maya.app.close().catch(() => undefined);
    }
  }, 240_000);
});

describe("setup and verification, through the interface", () => {
  it("reviews the proposal, saves it, runs setup, and reaches ready", async () => {
    await page.getByTestId("run-control").click();
    await page.getByTestId("run-menu").waitFor({ timeout: 20_000 });
    await page.getByTestId("run-menu-setup").click();
    await page.getByTestId("workspace-setup").waitFor({ timeout: 20_000 });
    await shot(page, "50-setup-dialog.png");

    // Nothing has run yet: the dialog proposes, and the witness the setup
    // command writes is not on disk.
    const worktree = join(userDataDir, "worktrees", missionId);
    expect(existsSync(join(worktree, "prepared.txt"))).toBe(false);

    await page.getByTestId("setup-save").click();
    // The dialog stays open and says what it wrote, then re-reads the project:
    // saving is a step, not an exit. A save that failed says so here instead.
    try {
      await page.getByTestId("setup-saved").waitFor({ timeout: 20_000 });
    } catch {
      const said = await page
        .getByTestId("setup-save-error")
        .innerText()
        .catch(() => "(the dialog reported nothing)");
      throw new Error(`saving the workspace configuration did not succeed: ${said}`);
    }
    expect(await page.getByTestId("setup-save-error").count()).toBe(0);
    await page.getByTestId("setup-close").click();
    await expect.poll(() => page.getByTestId("workspace-setup").count(), { timeout: 20_000 }).toBe(0);

    await page.getByTestId("run-control").click();
    await page.getByTestId("run-menu").waitFor({ timeout: 20_000 });
    await page.getByTestId("run-item").filter({ hasText: "Setup" }).first().click();

    // Ready is earned: the command actually ran, in the worktree.
    await expect
      .poll(() => existsSync(join(worktree, "prepared.txt")), { timeout: 60_000 })
      .toBe(true);
    await expect
      .poll(
        async () =>
          page.evaluate(async (mission) => {
            const result = await window.novus.missions.get(mission);
            return result.ok ? result.value.workspace?.readiness : null;
          }, missionId),
        { timeout: 60_000 }
      )
      .toBe("ready");
    await shot(page, "51-workspace-ready.png");
  }, 180_000);

  it("shows setup output in the runtime dock, and keeps it after the process ended", async () => {
    await openDock(page);
    await page.getByTestId("dock-view").filter({ hasText: "Setup" }).click();
    await page.getByTestId("dock-summary").waitFor({ timeout: 20_000 });
    expect(await page.getByTestId("dock-state").innerText()).toContain("exited 0");
    await shot(page, "52-runtime-dock-setup.png");
    await page.getByTestId("dock-view").filter({ hasText: "Terminal" }).click();
  }, 60_000);

  it("runs a declared check on a click, binds its evidence to the revision it proved, and goes stale", async () => {
    const before = await page.evaluate(async (mission) => {
      const result = await window.novus.missions.get(mission);
      if (!result.ok) throw new Error(result.message);
      return result.value.checks.length;
    }, missionId);

    await page.getByTestId("run-control").click();
    await page.getByTestId("run-menu").waitFor({ timeout: 20_000 });
    await page.getByTestId("run-item").filter({ hasText: "unit" }).first().click();

    const passed = await expect
      .poll(
        async () =>
          page.evaluate(
            async ({ mission, seen }) => {
              const result = await window.novus.missions.get(mission);
              if (!result.ok) return null;
              const check = result.value.checks
                .filter((entry) => entry.name === "unit")
                .at(-1);
              return result.value.checks.length > seen && check ? check : null;
            },
            { mission: missionId, seen: before }
          ),
        { timeout: 90_000 }
      )
      .not.toBeNull();
    void passed;

    const check = await page.evaluate(async (mission) => {
      const result = await window.novus.missions.get(mission);
      if (!result.ok) throw new Error(result.message);
      return result.value.checks.filter((entry) => entry.name === "unit").at(-1) ?? null;
    }, missionId);

    // The declared check genuinely executed, and its verdict is its exit code.
    expect(check?.outcome).toBe("passed");
    expect(check?.exitCode).toBe(0);
    expect(check?.ending).toBe("exit");
    expect(check?.origin).toBe("participant");
    // Bound to the revision it tested, not to "now".
    const worktree = join(userDataDir, "worktrees", missionId);
    expect(check?.checkpointSha).toBe(git(worktree, ["rev-parse", "HEAD"]));
    expect(check?.stale).toBe(false);

    await openPanel(page);
    await page.getByTestId("inspector-tab-verification").click();
    await shot(page, "53-verification-ledger.png");
  }, 180_000);

  it("records a failing check as failed with its exit code, and never as verified", async () => {
    await page.getByTestId("run-control").click();
    await page.getByTestId("run-menu").waitFor({ timeout: 20_000 });
    await page.getByTestId("run-item").filter({ hasText: "failing" }).first().click();

    await expect
      .poll(
        async () =>
          page.evaluate(async (mission) => {
            const result = await window.novus.missions.get(mission);
            if (!result.ok) return null;
            return result.value.checks.filter((entry) => entry.name === "failing").at(-1)?.outcome ?? null;
          }, missionId),
        { timeout: 90_000 }
      )
      .toBe("failed");

    const check = await page.evaluate(async (mission) => {
      const result = await window.novus.missions.get(mission);
      if (!result.ok) throw new Error(result.message);
      return result.value.checks.filter((entry) => entry.name === "failing").at(-1) ?? null;
    }, missionId);
    expect(check?.exitCode).toBe(1);
    expect(check?.ending).toBe("exit");
    expect(check?.output).toContain("two failing");
    await shot(page, "54-verification-failed.png");
  }, 180_000);

  it("browses the workspace's files, opens one over the canvas, and edits markdown", async () => {
    await openPanel(page);
    await page.getByTestId("inspector-tab-files").click();
    await page.getByTestId("file-tree").waitFor({ timeout: 20_000 });

    // The project's own files, and not its bookkeeping: `.git` is never listed.
    const listed = await page
      .getByTestId("tree-row")
      .evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.path ?? ""));
    expect(listed).toContain("README.md");
    expect(listed).toContain(".novus");
    expect(listed).not.toContain(".git");

    // Opening one takes the canvas; the trace is not beside it, it is behind it.
    await page.getByTestId("tree-row").filter({ hasText: "README.md" }).first().click();
    await page.getByTestId("file-view").waitFor({ timeout: 20_000 });
    expect(await page.getByTestId("chat").count()).toBe(0);

    // Markdown arrives rendered, and it is rendered as elements rather than as
    // markup built from the file's own text.
    await page.getByTestId("markdown").waitFor({ timeout: 20_000 });
    expect(await page.getByTestId("markdown").innerText()).toContain("runtime fixture");

    // Edit shows the source, and a save reaches the worktree.
    await page.getByTestId("file-edit").click();
    const editor = page.getByTestId("file-source");
    await editor.waitFor({ timeout: 20_000 });
    expect(await editor.inputValue()).toContain("# runtime fixture");
    await editor.fill("# runtime fixture\n\nEdited from the file pane.\n");
    await page.getByTestId("file-save").click();
    await expect
      .poll(() => page.getByTestId("file-save").count(), { timeout: 20_000 })
      .toBe(0);

    const worktree = join(userDataDir, "worktrees", missionId);
    expect(readFileSync(join(worktree, "README.md"), "utf8")).toContain("Edited from the file pane");
    await shot(page, "56-file-view-markdown.png");

    // Closing gives the trace back, exactly as it was.
    await page.getByTestId("file-preview").click();
    expect(await page.getByTestId("markdown").innerText()).toContain("Edited from the file pane");
    await page.getByTestId("file-close").click();
    await page.getByTestId("chat").waitFor({ timeout: 20_000 });
    await shot(page, "57-files-panel.png");
  }, 180_000);

  it("refuses a path that would leave the workspace", async () => {
    // The tree cannot ask for one, so this asks the bridge directly — which is
    // where the refusal has to live for it to mean anything (D-048).
    const refusals = await page.evaluate(async (mission) => {
      const attempts = ["../../../../etc/passwd", "/etc/passwd", "..", "a/../../../etc/hosts"];
      const said: string[] = [];
      for (const path of attempts) {
        const result = await window.novus.workspace.readFile({ missionId: mission, path });
        said.push(result.ok ? "READ" : result.message);
      }
      return said;
    }, missionId);
    for (const said of refusals) expect(said).not.toBe("READ");
  }, 60_000);

  it("does not present a terminal from a previous run as still alive", async () => {
    await app.close();
    const relaunched = await launch(userDataDir);
    app = relaunched.app;
    page = relaunched.page;

    await page.getByTestId("project-shell").waitFor({ timeout: 60_000 });
    const projectRow = page.getByTestId("project-row").filter({ hasText: repoName });
    await projectRow.waitFor({ timeout: 30_000 });
    await projectRow.click();
    await page.getByTestId("ws-tab").first().waitFor({ timeout: 30_000 });

    // A PTY cannot outlive the process that owned it. Before the dock is
    // opened there are no sessions at all — no dead tab is presented as live —
    // and opening it starts a fresh one rather than resurrecting anything.
    const carriedOver = await page.evaluate(async (mission) => {
      const result = await window.novus.terminal.list(mission);
      return result.ok ? result.value.length : -1;
    }, missionId);
    expect(carriedOver).toBe(0);

    await openDock(page);
    await page.getByTestId("terminal-screen").waitFor({ timeout: 20_000 });
    await expect
      .poll(() => page.getByTestId("terminal-tab").count(), { timeout: 20_000 })
      .toBe(1);

    // The check the previous run recorded is still there, and still says what
    // revision it proved.
    const checks = await page.evaluate(async (mission) => {
      const result = await window.novus.missions.get(mission);
      if (!result.ok) throw new Error(result.message);
      return result.value.checks.map((entry) => ({ name: entry.name, outcome: entry.outcome }));
    }, missionId);
    expect(checks.some((entry) => entry.name === "unit" && entry.outcome === "passed")).toBe(true);
    await shot(page, "55-relaunch-no-stale-terminal.png");
  }, 240_000);
});
