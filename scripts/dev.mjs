#!/usr/bin/env node
// Development launcher: PostgreSQL container → control plane → the desktop app.
// Requires NOVUS_GITHUB_CLIENT_ID / NOVUS_GITHUB_CLIENT_SECRET in the
// environment or in a .env file at the repository root for real sign-in.
import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL(".", import.meta.url).pathname, "..");

const envFile = resolve(root, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2];
  }
}

// Start (or first create) the dev database — two plain commands instead of a
// bash one-liner, so Windows' cmd.exe runs this file the same (D-229).
try {
  execSync("docker start novus-pg", { stdio: "ignore" });
} catch {
  execSync(
    "docker run -d --name novus-pg -e POSTGRES_PASSWORD=novus -e POSTGRES_USER=novus -e POSTGRES_DB=novus -p 5433:5432 postgres:16",
    { stdio: "inherit" }
  );
}

// A freshly started container accepts connections before it can serve them
// (57P03, "the database system is starting up"), and the control plane
// migrates on boot — so wait for pg_isready inside the container first.
const started = Date.now();
for (;;) {
  try {
    execSync("docker exec novus-pg pg_isready -U novus -d novus", { stdio: "ignore" });
    break;
  } catch {
    if (Date.now() - started > 30_000) {
      console.error("novus-pg did not become ready within 30s");
      process.exit(1);
    }
    execSync(`${process.execPath} -e "setTimeout(()=>{},500)"`);
  }
}

const controlPlane = spawn(
  process.execPath,
  ["--experimental-strip-types", resolve(root, "apps/control-plane/src/main.ts")],
  { stdio: "inherit", env: process.env }
);

const desktop = spawn("pnpm", ["--filter", "@novus/desktop", "start"], {
  // On Windows pnpm is a .cmd shim; a shell is what starts those (D-229).
  shell: process.platform === "win32",
  stdio: "inherit",
  env: process.env,
  cwd: root
});

const stop = () => {
  controlPlane.kill("SIGTERM");
  desktop.kill("SIGTERM");
};
desktop.on("exit", stop);
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
