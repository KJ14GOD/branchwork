import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { MissionDetailResponse, NovusBridge } from "@novus/contracts";

declare global {
  interface Window {
    novus: NovusBridge;
    __novusMutations?: number;
  }
}

/**
 * The click-everything audit (owner-asked, 2026-09-10: "play with this project
 * for at least two hours, touch every clickable button, check every page for
 * overflowing lines or lingering stuff"). Not a proof and not in the gate:
 * an opt-in walk of every surface the app has, at three window widths, that
 * writes a punch list rather than asserting one — what is clipped, what
 * folded into two lines when a phrase never should (DESIGN.md rule 21),
 * what reaches past the window, what a click did nothing visible for, what
 * the console said, and what error line was still standing after nothing
 * had asked for it. The state it walks is the richest the fakes can build:
 * a mission with a turn, an alternative, a decision, a pushed branch, and a
 * draft request against the fake host, exactly as `pr.spec.ts` builds it.
 *
 *   pnpm --filter @novus/desktop build
 *   NOVUS_AUDIT=1 NOVUS_AUDIT_OUT=/some/dir pnpm --filter @novus/desktop e2e e2e/audit.spec.ts
 */

const AUDIT = process.env.NOVUS_AUDIT === "1";
const OUT = process.env.NOVUS_AUDIT_OUT ?? join(tmpdir(), "novus-audit");
const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const CP_PORT = 4486;
const CP_URL = `http://127.0.0.1:${CP_PORT}`;
const DB_NAME = "novus_e2e_audit";
const DB_URL = `postgres://novus:novus@127.0.0.1:5433/${DB_NAME}`;
const PROVIDER_REPO = "9001";
const PROVIDER_HEAD = createHash("sha1").update("demo-app@main").digest("hex");
const WIDTHS = [1440, 1100, 760] as const;

let controlPlane: ChildProcess;
let userDataDir: string;
let fixtureDir: string;
let originDir: string;
let remote: { url: string; close: () => Promise<void> } | null = null;
let missionId: string;
let app: ElectronApplication;
let page: Page;

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
    .toString()
    .trim();

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

