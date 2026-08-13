import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeSkillsPlugin, discoverProjectSkills, removeComposedSkills } from "../electron/skills";

/**
 * Project skills on disk (D-118): the manifest half and the composition half,
 * against a real filesystem with real symlinks.
 *
 * The property that matters most is stated by the composition tests twice
 * over: what loads is what was reviewed, byte for byte, or nothing — and the
 * composed directory can contain nothing but the plugin manifest Novus
 * authors and the approved SKILL.md files, so the channels D-072 refused
 * (hooks, MCP servers, commands) are structurally absent from it.
 */

let worktree: string;
let outside: string;
let staging: string;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const ZEPHYR_BODY = "---\nname: zephyr-codes\ndescription: Codewords for releases.\n---\n\nThe codeword is XILOPHONE-72.\n";
const PLAIN_BODY = "No frontmatter at all, just instructions.\n";

function writeSkill(name: string, body: string): void {
  const home = join(worktree, ".claude", "skills", name);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "SKILL.md"), body);
}

beforeEach(() => {
  worktree = mkdtempSync(join(tmpdir(), "novus-skills-worktree-"));
  outside = mkdtempSync(join(tmpdir(), "novus-skills-outside-"));
  staging = join(mkdtempSync(join(tmpdir(), "novus-skills-staging-")), "composed");
});

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  rmSync(join(staging, ".."), { recursive: true, force: true });
});

describe("discovering the manifest", () => {
  it("lists each skill with its identity, what it says it is, and the digest an approval pins", () => {
    writeSkill("zephyr-codes", ZEPHYR_BODY);
    writeSkill("plain", PLAIN_BODY);
    const skills = discoverProjectSkills(worktree);
    expect(skills).toEqual([
      // Name order, so the published list is stable across re-reads.
      { name: "plain", description: null, digest: sha256(PLAIN_BODY), bytes: PLAIN_BODY.length },
      {
        name: "zephyr-codes",
        description: "Codewords for releases.",
        digest: sha256(ZEPHYR_BODY),
        bytes: ZEPHYR_BODY.length
      }
    ]);
  });

  it("publishes nothing for a project with no skills directory", () => {
    expect(discoverProjectSkills(worktree)).toEqual([]);
  });

  it("does not list what could never be enabled: bad names, missing files, links that leave", () => {
    writeSkill("good", PLAIN_BODY);
    // A name that is not one directory segment cannot be a skill name.
    writeSkill(".hidden", PLAIN_BODY);
    // A directory with no SKILL.md is not a skill.
    mkdirSync(join(worktree, ".claude", "skills", "empty-dir"), { recursive: true });
    // A SKILL.md that resolves outside the worktree is refused (D-064's rule).
    writeFileSync(join(outside, "secrets.md"), "not the project's skill\n");
    const escape = join(worktree, ".claude", "skills", "escape");
    mkdirSync(escape, { recursive: true });
    symlinkSync(join(outside, "secrets.md"), join(escape, "SKILL.md"));
    expect(discoverProjectSkills(worktree).map((skill) => skill.name)).toEqual(["good"]);
  });
});

describe("composing a turn's directory", () => {
  it("writes the plugin manifest, the approved bytes, and nothing else", () => {
    writeSkill("zephyr-codes", ZEPHYR_BODY);
    const composed = composeSkillsPlugin(
      worktree,
      [{ name: "zephyr-codes", digest: sha256(ZEPHYR_BODY) }],
      staging
    );
    expect(composed.dir).toBe(staging);
    expect(composed.carried).toEqual(["zephyr-codes"]);
    expect(composed.dropped).toEqual([]);
    // The whole directory, enumerated: the structural absence of hooks,
    // `.mcp.json`, commands, and agents is the point (D-072).
    expect(readdirSync(staging).sort()).toEqual([".claude-plugin", "skills"]);
    expect(readdirSync(join(staging, ".claude-plugin"))).toEqual(["plugin.json"]);
    expect(readdirSync(join(staging, "skills"))).toEqual(["zephyr-codes"]);
    expect(readdirSync(join(staging, "skills", "zephyr-codes"))).toEqual(["SKILL.md"]);
    expect(readFileSync(join(staging, "skills", "zephyr-codes", "SKILL.md"), "utf8")).toBe(ZEPHYR_BODY);
    const manifest = JSON.parse(readFileSync(join(staging, ".claude-plugin", "plugin.json"), "utf8"));
    expect(manifest.name).toBe("novus-project-skills");
  });

  it("drops what no longer matches the approval, each with the reason in words", () => {
    writeSkill("rewritten", "Not what was reviewed any more.\n");
    writeSkill("good", PLAIN_BODY);
    writeFileSync(join(outside, "secrets.md"), "elsewhere\n");
    const escape = join(worktree, ".claude", "skills", "escape");
    mkdirSync(escape, { recursive: true });
    symlinkSync(join(outside, "secrets.md"), join(escape, "SKILL.md"));

    const composed = composeSkillsPlugin(
      worktree,
      [
        { name: "good", digest: sha256(PLAIN_BODY) },
        { name: "rewritten", digest: sha256("The bytes that were reviewed.\n") },
        { name: "gone", digest: sha256("was deleted") },
        { name: "escape", digest: sha256("elsewhere\n") }
      ],
      staging
    );
    expect(composed.carried).toEqual(["good"]);
    expect(composed.dropped).toEqual([
      { name: "rewritten", reason: "changed since it was enabled" },
      { name: "gone", reason: "no longer in the project" },
      { name: "escape", reason: "resolves outside the worktree" }
    ]);
    // Only the survivor is in the directory.
    expect(readdirSync(join(staging, "skills"))).toEqual(["good"]);
  });

  it("composes nothing when nothing was enabled, and nothing when everything dropped", () => {
    expect(composeSkillsPlugin(worktree, [], staging)).toEqual({ dir: null, carried: [], dropped: [] });
    writeSkill("changed", "new bytes\n");
    const allDropped = composeSkillsPlugin(
      worktree,
      [{ name: "changed", digest: sha256("old bytes\n") }],
      staging
    );
    expect(allDropped.dir).toBeNull();
    expect(allDropped.dropped).toEqual([{ name: "changed", reason: "changed since it was enabled" }]);
    expect(existsSync(staging)).toBe(false);
  });

  it("removes its staging on request, and a second removal is quiet", () => {
    writeSkill("zephyr-codes", ZEPHYR_BODY);
    const composed = composeSkillsPlugin(
      worktree,
      [{ name: "zephyr-codes", digest: sha256(ZEPHYR_BODY) }],
      staging
    );
    expect(composed.dir).toBe(staging);
    removeComposedSkills(staging);
    expect(existsSync(staging)).toBe(false);
    removeComposedSkills(staging);
  });
});
