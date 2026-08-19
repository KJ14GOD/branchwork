import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { OpenTarget } from "@novus/contracts";

/**
 * Opening a lane's checkout in the tools a person already uses (D-159).
 *
 * The whole security posture of this module is one sentence: **the renderer
 * names a lane, never a path.** The worktree path is resolved here from the
 * workstream id, the application is chosen from the closed list below, and
 * neither ever comes from the window. So there is no input that could name
 * `/etc` or an application nobody vetted, and no string is passed to a shell —
 * `execFile` with an argument vector, never `exec` with a line.
 *
 * The list is a list because "open in whatever the user typed" is the same
 * hole with a friendlier name. Adding an editor is a deliberate edit here, and
 * an editor that is not installed is not offered — a menu full of things that
 * do nothing is worse than a short menu.
 */

export interface OpenApplication {
  id: OpenTarget;
  label: string;
  /** The bundle as `open -a` names it. */
  application: string;
  /** Where a macOS install puts it, checked before the entry is offered. */
  paths: string[];
}

/** Every application Novus will hand a worktree to, and nothing else. */
export const OPEN_APPLICATIONS: readonly OpenApplication[] = [
  {
    id: "finder",
    label: "Finder",
    application: "Finder",
    // Always present, and named here so it carries its own icon like the
    // rest; the open itself still goes through `shell.openPath`.
    paths: ["/System/Library/CoreServices/Finder.app"]
  },
  {
    id: "cursor",
    label: "Cursor",
    application: "Cursor",
    paths: ["/Applications/Cursor.app"]
  },
  {
    id: "vscode",
    label: "VS Code",
    application: "Visual Studio Code",
    paths: ["/Applications/Visual Studio Code.app"]
  },
  {
    id: "zed",
    label: "Zed",
    application: "Zed",
    paths: ["/Applications/Zed.app"]
  },
  {
    id: "iterm",
    label: "iTerm",
    application: "iTerm",
    paths: ["/Applications/iTerm.app"]
  },
  {
    id: "terminal",
    label: "Terminal",
    application: "Terminal",
    paths: ["/System/Applications/Utilities/Terminal.app", "/Applications/Utilities/Terminal.app"]
  }
];

/** Which of them this machine actually has. Finder and Copy path are not in
 *  the list because they need no application and are always available. */
export function installedApplications(
  exists: (path: string) => boolean = existsSync
): OpenApplication[] {
  if (process.platform !== "darwin") return [];
  return OPEN_APPLICATIONS.filter((entry) => entry.paths.some((path) => exists(path)));
}

/**
 * The application's own icon, as PNG bytes (D-159 amended).
 *
 * Read out of the bundle rather than asked for: Electron's `getFileIcon`
 * returns a **generic document icon** for a `.app` on macOS — the same 1181
 * bytes for Finder, Cursor and Terminal, which is how this was found — so the
 * icon comes from where the icon actually is. `Info.plist` names the icon
 * file, `Resources/` holds it, and `sips` converts `.icns` to something a
 * renderer can show.
 *
 * Never bundled with Novus: an app's icon is the thing a person recognizes
 * before reading anything, and a copy we ship goes stale the moment the app is
 * redesigned. A failure here drops the icon and keeps the row.
 */
export async function applicationIcon(
  appPath: string,
  run: (file: string, args: string[]) => Promise<string> = execFileText
): Promise<Buffer | null> {
  try {
    const declared = (await run("defaults", ["read", join(appPath, "Contents/Info.plist"), "CFBundleIconFile"])).trim();
    if (!declared) return null;
    // The key sometimes carries the extension and sometimes does not.
    const icns = join(appPath, "Contents/Resources", declared.endsWith(".icns") ? declared : `${declared}.icns`);
    if (!existsSync(icns)) return null;
    const out = join(await mkdtemp(join(tmpdir(), "novus-icon-")), "icon.png");
    await run("sips", ["-s", "format", "png", "-Z", "32", icns, "--out", out]);
    const bytes = await readFile(out);
    await rm(dirname(out), { recursive: true, force: true }).catch(() => undefined);
    return bytes;
  } catch {
    return null;
  }
}

const execFileText = (file: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 10_000 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout)
    );
  });

export class OpenRefused extends Error {}

/**
 * Hands one directory to one application. The arguments are a vector and the
 * application name is from the list above, so nothing here is interpretable as
 * a command however a directory is named.
 */
export async function openWith(application: string, directory: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile("open", ["-a", application, "--", directory], { timeout: 15_000 }, (error) =>
      error ? reject(new OpenRefused(`${application} could not be opened.`)) : resolve()
    );
  });
}
