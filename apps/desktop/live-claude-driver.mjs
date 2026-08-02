// Disposable driver: one LIVE Claude Code turn through the real desktop app.
// Run from apps/desktop. Uses the fake auth upstream (identity plumbing is
// already live-proven) but a REAL local repo and the REAL claude CLI.
import { _electron as electron } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import pg from "pg";

const repoRoot = resolve(process.cwd(), "..", "..");
const CP = 4501;
const DB = "postgres://novus:novus@127.0.0.1:5433/novus_live";

// db
const admin = new pg.Pool({ connectionString: "postgres://novus:novus@127.0.0.1:5433/novus" });
if ((await admin.query("select 1 from pg_database where datname='novus_live'")).rowCount === 0)
  await admin.query("create database novus_live");
await admin.end();
const scrub = new pg.Pool({ connectionString: DB });
await scrub.query("drop schema public cascade; create schema public;");
await scrub.end();

// control plane
const cp = spawn(process.execPath, ["--experimental-strip-types", join(repoRoot, "apps/control-plane/src/main.ts")], {
  env: { ...process.env, NOVUS_FAKE_GITHUB: "1", NOVUS_CP_PORT: String(CP), NOVUS_DATABASE_URL: DB },
  stdio: "ignore"
});
for (let i = 0; i < 40; i++) {
  try { if ((await fetch(`http://127.0.0.1:${CP}/health`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 500));
}

// real temp repo
const repo = mkdtempSync(join(tmpdir(), "novus-live-repo-"));
const g = (...a) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe" }).toString().trim();
execFileSync("git", ["init", "-b", "main", repo]);
writeFileSync(join(repo, "README.md"), "# live demo\n");
g("add", "-A"); g("-c", "user.name=kartik", "-c", "user.email=k@local", "commit", "-m", "init");
const headSha = g("rev-parse", "HEAD");

// auth + register local repo
const post = (p, b, t) => fetch(`http://127.0.0.1:${CP}${p}`, { method: "POST", headers: { "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: JSON.stringify(b) }).then((r) => r.json());
const start = await post("/auth/github/start", {});
await fetch(start.authorizeUrl, { redirect: "follow" });
const claim = await post("/auth/github/claim", { state: start.state });
const localId = randomUUID();
await post("/repositories/local", { localId, name: "live-demo", defaultBranch: "main", headSha }, claim.token);

// userData with local mapping
const userData = mkdtempSync(join(tmpdir(), "novus-live-ud-"));
writeFileSync(join(userData, "local-repos.json"), JSON.stringify({ [localId]: repo }));

// launch the real app — NO fake harness
const app = await electron.launch({
  args: [process.cwd()],
  env: { ...process.env, NOVUS_CP_URL: `http://127.0.0.1:${CP}`, NOVUS_AUTH_AUTOVISIT: "1", NOVUS_USER_DATA_DIR: userData }
});
const page = await app.firstWindow();
await page.getByTestId("sign-in-button").click();
await page.getByTestId("finish-setup").click();
await page.getByTestId("project-row").first().click();
await page.getByTestId("composer-input").waitFor();
await page.getByTestId("composer-input").fill("Create a file named HELLO.md containing exactly the single word: hello");
await page.getByTestId("composer-input").press("Enter");
console.log("direction sent; waiting for the live turn...");
await page.getByText("Turn completed").waitFor({ timeout: 240_000 });
mkdirSync(join(process.cwd(), "e2e", "evidence"), { recursive: true });
await page.screenshot({ path: join(process.cwd(), "e2e", "evidence", "11-live-claude-turn.png") });

// verify the branch really has the agent's commit
const branches = g("branch", "--list", "novus/m-*").replace(/[*+]/g, "").trim();
const fileOnBranch = g("show", `${branches}:HELLO.md`);
console.log("branch:", branches);
console.log("HELLO.md on mission branch:", JSON.stringify(fileOnBranch));
console.log("log:", g("log", "--oneline", branches));
await app.close();
cp.kill("SIGTERM");
console.log("LIVE TURN PROOF COMPLETE");
