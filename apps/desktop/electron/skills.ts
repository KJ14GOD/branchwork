import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { join, sep } from "node:path";
import {
  MAX_PROJECT_SKILLS,
  MAX_SKILL_BYTES,
  SKILL_DESCRIPTION_MAX,
  SkillNameSchema,
  type EnabledSkill,
  type ProjectSkill
} from "@novus/contracts";

/**
 * Project skills (D-118): the worktree's own `.claude/skills`, carried to the
 * harness only as a directory Novus composed itself.
 *
 * D-072 measured why neither flag that loads skills wholesale can be used —
 * `--setting-sources project` re-admits hooks and MCP servers, and a plugin
 * directory pointed at repository content can carry both too — and named the
 * version that could work: Novus composing a directory containing only skill
 * files it copied out of the worktree, under the same containment the
 * project's instructions file already has (D-064). This module is that
 * version, in two halves:
 *
 *  - **discover** reads the worktree's `.claude/skills` and produces the
 *    bounded manifest the runner publishes beside the declared commands
 *    (D-043's pattern): name, what it says it is, size, and the SHA-256 of
 *    the exact bytes. What a person reviews is what an approval will pin.
 *  - **compose** builds one turn's plugin directory from the *enabled* list
 *    the control plane pinned at dispatch. Every file is re-read and its
 *    digest compared to the approved one; a mismatch — the agent rewrote the
 *    skill, the file left, a symlink now points elsewhere — drops the skill
 *    with the reason in words, never loads unreviewed bytes. The bytes that
 *    were verified are the bytes that are written, so the loaded copy cannot
 *    drift from the check that admitted it.
 *
 * What the composed directory can never contain is the point: Novus writes
 * `.claude-plugin/plugin.json` (fixed content, authored here) and one
 * `skills/<name>/SKILL.md` per carried skill, and nothing else — no hooks
 * file, no `.mcp.json`, no commands, no agents — so the escalation channels
 * D-062 pinned shut stay structurally absent rather than merely unused. A
 * skill is instructions, never authority: every tool call a skill-bearing
 * turn makes still reaches the permission router.
 */

/** Where a worktree keeps its skills; one path, stated once. */
const SKILLS_DIR = [".claude", "skills"] as const;

const PLUGIN_MANIFEST = JSON.stringify(
  {
    name: "novus-project-skills",
    version: "0.0.0",
    description:
      "Skills a participant enabled from this project's own .claude/skills, composed by Novus (D-118). Skills only — never hooks, MCP servers, or commands."
  },
  null,
  2
);

export interface ComposedSkills {
  /** The directory to hand `--plugin-dir`, or null when nothing was carried. */
  dir: string | null;
  /** The skills the turn actually carries, by name. */
  carried: string[];
  /** The enabled skills this turn could not carry, each with the reason. */
  dropped: { name: string; reason: string }[];
}

/** True when `candidate` is `root` or lives under it. */
function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

/**
 * The SKILL.md frontmatter's own description, read leniently and bounded.
 * A skill is reviewed by what it says it is; one whose frontmatter is absent,
 * malformed, or silent is listed with no description rather than dropped —
 * saying nothing is reviewable too.
 */
