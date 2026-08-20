import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureGlobalSlashCommands, recallGlobalSlashCommands } from "../electron/global-commands";

/**
 * The CLI's own slash commands, remembered per machine (D-188): captured from
 * a session's init line, filtered to what can genuinely be offered — no
 * terminal-only commands, no plugin-scoped names — and recalled for the
 * composer's / menu.
 */

let userData: string;

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), "novus-global-commands-"));
});

afterEach(() => {
  rmSync(userData, { recursive: true, force: true });
});

describe("remembering what a session announced", () => {
  it("keeps the offerable names, sorted and deduplicated, and drops what / cannot honestly offer", () => {
    captureGlobalSlashCommands(
      userData,
      [
        "review",
        "compact",
        "compact",
        // The CLI's own word for terminal-only UI: excluded at the source.
        "doctor",
        // Plugin-scoped: the composed plugin's commands are the governed
        // repo group, and no other plugin loads under the pinned argv.
        "novus-project-skills:relnotes",
        // Shapes the schema refuses are never stored.
        "../escape",
        ""
      ],
      ["doctor"]
    );
    expect(recallGlobalSlashCommands(userData)).toEqual(["compact", "review"]);
  });

  it("recalls nothing from a machine that heard nothing, and none from a torn store", () => {
    expect(recallGlobalSlashCommands(userData)).toEqual([]);
    writeFileSync(join(userData, "global-slash-commands.json"), "{ not json");
    expect(recallGlobalSlashCommands(userData)).toEqual([]);
    // A later good capture replaces the torn store.
    captureGlobalSlashCommands(userData, ["compact"]);
    expect(recallGlobalSlashCommands(userData)).toEqual(["compact"]);
  });
});
