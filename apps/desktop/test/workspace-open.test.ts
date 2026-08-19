import { describe, expect, it } from "vitest";
import { OPEN_APPLICATIONS, applicationIcon, installedApplications } from "../electron/workspace-open";

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

/**
 * The application's own icon (D-159 amended).
 *
 * Read out of the bundle rather than asked for. Electron's `getFileIcon`
 * returns a **generic document icon** for a `.app` on macOS — the identical
 * 1181 bytes for Finder, Cursor and Terminal, which is how this was found —
 * so the icon comes from where the icon actually is: `Info.plist` names it,
 * `Resources/` holds it, `sips` converts it.
 *
 * Nothing is ever bundled with Novus. An app's icon is what a person
 * recognizes before reading anything, and a copy we ship goes stale the moment
 * the app is redesigned.
 */
describe("an application's own icon", () => {
  it("reads the name from Info.plist and looks for the icns beside it", async () => {
    const asked: string[][] = [];
    const bytes = await applicationIcon("/Applications/Cursor.app", async (file, args) => {
      asked.push([file, ...args]);
      if (file === "defaults") return "Cursor.icns\n";
      return "";
    });
    expect(asked[0]?.[0]).toBe("defaults");
    expect(asked[0]?.slice(-1)[0]).toBe("CFBundleIconFile");
    // No icns exists at that path in this test, so it stops before sips and
    // answers null rather than inventing an icon.
    expect(bytes).toBeNull();
  });

  it("answers null rather than throwing when the bundle names nothing", async () => {
    expect(await applicationIcon("/Applications/Nothing.app", async () => "")).toBeNull();
  });

  it("answers null when reading the bundle fails outright", async () => {
    // A missing icon drops the icon, never the row.
    expect(
      await applicationIcon("/Applications/Broken.app", async () => {
        throw new Error("no such plist");
      })
    ).toBeNull();
  });
});