/** The loopback remote the push credential names (as in pr.spec.ts). */
async function startRemote(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const authorization = request.headers.authorization ?? "";
    if (!authorization.startsWith("Basic ")) {
      response.writeHead(401, { "www-authenticate": 'Basic realm="novus"' });
      response.end("authentication required");
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    const backend = spawn("git", ["http-backend"], {
      env: {
        PATH: process.env.PATH ?? "",
        GIT_PROJECT_ROOT: originDir,
        GIT_HTTP_EXPORT_ALL: "1",
        REQUEST_METHOD: request.method ?? "GET",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        REMOTE_USER: "x-access-token",
        REMOTE_ADDR: "127.0.0.1"
      }
    });
    request.pipe(backend.stdin);
    let head = Buffer.alloc(0);
    let headersDone = false;
    backend.stdout.on("data", (chunk: Buffer) => {
      if (headersDone) {
        response.write(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const split = head.indexOf("\r\n\r\n");
      if (split === -1) return;
      const headerText = head.subarray(0, split).toString("utf8");
      const rest = head.subarray(split + 4);
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of headerText.split("\r\n")) {
        const at = line.indexOf(":");
        if (at === -1) continue;
        const name = line.slice(0, at).trim();
        const value = line.slice(at + 1).trim();
        if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]) || 200;
        else headers[name] = value;
      }
      response.writeHead(status, headers);
      if (rest.length > 0) response.write(rest);
      headersDone = true;
    });
    backend.on("close", () => response.end());
    backend.on("error", () => {
      if (!headersDone) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((settle) => server.listen(0, "127.0.0.1", settle));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${port}/repo.git`, close: () => new Promise((settle) => server.close(() => settle())) };
}

const detail = (): Promise<MissionDetailResponse> =>
  page.evaluate(async (id) => {
    const result = await window.novus.missions.get(id);
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    return result.value;
  }, missionId);

async function until(what: string, predicate: (value: MissionDetailResponse) => boolean, timeoutMs = 90_000): Promise<MissionDetailResponse> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await detail();
    if (predicate(value)) return value;
    await new Promise((settle) => setTimeout(settle, 400));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function direct(body: string): Promise<void> {
  const sent = await page.evaluate(
    async (args) => {
      const result = await window.novus.missions.direct({ missionId: args.missionId, body: args.body } as Parameters<
        NovusBridge["missions"]["direct"]
      >[0]);
      return result.ok ? "ok" : `${result.code}: ${result.message}`;
    },
    { missionId, body }
  );
  expect(sent).toBe("ok");
}

// --- The findings -----------------------------------------------------------

interface Finding {
  surface: string;
  width: number;
  kind: "page-overflow" | "offscreen" | "clipped" | "folded" | "console" | "pageerror" | "dead-click" | "lingering";
  where: string;
  detail: string;
}
const findings: Finding[] = [];
const consoleLines: string[] = [];
let consoleCursor = 0;

const note = (finding: Finding) => {
  findings.push(finding);
};

const settle = (ms = 350) => new Promise((resolve) => setTimeout(resolve, ms));

/** What the DOM says about itself at this width: the overflow audit. */
async function auditDom(surface: string, width: number): Promise<void> {
  const report = await page.evaluate(() => {
    const out: { kind: string; where: string; detail: string }[] = [];
    const describe = (el: Element): string => {
      const id = el.getAttribute("data-testid");
      const cls = (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean).slice(0, 3).join(".");
      const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 70);
      return `${el.tagName.toLowerCase()}${id ? `[${id}]` : ""}${cls ? `.${cls}` : ""} “${text}”`;
    };
    const visible = (el: Element): boolean => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      const style = getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
    };
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth + 1) {
      out.push({ kind: "page-overflow", where: "document", detail: `scrollWidth ${root.scrollWidth} > ${root.clientWidth}` });
    }
    const all = Array.from(document.body.querySelectorAll<HTMLElement>("*"));
    for (const el of all) {
      if (!visible(el)) continue;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const ownText = Array.from(el.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => (node.textContent ?? "").trim())
        .join(" ")
        .trim();
      // A box entirely left of the window is the rail as an overlay, parked
      // off-canvas by design at narrow widths; what matters is the right edge.
      if (rect.right > window.innerWidth + 1) {
        // Inside a strip that scrolls sideways — terminal tabs, a wide ledger —
        // a box past the edge is reached by scrolling, which is the design
        // (DESIGN.md#overflow); only a box no scroll can reach is lost.
        let scrolls = false;
        for (let parent = el.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
          const overflowX = getComputedStyle(parent).overflowX;
          if (overflowX === "auto" || overflowX === "scroll") {
            const box = parent.getBoundingClientRect();
            if (rect.right <= box.left + parent.scrollWidth + 1) scrolls = true;
            break;
          }
        }
        if (!scrolls && style.position !== "fixed" && style.position !== "absolute") {
          out.push({ kind: "offscreen", where: describe(el), detail: `left ${Math.round(rect.left)}, right ${Math.round(rect.right)}, window ${window.innerWidth}` });
        }
      }
      if (ownText.length > 0 && el.scrollWidth > el.clientWidth + 1 && (style.overflowX === "hidden" || style.overflowX === "clip")) {
        out.push({ kind: "clipped", where: describe(el), detail: `${el.scrollWidth - el.clientWidth}px hidden${style.textOverflow === "ellipsis" ? " (ellipsis)" : ""}` });
      }
      const singleLine =
        el.matches(
          "button, [role='button'], .chip-button, .segment-tab, .mission-tab, .lane-tab, .settings-nav-item, .state-line, .composer-foot > *, .chip, [class*='chip'], [class*='-tab'], .card-row-title, .settings-card-value, [data-testid$='-row'] > *:first-child"
        ) && !el.matches("textarea, pre, code, p, .composer-input");
      if (singleLine && ownText.length > 0 && !ownText.includes("\n") && style.whiteSpace !== "pre-wrap") {
        // The text's own line boxes, not the element's height: a padded tab
        // is tall and still one line; a folded phrase has two boxes.
        // Boxes on one line can still differ in top by a few pixels — a
        // glyph centred beside its text, a caret — so tops are clustered by
        // the line height before they count as lines.
        const range = document.createRange();
        range.selectNodeContents(el);
        const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4 || 16;
        const tops = Array.from(range.getClientRects())
          .filter((box) => box.width > 0 && box.height > 0)
          .map((box) => box.top)
          .sort((a, b) => a - b);
        let lines = tops.length > 0 ? 1 : 0;
        for (let i = 1; i < tops.length; i += 1) {
          if (tops[i] - tops[i - 1] > lineHeight * 0.6) lines += 1;
        }
        if (lines > 1) {
          out.push({ kind: "folded", where: describe(el), detail: `${lines} lines` });
        }
      }
    }
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("[role='alert'], .inline-error"))) {
      // The kit shows an inline refusal as a sample (D-254); it is not standing.
      if (el.classList.contains("kit-inline")) continue;
      if (visible(el)) out.push({ kind: "lingering", where: describe(el), detail: "an error line is standing" });
    }
    return out;
  });
  for (const entry of report) note({ surface, width, kind: entry.kind as Finding["kind"], where: entry.where, detail: entry.detail });
}

async function drainConsole(surface: string, width: number): Promise<void> {
  for (const line of consoleLines.slice(consoleCursor)) {
    note({ surface, width, kind: line.startsWith("pageerror") ? "pageerror" : "console", where: "console", detail: line.slice(0, 200) });
  }
  consoleCursor = consoleLines.length;
}

async function resize(width: number): Promise<void> {
  await app.evaluate(async ({ BrowserWindow }, w) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(w, 900);
  }, width);
  await settle(400);
}

const safeName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Looks at one surface at every width: audit, screenshot, console. */
async function look(surface: string): Promise<void> {
  for (const width of WIDTHS) {
    await resize(width);
    await auditDom(surface, width);
    await drainConsole(surface, width);
    await page.screenshot({ path: join(OUT, `${safeName(surface)}-${width}.png`) }).catch(() => undefined);
  }
  await resize(1440);
}

/** Presses everything pressable on the surface, once, and watches what it did. */
async function pressEverything(surface: string, deny: RegExp, keepOpen = false): Promise<void> {
  await page.evaluate(() => {
    window.__novusMutations = 0;
    const observer = new MutationObserver((records) => {
      window.__novusMutations = (window.__novusMutations ?? 0) + records.length;
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  const targets = await page.evaluate(() => {
    const seen = new Set<string>();
    const out: { key: string; label: string }[] = [];
    const nodes = Array.from(document.querySelectorAll<HTMLElement>("button, [role='button'], [role='tab'], [role='menuitem'], a[href]"));
    for (const el of nodes) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if ((el as HTMLButtonElement).disabled) continue;
      // Under a scrim, or already the active one: a click would do nothing by design.
      const centre = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (centre && !el.contains(centre) && !centre.contains(el)) continue;
      if (el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-pressed") === "true" || el.getAttribute("aria-current") === "page") continue;
      const id = el.getAttribute("data-testid");
      // A native folder picker would block the window; the walk cannot see it.
      if (id === "open-repository" || id === "attach-image") continue;
      const label = (el.getAttribute("aria-label") ?? el.getAttribute("title") ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 50);
      const key = id ? `testid:${id}` : `text:${label}`;
      if (seen.has(key) || label.length === 0 && !id) continue;
      seen.add(key);
      out.push({ key, label: id ? `${id} “${label}”` : label });
    }
    return out.slice(0, 80);
  });
  for (const target of targets) {
    if (deny.test(target.label)) continue;
    const locator = target.key.startsWith("testid:")
      ? page.getByTestId(target.key.slice("testid:".length)).first()
      : page.locator("button, [role='button'], [role='tab'], [role='menuitem'], a[href]").filter({ hasText: target.key.slice("text:".length) }).first();
    try {
      if (!(await locator.isVisible({ timeout: 500 }))) continue;
      const before = await page.evaluate(() => window.__novusMutations ?? 0);
      const url = page.url();
      await locator.click({ timeout: 2_000, force: false });
      await settle(450);
      const after = await page.evaluate(() => window.__novusMutations ?? 0);
      if (after === before && page.url() === url) {
        note({ surface, width: 1440, kind: "dead-click", where: target.label, detail: "nothing in the DOM changed within 450 ms" });
      }
      await auditDom(`${surface} › ${target.label}`, 1440);
      await drainConsole(`${surface} › ${target.label}`, 1440);
      // Back out of whatever opened: a menu, a dialog, a flyout — unless the
      // surface itself is a dialog, which Escape would close.
      if (!keepOpen) await page.keyboard.press("Escape").catch(() => undefined);
      await settle(120);
      if (await page.getByTestId("dialog-scrim").first().isVisible({ timeout: 200 }).catch(() => false)) {
        await page.getByTestId("dialog-scrim").first().click({ timeout: 1_000 }).catch(() => undefined);
        await settle(150);
      }
    } catch (error) {
      note({ surface, width: 1440, kind: "console", where: target.label, detail: `click failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}` });
    }
  }
}

const DENY = /sign out|quit|remove|delete|archive|stop|cancel|discard|merge|push|create|send|record|choose|confirm|finish|restart|close|request|approve|deny|ready|revert|reset|disconnect|open on github|open in|external/i;

async function goHome(): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const closers = page.getByTestId("mission-tab-close");
    if ((await closers.count()) === 0) break;
    await closers.first().click({ timeout: 2_000 }).catch(() => undefined);
    await settle(200);
  }
  await page.getByTestId("home-board").waitFor({ timeout: 20_000 }).catch(() => undefined);
}

/** Puts the room back the way a person left it: rail open, project
 *  disclosed, the mission active — pressing everything toggles all three. */
async function restoreRoom(): Promise<void> {
  await page.keyboard.press("Escape").catch(() => undefined);
  if (!(await page.getByTestId("rail-home").isVisible({ timeout: 800 }).catch(() => false))) {
    await page.keyboard.press("Meta+b").catch(() => undefined);
    await settle(300);
  }
  await openMission().catch(() => undefined);
}

async function openMission(): Promise<void> {
  const group = page.locator(".side-group", { has: page.getByTestId("project-row").filter({ hasText: "novus/demo-app" }) });
  await group.waitFor({ timeout: 30_000 });
  if ((await group.getByTestId("project-twisty").getAttribute("aria-expanded")) !== "true") {
    await group.getByTestId("project-row").click();
  }
  const missionRow = group.getByTestId("mission-row").first();
  if (!(((await missionRow.getAttribute("class")) ?? "").includes("active-mission"))) await missionRow.click();
  await page.getByTestId("state-line").waitFor({ timeout: 30_000 });
}

function writeReport(): string {
  const lines: string[] = ["# Click-everything audit", "", `Written ${new Date().toISOString()}. Screenshots beside this file.`, ""];
  const kinds: Finding["kind"][] = ["pageerror", "console", "page-overflow", "offscreen", "folded", "clipped", "lingering", "dead-click"];
  for (const kind of kinds) {
    const of = findings.filter((entry) => entry.kind === kind);
    lines.push(`## ${kind} (${of.length})`, "");
    const seen = new Set<string>();
    for (const entry of of) {
      const key = `${entry.where}|${entry.detail}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const widths = of.filter((other) => other.where === entry.where && other.detail === entry.detail).map((other) => other.width);
      lines.push(`- **${entry.surface}** at ${[...new Set(widths)].join("/")}: ${entry.where} — ${entry.detail}`);
    }
    lines.push("");
  }
  const text = lines.join("\n");
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "REPORT.md"), text);
  return text;
}

beforeAll(async () => {
  if (!AUDIT) return;
  mkdirSync(OUT, { recursive: true });
  userDataDir = mkdtempSync(join(tmpdir(), "novus-audit-"));
  const pg = await import("pg");
  const admin = new pg.default.Pool({ connectionString: "postgres://novus:novus@127.0.0.1:5433/novus" });
  if ((await admin.query(`select 1 from pg_database where datname='${DB_NAME}'`)).rowCount === 0) await admin.query(`create database ${DB_NAME}`);
  await admin.end();
  const scrub = new pg.default.Pool({ connectionString: DB_URL });
  await scrub.query("drop schema public cascade; create schema public;");
  await scrub.end();

  const bare = mkdtempSync(join(tmpdir(), "novus-audit-origin-"));
  originDir = bare;
  git(bare, ["init", "--bare", join(bare, "repo.git")]);
  git(join(bare, "repo.git"), ["config", "http.receivepack", "true"]);
  remote = await startRemote();
  controlPlane = spawn(process.execPath, ["--experimental-strip-types", join(repoRoot, "apps", "control-plane", "src", "main.ts")], {
    env: { ...process.env, NOVUS_FAKE_GITHUB: "1", NOVUS_CP_PORT: String(CP_PORT), NOVUS_DATABASE_URL: DB_URL, NOVUS_FAKE_PUSH_REMOTE: remote.url, NOVUS_PR_SWEEP_MS: "1500" },
    stdio: "ignore"
  });
  await waitForHealth();

  fixtureDir = mkdtempSync(join(tmpdir(), "novus-audit-repo-"));
  git(fixtureDir, ["init", "-b", "main"]);
  writeFileSync(join(fixtureDir, "README.md"), "# audit fixture\n");
  mkdirSync(join(fixtureDir, "src"), { recursive: true });
  writeFileSync(join(fixtureDir, "src", "index.ts"), "export const answer = 42;\n");
  git(fixtureDir, ["add", "-A"]);
  git(fixtureDir, ["-c", "user.name=T", "-c", "user.email=t@l", "commit", "-m", "fixture"]);

  const token = await mintToken();
  const created = await fetch(`${CP_URL}/missions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      goal: "Ship the session guard for the audit, with a goal long enough to test how titles fold in the rail and the strip",
      successCriteria: "Every surface looked at",
      provider: "github",
      providerRepoId: PROVIDER_REPO,
      baseRef: "main",
      baseSha: PROVIDER_HEAD,
      creationKey: randomUUID()
    })
  });
  expect(created.ok).toBe(true);
  const body = (await created.json()) as { mission: { missionId: string }; workstream: { workstreamId: string; missionBranch: string } };
  missionId = body.mission.missionId;
  git(fixtureDir, ["branch", body.workstream.missionBranch]);
  writeFileSync(join(userDataDir, "local-repos.json"), JSON.stringify({ [PROVIDER_REPO]: fixtureDir }));

  app = await electron.launch({
    args: [desktopRoot],
    env: { ...process.env, NOVUS_CP_URL: CP_URL, NOVUS_AUTH_AUTOVISIT: "1", NOVUS_FAKE_HARNESS: "1", NOVUS_FAKE_CONNECTORS: "[]", NOVUS_USER_DATA_DIR: userDataDir }
  });
  page = await app.firstWindow();
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") consoleLines.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => consoleLines.push(`pageerror: ${error.message}`));
  await page.waitForLoadState("domcontentloaded");
  await resize(1440);
  await page.getByTestId("setup").waitFor({ timeout: 30_000 });
  await page.getByTestId("sign-in-button").click();
  await page.getByTestId("github-connected").waitFor({ timeout: 30_000 });
  await page.getByTestId("finish-setup").click();
  await page.getByTestId("project-shell").waitFor({ timeout: 30_000 });
  await openMission();
  await direct("write the fake turn file");
  await until("the first turn to checkpoint", (value) => value.checkpoints.some((checkpoint) => checkpoint.sha !== null));
}, 300_000);

