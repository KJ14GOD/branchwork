import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
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
