import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml, stringify as stringifyToml, TomlError } from "smol-toml";
import {
  DEFAULT_SETUP_TIMEOUT_MINUTES,
  DEFAULT_VERIFY_TIMEOUT_MINUTES,
  WorkspaceSettingsSchema,
  type SettingsScope,
  type WorkspaceSettings
} from "@novus/contracts";
import { isIgnoredByGit, type GitExec } from "./workspace-git";

/**
 * Workspace configuration (D-040): two TOML files under `.novus/` in the
 * worktree.
 *
 *  - `settings.toml` is committed, shared, and non-secret. It travels with the
 *    branch and is reviewed with the code it describes.
 *  - `settings.local.toml` is machine-local and git-ignored. It layers over the
 *    shared file key by key and is where this machine says what only it knows.
 *
 * Two rules the rest of the runtime depends on:
 *
 *  - A file that is present and wrong is an error, named and actionable, that
 *    says which file and what is wrong with it. Falling back to defaults would
 *    silently run a project a different way than its configuration asks for,
 *    which is worse than refusing.
 *  - Layering respects *presence*, not value. The schema fills defaults in, so
 *    a local file that simply does not mention `concurrentRuns` must not be
 *    read as setting it to `false`.
 */

export const NOVUS_DIR = ".novus";
export const SHARED_SETTINGS_FILE = "settings.toml";
export const LOCAL_SETTINGS_FILE = "settings.local.toml";

/** Relative to the worktree, which is how a person and git both name them. */
export const SHARED_SETTINGS_PATH = `${NOVUS_DIR}/${SHARED_SETTINGS_FILE}`;
export const LOCAL_SETTINGS_PATH = `${NOVUS_DIR}/${LOCAL_SETTINGS_FILE}`;

/** Names the file and the problem, because "invalid configuration" tells the
 *  person nothing about what to open or what to change. */
export class WorkspaceConfigError extends Error {
  readonly file: string;
  readonly problem: string;

  constructor(file: string, problem: string) {
    super(`${file}: ${problem}`);
    this.name = "WorkspaceConfigError";
    this.file = file;
    this.problem = problem;
  }
}

export function settingsPathFor(scope: SettingsScope): string {
  return scope === "shared" ? SHARED_SETTINGS_PATH : LOCAL_SETTINGS_PATH;
}

/** Which top-level keys the file actually wrote, as opposed to what the schema
 *  filled in afterwards. */
type SettingsKey = keyof WorkspaceSettings;

interface ScopedSettings {
  settings: WorkspaceSettings;
  present: ReadonlySet<SettingsKey>;
}

export interface LoadedWorkspaceSettings {
  /** Null when the file is absent — never when it is present and broken. */
  shared: WorkspaceSettings | null;
  local: WorkspaceSettings | null;
  /** Shared with local layered over it; the defaults when neither exists. */
  effective: WorkspaceSettings;
}

const SETTINGS_KEYS: SettingsKey[] = [
  "setup",
  "run",
  "defaultRun",
  "concurrentRuns",
  "verify",
  "autoVerify",
  "timeouts",
  "env",
  "secretNames",
  "localFiles"
];

/** A file this large is not configuration somebody wrote by hand. */
const MAX_SETTINGS_BYTES = 256 * 1024;

