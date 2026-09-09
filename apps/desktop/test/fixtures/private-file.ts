import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { expect } from "vitest";

/** Same privacy assertion, using the host's permission model. Administrators
 * and SYSTEM are privileged just as root is on Unix; other principals may not read. */
export function expectPrivateFile(path: string): void {
  if (process.platform !== "win32") {
    expect(statSync(path).mode & 0o777).toBe(0o600);
    return;
  }
  const result = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
    $ErrorActionPreference = 'Stop'
    $owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $allowed = @($owner, 'S-1-5-18', 'S-1-5-32-544')
    $unexpected = @((Get-Acl -LiteralPath $env:NOVUS_TEST_PRIVATE_FILE).Access | Where-Object {
      $_.AccessControlType -eq 'Allow' -and
      $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -notin $allowed
    } | ForEach-Object { $_.IdentityReference.Value })
    ConvertTo-Json -Compress -InputObject $unexpected
  `], { env: { ...process.env, NOVUS_TEST_PRIVATE_FILE: path }, encoding: "utf8", timeout: 10_000 });
  expect(JSON.parse(result)).toEqual([]);
}
