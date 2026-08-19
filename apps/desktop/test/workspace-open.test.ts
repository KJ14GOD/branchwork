import { describe, expect, it } from "vitest";
import { OPEN_APPLICATIONS, installedApplications } from "../electron/workspace-open";

/**
 * Which applications a workspace may be handed to (D-159).
 *
 * The list is the security boundary, so these are about the list. "Open in
 * whatever the user typed" is a shell injection with a friendlier name, and
 * the guard against it is that no name ever comes from the window: the
 * renderer sends an id from this closed set, and the id maps to an application
 * this file names.
 *
 * The detection half matters for a different reason — honesty. A menu that
 * offers Cursor to somebody who does not have Cursor is a control that does
 * nothing, which the house rule already forbids elsewhere.
 */

describe("the applications a checkout may be opened in", () => {
  it("offers only what this machine actually has", () => {
    const present = new Set(["/Applications/Cursor.app", "/Applications/Zed.app"]);
    const found = installedApplications((path) => present.has(path));
    expect(found.map((entry) => entry.id)).toEqual(["cursor", "zed"]);
  });

  it("offers nothing when nothing is installed, rather than a menu that does nothing", () => {
    expect(installedApplications(() => false)).toEqual([]);
  });

  it("finds Terminal wherever the operating system version put it", () => {
    // It moved to /System/Applications in Catalina; both are checked, and a
    // machine only ever has one.
    const modern = installedApplications((path) => path === "/System/Applications/Utilities/Terminal.app");
    const older = installedApplications((path) => path === "/Applications/Utilities/Terminal.app");
    expect(modern.map((entry) => entry.id)).toEqual(["terminal"]);
    expect(older.map((entry) => entry.id)).toEqual(["terminal"]);
  });

  it("names an application per entry, so nothing is ever assembled from an id", () => {
    // The id crosses the bridge; the application name never does. If an entry
    // lacked one, something downstream would have to invent it from the id,
    // which is the exact shape this list exists to prevent.
    for (const entry of OPEN_APPLICATIONS) {
      expect(entry.application.length).toBeGreaterThan(0);
      expect(entry.paths.length).toBeGreaterThan(0);
      expect(entry.paths.every((path) => path.startsWith("/"))).toBe(true);
    }
  });

  it("is a closed set: every entry's id is one the contract already knows", () => {
    const known = new Set(["finder", "terminal", "iterm", "cursor", "vscode", "zed", "copy-path"]);
    for (const entry of OPEN_APPLICATIONS) {
      expect(known.has(entry.id), entry.id).toBe(true);
    }
  });
});
