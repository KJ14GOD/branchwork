import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOG_NAME, countCrashReports, createDiagnostics, rotatedName } from "../electron/diagnostics";

/** The machine's own record of its failures (D-250): a rotating log and a
 *  count of crash reports, all of it on disk here and nowhere else. */
describe("the diagnostics kept on this machine (D-250)", () => {
  it("writes timestamped lines and rotates past the size it was given", () => {
    const dir = mkdtempSync(join(tmpdir(), "novus-diagnostics-"));
    const logs = join(dir, "logs");
    const diagnostics = createDiagnostics({
      logsPath: logs,
      crashReportsPath: join(dir, "crashes"),
      maxBytes: 120,
      keep: 2,
      now: () => new Date("2026-09-10T12:00:00Z")
    });
    diagnostics.record("first line");
    expect(readFileSync(diagnostics.logFile, "utf8")).toBe("2026-09-10T12:00:00.000Z first line\n");
    // A multi-line message stays one entry, its continuation lines indented.
    diagnostics.record("an error\nwith a stack");
    expect(readFileSync(diagnostics.logFile, "utf8")).toContain("an error\n    with a stack\n");
    for (let at = 0; at < 6; at += 1) diagnostics.record(`line ${at} ${"x".repeat(30)}`);
    expect(existsSync(join(logs, rotatedName(1)))).toBe(true);
    expect(existsSync(join(logs, rotatedName(2)))).toBe(true);
    expect(existsSync(join(logs, rotatedName(3)))).toBe(false);
    const summary = diagnostics.summary();
    expect(summary.logsPath).toBe(logs);
    expect(summary.logBytes).toBeGreaterThan(120);
    expect(summary.crashReports).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps a quoted credential off the disk, and keeps the file to its owner", () => {
    const dir = mkdtempSync(join(tmpdir(), "novus-diagnostics-private-"));
    const diagnostics = createDiagnostics({ logsPath: join(dir, "logs"), crashReportsPath: join(dir, "crashes") });
    diagnostics.record("warn the harness said: GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef012345 and Authorization: Bearer abc.def-ghi_jkl==");
    const written = readFileSync(diagnostics.logFile, "utf8");
    expect(written).not.toContain("ghp_");
    expect(written).not.toContain("abc.def-ghi_jkl");
    expect(written).toContain("GITHUB_TOKEN=[redacted]");
    expect(written).toContain("Authorization: Bearer [redacted]");
    if (process.platform !== "win32") expect(statSync(diagnostics.logFile).mode & 0o777).toBe(0o600);
    rmSync(dir, { recursive: true, force: true });
  });

  it("counts crash reports wherever the reporter filed them", () => {
    const dir = mkdtempSync(join(tmpdir(), "novus-crashes-"));
    mkdirSync(join(dir, "completed"), { recursive: true });
    mkdirSync(join(dir, "pending"), { recursive: true });
    writeFileSync(join(dir, "completed", "a.dmp"), "");
    writeFileSync(join(dir, "pending", "b.dmp"), "");
    writeFileSync(join(dir, "pending", "notes.txt"), "");
    expect(countCrashReports(dir)).toBe(2);
    expect(countCrashReports(join(dir, "missing"))).toBe(0);
    rmSync(dir, { recursive: true, force: true });
    expect(rotatedName(0)).toBe(LOG_NAME);
  });
});