function readScoped(worktree: string, scope: SettingsScope): ScopedSettings | null {
  const relative = settingsPathFor(scope);
  const absolute = join(worktree, NOVUS_DIR, scope === "shared" ? SHARED_SETTINGS_FILE : LOCAL_SETTINGS_FILE);
  if (!existsSync(absolute)) return null;

  let raw: string;
  try {
    raw = readFileSync(absolute, "utf8");
  } catch (error) {
    throw new WorkspaceConfigError(relative, `could not be read (${messageOf(error)})`);
  }
  if (raw.length > MAX_SETTINGS_BYTES) {
    throw new WorkspaceConfigError(relative, "is too large to be workspace configuration");
  }

  let document: unknown;
  try {
    document = parseToml(raw);
  } catch (error) {
    throw new WorkspaceConfigError(relative, tomlProblem(error));
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new WorkspaceConfigError(relative, "is not a TOML table");
  }

  const parsed = WorkspaceSettingsSchema.safeParse(document);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.join(".")} ` : "";
    throw new WorkspaceConfigError(relative, `${where}${issue?.message ?? "is not valid workspace configuration"}`);
  }

  const written = document as Record<string, unknown>;
  const present = new Set<SettingsKey>(SETTINGS_KEYS.filter((key) => written[key] !== undefined));
  return { settings: parsed.data, present };
}

function tomlProblem(error: unknown): string {
  if (error instanceof TomlError) {
    // smol-toml's own message already names the offence; the position is what
    // turns it into something a person can act on.
    return `is not valid TOML — ${error.message.split("\n")[0] ?? "parse failed"} (line ${error.line}, column ${error.column})`;
  }
  return `is not valid TOML (${messageOf(error)})`;
}

/**
 * Shared underneath, local on top, key by key.
 *
 *  - `run` and `verify` merge by `name`: a local entry with the same name
 *    replaces the shared one, and a name only the machine knows is appended.
 *    Replacing the whole list would force a machine that overrides one command
 *    to restate every other.
 *  - `env`, `secretNames`, and `localFiles` merge, local winning: they are
 *    additive statements about what this machine supplies.
 *  - `setup`, `defaultRun`, and `concurrentRuns` are single values and are
 *    replaced wholesale when the local file states them.
 */
function layer(shared: ScopedSettings | null, local: ScopedSettings | null): WorkspaceSettings {
  const base = shared?.settings ?? WorkspaceSettingsSchema.parse({});
  if (!local) return base;
  const over = local.settings;
  const states = (key: SettingsKey): boolean => local.present.has(key);

  return {
    setup: states("setup") ? over.setup : base.setup,
    run: mergeNamed(base.run, states("run") ? over.run : []),
    defaultRun: states("defaultRun") ? over.defaultRun : base.defaultRun,
    concurrentRuns: states("concurrentRuns") ? over.concurrentRuns : base.concurrentRuns,
    verify: mergeNamed(base.verify, states("verify") ? over.verify : []),
    autoVerify: states("autoVerify") ? over.autoVerify : base.autoVerify,
    // Single values, replaced wholesale when the local file states them: a
    // machine that overrides one deadline states both, which is one fewer way
    // for a layered timeout to be a surprise.
    timeouts: states("timeouts") ? over.timeouts : base.timeouts,
    env: { ...base.env, ...(states("env") ? over.env : {}) },
    secretNames: unique([...base.secretNames, ...(states("secretNames") ? over.secretNames : [])]),
    localFiles: unique([...base.localFiles, ...(states("localFiles") ? over.localFiles : [])])
  };
}

function mergeNamed<T extends { name: string }>(base: T[], over: T[]): T[] {
  const merged = base.map((entry) => over.find((candidate) => candidate.name === entry.name) ?? entry);
  const names = new Set(base.map((entry) => entry.name));
  return [...merged, ...over.filter((entry) => !names.has(entry.name))];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** Reads both files from the worktree and layers them. Throws — by name — when
 *  either file is present and cannot be trusted. */
export function loadWorkspaceSettings(worktree: string): LoadedWorkspaceSettings {
  const shared = readScoped(worktree, "shared");
  const local = readScoped(worktree, "local");
  return {
    shared: shared?.settings ?? null,
    local: local?.settings ?? null,
    effective: layer(shared, local)
  };
}

// --- Writing -----------------------------------------------------------------

const SHARED_HEADER = [
  "# Novus workspace configuration — committed, shared, reviewed with the code.",
  "# It says how to install, run, and verify this project. Never put a secret",
  "# value here: name the variable under `secretNames` and supply the value on",
  "# the machine that has it.",
  ""
].join("\n");

const LOCAL_HEADER = [
  "# Novus machine-local workspace configuration. Git-ignored on purpose: it",
  "# describes this machine, not the project, and it overrides the shared file",
  "# key by key. Secret *values* are never written here — they live in this",
  "# operating system's credential store.",
  ""
].join("\n");

/** Drops what the schema would fill in anyway, so the file a person opens is
 *  the decisions somebody made and not a printout of the defaults. */
function toDocument(settings: WorkspaceSettings): Record<string, unknown> {
  const document: Record<string, unknown> = {};
  if (settings.defaultRun !== undefined) document.defaultRun = settings.defaultRun;
  if (settings.concurrentRuns) document.concurrentRuns = true;
  if (!settings.autoVerify) document.autoVerify = false;
  if (settings.secretNames.length > 0) document.secretNames = settings.secretNames;
  if (settings.localFiles.length > 0) document.localFiles = settings.localFiles;
  if (
    settings.timeouts.setupMinutes !== DEFAULT_SETUP_TIMEOUT_MINUTES ||
    settings.timeouts.verifyMinutes !== DEFAULT_VERIFY_TIMEOUT_MINUTES
  ) {
    document.timeouts = settings.timeouts;
  }
  if (settings.setup !== undefined) document.setup = prune(settings.setup);
  if (settings.run.length > 0) document.run = settings.run.map(prune);
  if (settings.verify.length > 0) document.verify = settings.verify.map(prune);
  if (Object.keys(settings.env).length > 0) document.env = settings.env;
  return document;
}

function prune<T extends object>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

export function serializeWorkspaceSettings(scope: SettingsScope, settings: WorkspaceSettings): string {
  const header = scope === "shared" ? SHARED_HEADER : LOCAL_HEADER;
  const body = stringifyToml(toDocument(settings));
  return `${header}\n${body.trim()}\n`;
}

/**
 * Writes one of the two files, creating `.novus/` if it is missing.
 *
 * The local file is written at 0600 and, before anything else, made
 * uncommittable: a machine-local file that a `git add -A` could sweep into a
 * pull request is a leak waiting for a distracted afternoon.
 */
export async function writeWorkspaceSettings(
  git: GitExec,
  worktree: string,
  scope: SettingsScope,
  settings: WorkspaceSettings
): Promise<void> {
  const directory = join(worktree, NOVUS_DIR);
  const relative = settingsPathFor(scope);
  try {
    mkdirSync(directory, { recursive: true });
  } catch (error) {
    throw new WorkspaceConfigError(relative, `could not be created (${messageOf(error)})`);
  }

  if (scope === "local") await ensureLocalSettingsIgnored(git, worktree);

  try {
    writeFileSync(join(worktree, relative), serializeWorkspaceSettings(scope, settings), {
      mode: scope === "local" ? 0o600 : 0o644
    });
  } catch (error) {
    throw new WorkspaceConfigError(relative, `could not be written (${messageOf(error)})`);
  }
}

/** Appends the machine-local file to `.gitignore` unless git already ignores
 *  it. Git is asked rather than the file read, because an ignore rule can come
 *  from a parent directory, a global file, or a pattern that does not mention
 *  the name at all. */
export async function ensureLocalSettingsIgnored(git: GitExec, worktree: string): Promise<void> {
  if (await isIgnoredByGit(git, worktree, LOCAL_SETTINGS_PATH)) return;
  const gitignore = join(worktree, ".gitignore");
  let existing = "";
  try {
    if (existsSync(gitignore)) existing = readFileSync(gitignore, "utf8");
  } catch {
    existing = "";
  }
  if (existing.split(/\r?\n/).some((line) => line.trim() === LOCAL_SETTINGS_PATH)) return;
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  const block = `${separator}\n# Novus machine-local workspace settings; never committed.\n${LOCAL_SETTINGS_PATH}\n`;
  writeFileSync(gitignore, `${existing}${block}`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown failure";
}
