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
import { homedir } from "node:os";
import { join, sep } from "node:path";
import {
  MAX_GLOBAL_SKILLS,
  MAX_PROJECT_SKILLS,
  MAX_PROJECT_SLASH_COMMANDS,
  MAX_SKILL_BYTES,
  SKILL_DESCRIPTION_MAX,
  SkillNameSchema,
  type CarriedSkill,
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
/** And its slash commands (D-187): one prompt template per `<name>.md`. */
const COMMANDS_DIR = [".claude", "commands"] as const;

const PLUGIN_MANIFEST = JSON.stringify(
  {
    name: "novus-project-skills",
    version: "0.0.0",
    description:
      "Skills and slash commands a participant enabled from this project's own .claude directory, composed by Novus (D-118, D-187). Instructions only — never hooks, MCP servers, or agents."
  },
  null,
  2
);

export interface ComposedSkills {
  /** The directory to hand `--plugin-dir`, or null when nothing was carried. */
  dir: string | null;
  /** The skills the turn carries, each at the digest that ran (D-193). */
  carried: CarriedSkill[];
  /** The enabled skills this turn could not carry, each with the reason. */
  dropped: { name: string; reason: string }[];
  /** The slash commands the turn carries (D-187), invocable in a direction
   *  as `/novus-project-skills:<name>`. */
  carriedCommands: CarriedSkill[];
  /** The enabled commands this turn could not carry, each with the reason. */
  droppedCommands: { name: string; reason: string }[];
  /** The machine skills the turn carries (D-191) — the operator's own, which
   *  do not load by themselves under the pinned argv. */
  carriedGlobals: CarriedSkill[];
  /** The enabled machine skills this turn could not carry, with reasons. */
  droppedGlobals: { name: string; reason: string }[];
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

/**
 * One slash command, read and verified under the skills' own rules (D-187):
 * `.claude/commands/<name>.md`, resolved through `realpath`, inside the
 * worktree, a regular non-empty bounded file. The name is the filename minus
 * `.md`, under the skill-name grammar, so it can never be a traversal.
 */
function readCommand(root: string, name: string): ReadSkill | { reason: string } {
  const candidate = join(root, ...COMMANDS_DIR, `${name}.md`);
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
  if (stats.size > MAX_SKILL_BYTES) return { reason: "larger than a command can be" };
  try {
    const bytes = readFileSync(real);
    return { skill: sealSkill(name, bytes), bytes };
  } catch {
    return { reason: "could not be read" };
  }
}

/**
 * The slash-command manifest the runner publishes (D-187): every well-named
 * `<name>.md` in `.claude/commands`, in name order, bounded — the same
 * review-then-enable list the skills ride, from the sibling directory.
 */
export function discoverProjectCommands(worktreePath: string): ProjectSkill[] {
  let root: string;
  try {
    root = realpathSync(worktreePath);
  } catch {
    return [];
  }
  const dir = join(root, ...COMMANDS_DIR);
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return [];
  }
  const commands: ProjectSkill[] = [];
  for (const entry of entries) {
    if (commands.length >= MAX_PROJECT_SLASH_COMMANDS) break;
    if (!entry.endsWith(".md")) continue;
    const name = entry.slice(0, -3);
    if (!SkillNameSchema.safeParse(name).success) continue;
    const read = readCommand(root, name);
    if ("reason" in read) continue;
    commands.push(read.skill);
  }
  return commands;
}

function sealSkill(name: string, bytes: Buffer): ProjectSkill {
  const body = bytes.toString("utf8");
  return {
    name,
    description: frontmatterDescription(body),
    digest: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
    modelInvocable: !frontmatterDisablesModelInvocation(body)
  };
}

/**
 * Whether the SKILL.md forbids the harness reaching for it on its own
 * (D-192): `disable-model-invocation: true` in the frontmatter. Read the same
 * lenient way the description is — a malformed or absent field means the
 * ordinary case, where the model decides from the description.
 */
function frontmatterDisablesModelInvocation(body: string): boolean {
  if (!body.startsWith("---")) return false;
  const end = body.indexOf("\n---", 3);
  if (end === -1) return false;
  for (const line of body.slice(0, end).split("\n")) {
    const match = /^disable-model-invocation:\s*(.+?)\s*$/.exec(line);
    if (match) return match[1]?.trim().replace(/^["']|["']$/g, "").toLowerCase() === "true";
  }
  return false;
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
 * Where the CLI keeps this machine's user-level skills: `$CLAUDE_CONFIG_DIR`
 * when the operator set one, `~/.claude` otherwise — the same resolution the
 * CLI itself performs, because what is published must be what loads.
 */
function globalSkillsDir(env: NodeJS.ProcessEnv = process.env): string {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  return join(configDir && configDir.length > 0 ? configDir : join(homedir(), ".claude"), "skills");
}

/**
 * The runner machine's own user-level skills (D-186). The CLI loads these into
 * every turn no matter what Novus pins — D-118 measured it and left it as a
 * stated limit — so the honest move is to publish what rides along: name,
 * description, size, digest, never bodies. Display only; nothing here is ever
 * enabled, pinned, or composed, so the same read bounds apply but not the
 * worktree containment — a personal skill symlinked out of a dotfiles
 * repository still loads, and a listing that skipped it would be a lie.
 */
export function discoverGlobalSkills(env: NodeJS.ProcessEnv = process.env): ProjectSkill[] {
  let dir: string;
  try {
    dir = realpathSync(globalSkillsDir(env));
  } catch {
    return [];
  }
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return [];
  }
  const skills: ProjectSkill[] = [];
  for (const name of entries) {
    if (skills.length >= MAX_GLOBAL_SKILLS) break;
    if (!SkillNameSchema.safeParse(name).success) continue;
    const candidate = join(dir, name, "SKILL.md");
    let stats;
    try {
      stats = statSync(candidate);
    } catch {
      continue;
    }
    if (!stats.isFile() || stats.size === 0 || stats.size > MAX_SKILL_BYTES) continue;
    try {
      skills.push(sealSkill(name, readFileSync(candidate)));
    } catch {
      continue;
    }
  }
  return skills;
}

/**
 * One machine skill, read from the operator's own config dir (D-191).
 *
 * The worktree containment rule deliberately does not apply: this directory is
 * the person's own, outside any repository, and a personal skill symlinked out
 * of a dotfiles checkout is ordinary. What still applies is everything that
 * bounds what may be loaded — a real file, non-empty, under the size cap, and
 * the digest the person reviewed.
 */
function readGlobalSkill(name: string, env: NodeJS.ProcessEnv): ReadSkill | { reason: string } {
  const candidate = join(globalSkillsDir(env), name, "SKILL.md");
  let stats;
  try {
    stats = statSync(candidate);
  } catch {
    return { reason: "no longer on this machine" };
  }
  if (!stats.isFile()) return { reason: "not a regular file" };
  if (stats.size === 0) return { reason: "empty" };
  if (stats.size > MAX_SKILL_BYTES) return { reason: "larger than a skill can be" };
  try {
    const bytes = readFileSync(candidate);
    return { skill: sealSkill(name, bytes), bytes };
  } catch {
    return { reason: "could not be read" };
  }
}

/**
 * One turn's skills-only plugin directory, composed from the pinned enabled
 * list. The verified bytes are the written bytes: a worktree edit between the
 * digest check and the harness reading the composed copy changes nothing,
 * because the harness never reads the worktree's copy at load time at all.
 */
export function composeSkillsPlugin(
  worktreePath: string,
  stagingDir: string,
  env: NodeJS.ProcessEnv = process.env
): ComposedSkills {
  const none: ComposedSkills = {
    dir: null,
    carried: [],
    dropped: [],
    carriedCommands: [],
    droppedCommands: [],
    carriedGlobals: [],
    droppedGlobals: []
  };

  // Everything this machine can see, read fresh at spawn (D-193). There is no
  // enabled list to consult any more: what a project declares and what the
  // operator's own directory holds are carried, and the turn's record says
  // exactly which bytes those were. The bounds that decide what is *loadable*
  // still apply — name grammar, worktree containment for repository content,
  // regular file, non-empty, size cap — because they are what keep a path
  // from being a traversal and a generated file from being the whole prompt.
  const skills = discoverProjectSkills(worktreePath);
  const commands = discoverProjectCommands(worktreePath);
  const globals = discoverGlobalSkills(env);
  if (skills.length === 0 && commands.length === 0 && globals.length === 0) return none;

  let root: string;
  try {
    root = realpathSync(worktreePath);
  } catch {
    return none;
  }

  const readAll = (
    entries: readonly ProjectSkill[],
    read: (name: string) => ReadSkill | { reason: string }
  ): { carried: ReadSkill[]; dropped: { name: string; reason: string }[] } => {
    const carried: ReadSkill[] = [];
    const dropped: { name: string; reason: string }[] = [];
    for (const entry of entries) {
      const result = read(entry.name);
      if ("reason" in result) {
        dropped.push({ name: entry.name, reason: result.reason });
        continue;
      }
      carried.push(result);
    }
    return { carried, dropped };
  };

  const readSkills = readAll(skills, (name) => readSkill(root, name));
  const readCommands = readAll(commands, (name) => readCommand(root, name));
  const readGlobals = readAll(globals, (name) => readGlobalSkill(name, env));
  if (
    readSkills.carried.length === 0 &&
    readCommands.carried.length === 0 &&
    readGlobals.carried.length === 0
  ) {
    return {
      ...none,
      dropped: readSkills.dropped,
      droppedCommands: readCommands.dropped,
      droppedGlobals: readGlobals.dropped
    };
  }

  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(join(stagingDir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(stagingDir, ".claude-plugin", "plugin.json"), PLUGIN_MANIFEST);
  for (const { skill, bytes } of [...readSkills.carried, ...readGlobals.carried]) {
    const home = join(stagingDir, "skills", skill.name);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "SKILL.md"), bytes);
  }
  for (const { skill, bytes } of readCommands.carried) {
    mkdirSync(join(stagingDir, "commands"), { recursive: true });
    writeFileSync(join(stagingDir, "commands", `${skill.name}.md`), bytes);
  }
  const carriedOf = ({ skill }: ReadSkill) => ({ name: skill.name, digest: skill.digest });
  return {
    dir: stagingDir,
    carried: readSkills.carried.map(carriedOf),
    dropped: readSkills.dropped,
    carriedCommands: readCommands.carried.map(carriedOf),
    droppedCommands: readCommands.dropped,
    carriedGlobals: readGlobals.carried.map(carriedOf),
    droppedGlobals: readGlobals.dropped
  };
}

/** Removes a turn's composed directory; a turn's staging outlives nothing. */
export function removeComposedSkills(stagingDir: string): void {
  rmSync(stagingDir, { recursive: true, force: true });
}