afterAll(async () => {
  if (!AUDIT) return;
  // Whatever was found is written, walk finished or not.
  try {
    const text = writeReport();
    console.warn(`[audit] ${findings.length} findings — ${join(OUT, "REPORT.md")}`);
    console.warn(text.split("\n").slice(0, 60).join("\n"));
  } catch {
    /* nothing to write */
  }
  await app?.close().catch(() => undefined);
  controlPlane?.kill("SIGTERM");
  await remote?.close();
});

describe.skipIf(!AUDIT)("the click-everything audit", () => {
  it("walks every surface at three widths and writes the punch list", async () => {
    // --- Build the rich state: an alternative, a decision, a push, a draft --
    await page.getByTestId("try-another-approach").click();
    await page.getByTestId("try-approach-dialog").waitFor({ timeout: 30_000 });
    await look("Try another approach dialog");
    await page.getByTestId("approach-intent-input").fill("Try the guard in middleware, with an intent long enough to wrap somewhere it should not");
    await page.getByTestId("create-approach").click();
    await until("the approach to exist", (value) => value.workstreams.length === 2 && value.workstreams[1]?.branchStatus === "created");
    await look("Room with two lanes");
    await pressEverything("Room with two lanes", DENY);
    await restoreRoom();
    await page.getByTestId("rail-compare").click();
    await page.getByTestId("approach-column").first().waitFor({ timeout: 30_000 });
    await look("Compare");
    await pressEverything("Compare", DENY);
    await restoreRoom();
    await page.getByTestId("rail-compare").click();
    await page.getByTestId("approach-column").first().waitFor({ timeout: 30_000 });
    await page.getByTestId("approach-column").nth(0).getByTestId("choose-approach").click();
    await page.getByTestId("record-decision").waitFor({ timeout: 30_000 });
    await look("Record decision dialog");
    await page.getByTestId("decision-rationale").fill("The baseline holds and its check passed.");
    await page.getByTestId("record-decision-confirm").click();
    const decided = await until("the decision to exist", (value) => value.decisions.some((entry) => entry.supersededAt === null));
    const decision = decided.decisions.find((entry) => entry.supersededAt === null)!;
    await page.getByTestId("pull-publish").waitFor({ timeout: 30_000 });
    await look("Receipt before push");
    await page.getByTestId("push-branch").click();
    await until(
      "the push to land",
      (value) => value.branchPush?.state === "completed" && value.workstreams.find((lane) => lane.workstreamId === decision.workstreamId)?.remoteHeadSha === decision.checkpointSha,
      120_000
    );
    await expect.poll(async () => page.getByTestId("create-pull-request").isDisabled(), { timeout: 30_000 }).toBe(false);
    await look("Receipt after push");
    await page.getByTestId("create-pull-request").click();
    await until("the draft to open", (value) => value.pullRequest !== null && value.pullRequest.state === "draft");
    await page.getByTestId("rail-pull").waitFor({ timeout: 30_000 });
    await look("Receipt with the draft");
    await page.getByTestId("open-pull-tab").click();
    await page.getByTestId("pull-page").waitFor({ timeout: 30_000 });
    await look("Pull request page");
    await pressEverything("Pull request page", DENY);
    await restoreRoom();

    // --- The room's own furniture ----------------------------------------
    await openMission();
    await page.keyboard.press("Meta+e").catch(() => undefined);
    await settle(400);
    await look("Room with the evidence panel");
    await pressEverything("Room with the evidence panel", DENY);
    await restoreRoom();
    await page.keyboard.press("Meta+e").catch(() => undefined);
    await page.keyboard.press("Meta+j").catch(() => undefined);
    await settle(600);
    await look("Room with the terminal dock");
    await pressEverything("Room with the terminal dock", DENY);
    await restoreRoom();
    await page.keyboard.press("Meta+j").catch(() => undefined);
    const treeRow = page.getByTestId("tree-row").first();
    if (await treeRow.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await treeRow.click();
      await settle(600);
      await look("Room with a file open");
      await pressEverything("Room with a file open", DENY);
      await restoreRoom();
    }
    await page.keyboard.press("Meta+k").catch(() => undefined);
    await settle(300);
    if (await page.getByTestId("command-palette").isVisible({ timeout: 1_000 }).catch(() => false)) {
      await look("Command palette");
      await page.keyboard.press("Escape");
    }
    await page.keyboard.press("Meta+t").catch(() => undefined);
    await settle(300);
    await look("Ask dialog");
    await page.keyboard.press("Escape");

    // --- The rail's dialogs and the home board ----------------------------
    await goHome();
    await look("Home board");
    await pressEverything("Home board", DENY);
    await page.getByTestId("add-project").click().catch(() => undefined);
    if (await page.getByTestId("add-project-dialog").isVisible({ timeout: 2_000 }).catch(() => false)) {
      await look("Add project dialog");
      await pressEverything("Add project dialog", DENY, true);
      await page.keyboard.press("Escape");
    }
    await page.getByTestId("join-mission").click().catch(() => undefined);
    if (await page.getByTestId("join-dialog").isVisible({ timeout: 2_000 }).catch(() => false)) {
      await look("Join dialog");
      await page.keyboard.press("Escape");
    }

    // --- Settings, every page --------------------------------------------
    await page.getByTestId("open-settings").click();
    await page.getByTestId("settings-dialog").waitFor({ timeout: 10_000 });
    const pages = await page.locator(".settings-nav-item").allInnerTexts();
    for (const name of pages) {
      await page.locator(".settings-nav-item").filter({ hasText: name }).first().click();
      await settle(300);
      await look(`Settings › ${name}`);
      await pressEverything(`Settings › ${name}`, DENY, true);
      if (!(await page.getByTestId("settings-dialog").isVisible({ timeout: 500 }).catch(() => false))) {
        await page.getByTestId("open-settings").click();
        await page.getByTestId("settings-dialog").waitFor({ timeout: 10_000 });
      }
    }
    await page.getByTestId("settings-back").click().catch(() => undefined);

    // --- Lingering: what is still standing after a quiet minute -----------
    await openMission();
    await settle(15_000);
    await auditDom("Quiet room after 15 s", 1440);

    expect(findings.length).toBeGreaterThanOrEqual(0);
  }, 1_500_000);
});
