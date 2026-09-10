import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";

/** Same privacy assertion, using the host's permission model. Administrators
 * and SYSTEM are privileged just as root is on Unix; other principals may not read. */
export function expectPrivateFile(path: string): void {
  if (process.platform !== "win32") {
    expect(statSync(path).mode & 0o777).toBe(0o600);
    return;
  }
  // The native tools answer in milliseconds; Windows PowerShell's cold start
  // on a loaded hosted runner ran past ten seconds and failed a run that had
  // passed the commit before (2026-09-10). SDDL names principals by SID, so
  // the check does not depend on the machine's language either.
  const sddl = readDacl(path);
  if (sddl !== null) {
    expect(unexpectedAllows(sddl, currentUserSid())).toEqual([]);
    return;
  }
  expect(unexpectedAllowsByPowerShell(path)).toEqual([]);
}

/** SIDs that may read a private file: SYSTEM, the Administrators group, the
 * owner's own rights, and the owner. */
const PRIVILEGED = new Set(["SY", "S-1-5-18", "BA", "S-1-5-32-544", "OW", "S-1-3-4"]);

/**
 * Whether an ACE's SID is the owner. SDDL abbreviates a few accounts — the
 * built-in local Administrator (RID 500) is `LA` — while `whoami` always
 * spells the full SID; the hosted Windows runner runs as exactly that
 * account, and the first native-path run read `LA` as a stranger.
 */
function isOwner(sid: string, ownerSid: string): boolean {
  if (sid === ownerSid) return true;
  if (sid === "LA") return ownerSid.endsWith("-500");
  if (sid === "LG") return ownerSid.endsWith("-501");
  return false;
}

/**
 * The principals an SDDL DACL grants access to beyond the privileged ones and
 * the owner. An ACE reads `(type;flags;rights;object;inherit;sid)`; only
 * `A` (allow) entries can widen who reads.
 */
export function unexpectedAllows(sddl: string, ownerSid: string): string[] {
  const dacl = /D:[^:]*?((?:\([^)]*\))+)/.exec(sddl)?.[1] ?? "";
  const out: string[] = [];
  for (const ace of dacl.matchAll(/\(([^)]*)\)/g)) {
    const parts = ace[1].split(";");
    if (parts[0] !== "A") continue;
    const sid = parts[5] ?? "";
    if (PRIVILEGED.has(sid) || isOwner(sid, ownerSid)) continue;
    out.push(sid);
  }
  return out;
}

/** The file's DACL as SDDL via `icacls /save`, or null when the tool's answer is not readable. */
function readDacl(path: string): string | null {
  const dir = mkdtempSync(join(tmpdir(), "novus-acl-"));
  const saved = join(dir, "acl.txt");
  try {
    execFileSync("icacls.exe", [path, "/save", saved, "/q"], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
    // icacls writes UTF-16LE: the file name on one line, its SDDL on the next.
    const text = readFileSync(saved).toString("utf16le").replace(/^﻿/, "");
    const line = text.split(/\r?\n/).find((candidate) => candidate.startsWith("D:"));
    return line ?? null;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The current user's SID from `whoami /user`, as SDDL names the owner. */
function currentUserSid(): string {
  const csv = execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", timeout: 30_000 });
  const sid = /"(S-1-[0-9-]+)"/.exec(csv)?.[1];
  if (!sid) throw new Error(`whoami did not name a SID: ${csv.trim()}`);
  return sid;
}

/** The former check, kept for a machine where icacls's answer cannot be read. */
function unexpectedAllowsByPowerShell(path: string): string[] {
  // PowerShell 7 can export its module path to Windows PowerShell 5.1.
  // Let the child discover its own built-in modules.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath"));
  const result = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
    $ErrorActionPreference = 'Stop'
    $owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $allowed = @($owner, 'S-1-5-18', 'S-1-5-32-544')
    $unexpected = @((Get-Acl -LiteralPath $env:NOVUS_TEST_PRIVATE_FILE).Access | Where-Object {
      $_.AccessControlType -eq 'Allow' -and
      $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -notin $allowed
    } | ForEach-Object { $_.IdentityReference.Value })
    ConvertTo-Json -Compress -InputObject $unexpected
  `], { env: { ...env, NOVUS_TEST_PRIVATE_FILE: path }, encoding: "utf8", timeout: 60_000 });
  return JSON.parse(result) as string[];
}
