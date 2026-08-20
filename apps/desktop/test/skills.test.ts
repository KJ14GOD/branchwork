import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeSkillsPlugin, discoverGlobalSkills, discoverProjectSkills, removeComposedSkills } from "../electron/skills";

/**
 * Project skills on disk (D-118): the manifest half and the composition half,
 * against a real filesystem with real symlinks.
 *
 * The property that matters most is stated by the composition tests twice
 * over: what loads is what was reviewed, byte for byte, or nothing — and the
 * composed directory can contain nothing but the plugin manifest Novus
 * authors, the approved SKILL.md files, and the approved command templates
 * (D-187), so the channels D-072 refused (hooks, MCP servers, agents) are
 * structurally absent from it.
 */

let worktree: string;
let outside: string;
let staging: string;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const ZEPHYR_BODY = "---\nname: zephyr-codes\ndescription: Codewords for releases.\n---\n\nThe codeword is XILOPHONE-72.\n";
const PLAIN_BODY = "No frontmatter at all, just instructions.\n";
const ON_REQUEST_BODY =
  "---\nname: strict-review\ndescription: A harsh review.\ndisable-model-invocation: true\n---\n\nBody.\n";

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
      {
        name: "plain",
        description: null,
        digest: sha256(PLAIN_BODY),
        bytes: PLAIN_BODY.length,
        modelInvocable: true
      },
      {
        name: "zephyr-codes",
        description: "Codewords for releases.",
        digest: sha256(ZEPHYR_BODY),
        bytes: ZEPHYR_BODY.length,
        modelInvocable: true
      }
    ]);
  });

  it("reads disable-model-invocation, so a skill that only runs on request says so (D-192)", () => {
    writeSkill("strict-review", ON_REQUEST_BODY);
    writeSkill("ordinary", ZEPHYR_BODY);
    const skills = discoverProjectSkills(worktree);
    expect(skills.find((skill) => skill.name === "strict-review")?.modelInvocable).toBe(false);
    expect(skills.find((skill) => skill.name === "ordinary")?.modelInvocable).toBe(true);
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

describe("composing a turn's directory (D-193)", () => {
  const env = () => ({ CLAUDE_CONFIG_DIR: outside }) as NodeJS.ProcessEnv;

  it("carries everything the project declares, with the digest that ran, and writes nothing else", () => {
    writeSkill("zephyr-codes", ZEPHYR_BODY);
    writeSkill("plain", PLAIN_BODY);
    const composed = composeSkillsPlugin(worktree, staging, env());
    expect(composed.dir).toBe(staging);
    // Name and the exact bytes that reached the harness: with no approval to
    // check against, this record is what says which bytes ran.
    expect(composed.carried).toEqual([
      { name: "plain", digest: sha256(PLAIN_BODY) },
      { name: "zephyr-codes", digest: sha256(ZEPHYR_BODY) }
    ]);
    expect(composed.dropped).toEqual([]);
    // The whole directory, enumerated: the structural absence of hooks,
    // `.mcp.json`, and agents is still the point (D-072).
    expect(readdirSync(staging).sort()).toEqual([".claude-plugin", "skills"]);
    expect(readdirSync(join(staging, ".claude-plugin"))).toEqual(["plugin.json"]);
    expect(readdirSync(join(staging, "skills")).sort()).toEqual(["plain", "zephyr-codes"]);
    expect(readFileSync(join(staging, "skills", "zephyr-codes", "SKILL.md"), "utf8")).toBe(ZEPHYR_BODY);
  });

  it("carries the project's commands and the machine's skills in the same directory", () => {
    writeSkill("zephyr-codes", ZEPHYR_BODY);
    mkdirSync(join(worktree, ".claude", "commands"), { recursive: true });
    writeFileSync(join(worktree, ".claude", "commands", "relnotes.md"), PLAIN_BODY);
    mkdirSync(join(outside, "skills", "unslop"), { recursive: true });
    writeFileSync(join(outside, "skills", "unslop", "SKILL.md"), PLAIN_BODY);

    const composed = composeSkillsPlugin(worktree, staging, env());
    expect(composed.carried.map((entry) => entry.name)).toEqual(["zephyr-codes"]);
    expect(composed.carriedCommands.map((entry) => entry.name)).toEqual(["relnotes"]);
    expect(composed.carriedGlobals.map((entry) => entry.name)).toEqual(["unslop"]);
    expect(readdirSync(staging).sort()).toEqual([".claude-plugin", "commands", "skills"]);
    // The machine's skill sits beside the project's, both loadable as skills.
    expect(readdirSync(join(staging, "skills")).sort()).toEqual(["unslop", "zephyr-codes"]);
    expect(readdirSync(join(staging, "commands"))).toEqual(["relnotes.md"]);
  });

  it("composes nothing when the project and the machine declare nothing", () => {
    expect(composeSkillsPlugin(worktree, staging, env())).toEqual({
      dir: null,
      carried: [],
      dropped: [],
      carriedCommands: [],
      droppedCommands: [],
      carriedGlobals: [],
      droppedGlobals: []
    });
    expect(existsSync(staging)).toBe(false);
  });

  it("never carries what the bounds refuse — a link that leaves the worktree stays out", () => {
    writeSkill("good", PLAIN_BODY);
    writeFileSync(join(outside, "secrets.md"), "not the project's skill\n");
    const escape = join(worktree, ".claude", "skills", "escape");
    mkdirSync(escape, { recursive: true });
    symlinkSync(join(outside, "secrets.md"), join(escape, "SKILL.md"));
    const composed = composeSkillsPlugin(worktree, staging, env());
    expect(composed.carried.map((entry) => entry.name)).toEqual(["good"]);
    expect(readdirSync(join(staging, "skills"))).toEqual(["good"]);
  });

  it("removes its staging on request, and a second removal is quiet", () => {
    writeSkill("zephyr-codes", ZEPHYR_BODY);
    expect(composeSkillsPlugin(worktree, staging, env()).dir).toBe(staging);
    removeComposedSkills(staging);
    expect(existsSync(staging)).toBe(false);
    removeComposedSkills(staging);
  });
});

describe("discovering the machine's global skills (D-186)", () => {
  // `outside` stands in for the operator's config dir, reached the way the
  // CLI reaches it: CLAUDE_CONFIG_DIR when set, ~/.claude otherwise.
  const env = () => ({ CLAUDE_CONFIG_DIR: outside }) as NodeJS.ProcessEnv;

  function writeGlobal(name: string, body: string): void {
    const home = join(outside, "skills", name);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "SKILL.md"), body);
  }

  it("lists the config dir's skills with the same identity the project manifest carries", () => {
    writeGlobal("unslop", "---\ndescription: Cut AI tells.\n---\n\nBody.\n");
    const skills = discoverGlobalSkills(env());
    expect(skills).toEqual([
      {
        name: "unslop",
        description: "Cut AI tells.",
        digest: sha256("---\ndescription: Cut AI tells.\n---\n\nBody.\n"),
        bytes: "---\ndescription: Cut AI tells.\n---\n\nBody.\n".length,
        modelInvocable: true
      }
    ]);
  });

  it("lists nothing when the machine has no config dir, and skips what could not be a skill", () => {
    expect(discoverGlobalSkills(env())).toEqual([]);
    writeGlobal(".hidden", PLAIN_BODY);
    mkdirSync(join(outside, "skills", "empty-dir"), { recursive: true });
    writeGlobal("real", PLAIN_BODY);
    expect(discoverGlobalSkills(env()).map((skill) => skill.name)).toEqual(["real"]);
  });
});