function frontmatterDescription(body: string): string | null {
  if (!body.startsWith("---")) return null;
  const end = body.indexOf("\n---", 3);
  if (end === -1) return null;
  for (const line of body.slice(0, end).split("\n")) {
    const match = /^description:\s*(.+)\s*$/.exec(line);
    const raw = match?.[1];
    if (raw !== undefined) {
      const value = raw.trim().replace(/^["']|["']$/g, "").trim();
      return value.length > 0 ? value.slice(0, SKILL_DESCRIPTION_MAX) : null;
    }
  }
  return null;
}

interface ReadSkill {
  skill: ProjectSkill;
  bytes: Buffer;
}

/**
 * One skill, read and verified: resolved through `realpath`, required to stay
 * inside the worktree (a symlinked SKILL.md pointing at `~/.ssh/config` is an
 * ordinary relative path right up until something reads it — D-064's rule), a
 * regular file, non-empty, bounded. Returns the refusal in words otherwise.
 */
function readSkill(root: string, name: string): ReadSkill | { reason: string } {
  const candidate = join(root, ...SKILLS_DIR, name, "SKILL.md");
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    return { reason: "no longer in the project" };
  }
  if (!inside(root, real)) return { reason: "resolves outside the worktree" };
  let stats;
  try {
    stats = statSync(real);
  } catch {
    return { reason: "no longer in the project" };
  }
  if (!stats.isFile()) return { reason: "not a regular file" };
  if (stats.size === 0) return { reason: "empty" };
  if (stats.size > MAX_SKILL_BYTES) return { reason: "larger than a skill can be" };
  try {
    const bytes = readFileSync(real);
    return { skill: sealSkill(name, bytes), bytes };
  } catch {
    return { reason: "could not be read" };
  }
}

function sealSkill(name: string, bytes: Buffer): ProjectSkill {
  return {
    name,
    description: frontmatterDescription(bytes.toString("utf8")),
    digest: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength
  };
}

/**
 * The manifest the runner publishes: every well-named skill directory holding
 * a valid SKILL.md, in name order, bounded at MAX_PROJECT_SKILLS. A directory
 * whose name could not be a skill name — a path, a leading dot — is not
 * listed, because nothing unlistable can ever be enabled.
 */
export function discoverProjectSkills(worktreePath: string): ProjectSkill[] {
  let root: string;
  try {
    root = realpathSync(worktreePath);
  } catch {
    return [];
  }
  const dir = join(root, ...SKILLS_DIR);
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return [];
  }
  const skills: ProjectSkill[] = [];
  for (const name of entries) {
    if (skills.length >= MAX_PROJECT_SKILLS) break;
    if (!SkillNameSchema.safeParse(name).success) continue;
    const read = readSkill(root, name);
    if ("reason" in read) continue;
    skills.push(read.skill);
  }
  return skills;
}

/**
 * One turn's skills-only plugin directory, composed from the pinned enabled
 * list. The verified bytes are the written bytes: a worktree edit between the
 * digest check and the harness reading the composed copy changes nothing,
 * because the harness never reads the worktree's copy at load time at all.
 */
export function composeSkillsPlugin(
  worktreePath: string,
  enabled: readonly EnabledSkill[],
  stagingDir: string
): ComposedSkills {
  if (enabled.length === 0) return { dir: null, carried: [], dropped: [] };
  let root: string;
  try {
    root = realpathSync(worktreePath);
  } catch {
    return {
      dir: null,
      carried: [],
      dropped: enabled.map((entry) => ({ name: entry.name, reason: "the worktree is not readable" }))
    };
  }

  const carried: ReadSkill[] = [];
  const dropped: { name: string; reason: string }[] = [];
  for (const entry of enabled.slice(0, MAX_PROJECT_SKILLS)) {
    // Defensive: the wire refuses these shapes already, and a name that could
    // be a path must still never reach a join.
    if (!SkillNameSchema.safeParse(entry.name).success) {
      dropped.push({ name: entry.name.slice(0, 80), reason: "not a name this runner will resolve" });
      continue;
    }
    const read = readSkill(root, entry.name);
    if ("reason" in read) {
      dropped.push({ name: entry.name, reason: read.reason });
      continue;
    }
    if (read.skill.digest !== entry.digest) {
      dropped.push({ name: entry.name, reason: "changed since it was enabled" });
      continue;
    }
    carried.push(read);
  }
  if (carried.length === 0) return { dir: null, carried: [], dropped };

  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(join(stagingDir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(stagingDir, ".claude-plugin", "plugin.json"), PLUGIN_MANIFEST);
  for (const { skill, bytes } of carried) {
    const home = join(stagingDir, "skills", skill.name);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "SKILL.md"), bytes);
  }
  return { dir: stagingDir, carried: carried.map(({ skill }) => skill.name), dropped };
}

/** Removes a turn's composed directory; a turn's staging outlives nothing. */
export function removeComposedSkills(stagingDir: string): void {
  rmSync(stagingDir, { recursive: true, force: true });
}
