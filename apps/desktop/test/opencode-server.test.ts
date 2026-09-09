import { harnessEnv } from "../electron/workspace-env";
import crossSpawn from "cross-spawn";
import { expect, it } from "vitest";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { OpenCodeServer, shutdownOpenCode } from "../electron/opencode-server";

it("app shutdown kills catalogue probes too and prevents a late probe spawning", async () => {
  const root = mkdtempSync(join(tmpdir(), "novus-opencode-shutdown-"));
  const pathBefore = process.env.PATH;
  const servers: OpenCodeServer[] = [];
  try {
    copyFileSync(join(__dirname, "fixtures/opencode.cjs"), join(root, process.platform === "win32" ? "opencode.cjs" : "opencode"));
    if (process.platform !== "win32") chmodSync(join(root, "opencode"), 0o755);
    if (process.platform === "win32") writeFileSync(join(root, "opencode.cmd"), `@echo off\r\n"${process.execPath}" "${join(root, "opencode.cjs")}" %*\r\n`);
    writeFileSync(join(root, "mode"), "approval");
    process.env.PATH = `${root}${delimiter}${pathBefore ?? ""}`;
    const probe = crossSpawn.sync("opencode", ["--version"], { encoding: "utf8", timeout: 5000 });
    expect(probe.stdout?.trim(), probe.stderr || probe.error?.message).toBe("1.18.29-test");
    const managed = crossSpawn.sync("opencode", ["--version"], { cwd: root, env: harnessEnv(), encoding: "utf8", timeout: 5000 });
    expect(managed.stdout?.trim(), managed.stderr || managed.error?.message).toBe("1.18.29-test");
    servers.push(new OpenCodeServer(root, {}, {}));
    let stderr = "";
    servers[0]!.child.stderr?.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-2000); });
    try { await servers[0]!.ready; }
    catch (error) { throw new Error(`${String(error)}; fixtureStarted=${existsSync(join(root, "launch.json"))}; stderr=${stderr}`); }
    const configHome = JSON.parse(readFileSync(join(root, "launch.json"), "utf8")).configHome;
    await shutdownOpenCode();
    expect(() => process.kill(servers[0]!.child.pid!, 0)).toThrow();
    expect(existsSync(configHome)).toBe(false);
    expect(() => new OpenCodeServer(root, {}, {})).toThrow("closing");
  } finally {
    for (const server of servers) server.stop();
    await Promise.all(servers.map((server) => server.closed));
    if (pathBefore === undefined) delete process.env.PATH; else process.env.PATH = pathBefore;
    rmSync(root, { recursive: true, force: true });
  }
});
