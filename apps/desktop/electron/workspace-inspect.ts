import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceProposal, WorkspaceSettings } from "@novus/contracts";
import { loadWorkspaceSettings, WorkspaceConfigError } from "./workspace-config";
import { isIgnoredByGit, type GitExec } from "./workspace-git";

/**
 * Reading a project and saying what Novus *would* propose (D-040). Nothing here
 * executes a project command: a proposal is a sentence, and only an explicit
 * confirmation that writes it to `.novus/settings.toml` makes it a command.
 *
 * The signals are the ones a person would look at — the package manifest, the
 * lockfile that names the package manager, a Makefile, a justfile, a Taskfile,
 * a language manifest, an `.env.example`, a `.worktreeinclude`, and the
 * commands a README states in a fenced block. Prose is not interpreted beyond
 * that: a guess dressed as understanding is worse than saying nothing.
 *
 * `localFiles` carries filenames and three facts, and `gitIgnored` is answered
 * by git rather than by the shape of the name — `.env.defaults` is a committed
 * file in plenty of projects and `config.yaml` is ignored in plenty of others.
 */

type RunProposal = WorkspaceProposal["run"][number];
type VerifyProposal = WorkspaceProposal["verify"][number];

export interface InspectionInput {
  git: GitExec;
  /** The workstream's worktree: what the project looks like right now. */
  worktree: string;
  /** The user's own checkout, where an ignored file may still be found. */
  sourceRepo: string;
  /** Variable names this machine has actually supplied a value for. */
  suppliedSecrets: readonly string[];
}

/** Reading is bounded: a manifest or a README is configuration, not a corpus. */
const MAX_READ_BYTES = 256 * 1024;

interface PackageManifest {
  name?: string;
  scripts?: Record<string, string>;
  packageManager?: string;
}

export async function inspectProject(input: InspectionInput): Promise<WorkspaceProposal> {
  const { worktree } = input;
  const signals: string[] = [];
  const blockers: string[] = [];

  let shared: WorkspaceSettings | null = null;
  let local: WorkspaceSettings | null = null;
  let effective: WorkspaceSettings | null = null;
  try {
    const loaded = loadWorkspaceSettings(worktree);
    shared = loaded.shared;
    local = loaded.local;
    effective = loaded.effective;
  } catch (error) {
    // Inspection is the surface built to say what stops this workspace running,
    // and a configuration file that cannot be trusted is exactly that. It is
    // named here rather than swallowed, and nothing falls back to defaults:
    // every path that would *run* something still refuses.
    blockers.push(
      error instanceof WorkspaceConfigError
        ? bounded(`${error.file} ${error.problem}`, 200)
        : "The workspace configuration could not be read."
    );
  }

  const manifest = readJson<PackageManifest>(join(worktree, "package.json"));
  if (manifest) signals.push("package.json");
  const lockfile = LOCKFILES.find((entry) => exists(worktree, entry.file));
  if (lockfile) signals.push(lockfile.file);
  const packageManager = resolvePackageManager(manifest, lockfile?.manager ?? null);

  const makefile = readText(join(worktree, "Makefile")) ?? readText(join(worktree, "makefile"));
  if (makefile !== null) signals.push("Makefile");
  const justfile = readText(join(worktree, "justfile")) ?? readText(join(worktree, "Justfile"));
  if (justfile !== null) signals.push("justfile");
  const taskfile =
    readText(join(worktree, "Taskfile.yml")) ?? readText(join(worktree, "Taskfile.yaml"));
  if (taskfile !== null) signals.push("Taskfile.yml");
  const pyproject = readText(join(worktree, "pyproject.toml"));
  if (pyproject !== null) signals.push("pyproject.toml");
  if (exists(worktree, "Cargo.toml")) signals.push("Cargo.toml");
  if (exists(worktree, "go.mod")) signals.push("go.mod");
  if (exists(worktree, "requirements.txt")) signals.push("requirements.txt");

  const documented = documentedCommands(worktree, signals);

  const run: RunProposal[] = [];
  const verify: VerifyProposal[] = [];
  let setup: string | null = null;

  if (manifest) {
    const scripts = manifest.scripts ?? {};
    setup = installCommand(packageManager);
    for (const script of Object.keys(scripts)) {
      const command = `${runPrefix(packageManager)} ${script}`;
      const category = verificationCategory(script);
      if (RUN_SCRIPTS.has(script)) {
        run.push({ name: commandName(script), command });
      } else if (category !== null) {
        verify.push({ name: commandName(script), command, category });
      }
    }
  }

  const makeTargets = makefile === null ? [] : parseMakeTargets(makefile);
  const justRecipes = justfile === null ? [] : parseJustRecipes(justfile);
  const taskNames = taskfile === null ? [] : parseTaskNames(taskfile);

  addTargets(run, verify, makeTargets, "make");
  addTargets(run, verify, justRecipes, "just");
  addTargets(run, verify, taskNames, "task");

  if (setup === null && makeTargets.includes("setup")) setup = "make setup";
  if (setup === null && makeTargets.includes("install")) setup = "make install";
  if (setup === null && pyproject !== null) setup = pythonInstall(worktree);
  if (setup === null && exists(worktree, "requirements.txt")) setup = "pip install -r requirements.txt";
  if (setup === null && exists(worktree, "Cargo.toml")) setup = "cargo fetch";
  if (setup === null && exists(worktree, "go.mod")) setup = "go mod download";
  if (setup === null) setup = documented.find((line) => INSTALL_HINT.test(line)) ?? null;

  if (exists(worktree, "Cargo.toml")) {
    pushVerify(verify, { name: "cargo-test", command: "cargo test", category: "test" });
    pushVerify(verify, { name: "cargo-build", command: "cargo build", category: "build" });
  }
  if (exists(worktree, "go.mod")) {
    pushVerify(verify, { name: "go-test", command: "go test ./...", category: "test" });
    pushVerify(verify, { name: "go-build", command: "go build ./...", category: "build" });
  }

  // A dev or start script is what the Run control offers first.
  const defaultRun = run.find((entry) => entry.name === "dev") ?? run[0];
  const ordered = defaultRun ? [defaultRun, ...run.filter((entry) => entry !== defaultRun)] : run;

  const localFiles = await inspectLocalFiles(input, effective, signals);

  // --- What actually stops this workspace running, in the product's words ---

  const configured = effective !== null && (effective.setup !== undefined || effective.run.length > 0);
  if (!configured && blockers.length === 0) {
    blockers.push("This project has not said how to install or run itself.");
  }
  for (const file of localFiles) {
    if (file.presentInWorkspace) continue;
    blockers.push(
      file.availableInSource
        ? bounded(`${file.path} is missing here; Novus can copy it from your checkout.`, 200)
        : bounded(`${file.path} is missing, and your checkout does not have it either.`, 200)
    );
  }
  const supplied = new Set(input.suppliedSecrets);
  for (const name of effective?.secretNames ?? []) {
    if (supplied.has(name)) continue;
    blockers.push(bounded(`This machine has not supplied a value for ${name}.`, 200));
  }

  return {
    projectType: describeProject(manifest, packageManager, pyproject !== null, worktree),
    signals: signals.slice(0, 40).map((signal) => bounded(signal, 120)),
    setup: setup === null ? null : bounded(setup, 400),
    run: ordered.slice(0, 20),
    verify: verify.slice(0, 20),
    localFiles,
    shared,
    local,
    blockers: blockers.slice(0, 20)
  };
}

// --- Local files -------------------------------------------------------------

async function inspectLocalFiles(
  input: InspectionInput,
  effective: WorkspaceSettings | null,
  signals: string[]
): Promise<WorkspaceProposal["localFiles"]> {
  const candidates = new Set<string>(effective?.localFiles ?? []);

  const include = readText(join(input.worktree, ".worktreeinclude"));
  if (include !== null) {
    signals.push(".worktreeinclude");
    for (const line of include.split(/\r?\n/)) {
      const path = line.trim();
      if (path === "" || path.startsWith("#")) continue;
      candidates.add(path.slice(0, 300));
    }
  }

  for (const [example, implied] of ENV_EXAMPLES) {
    if (!exists(input.worktree, example) && !exists(input.sourceRepo, example)) continue;
    signals.push(example);
    candidates.add(implied);
  }

  const files: WorkspaceProposal["localFiles"] = [];
  for (const path of [...candidates].slice(0, 100)) {
    const safe = !path.includes("\0") && !path.split(/[\\/]/).includes("..") && !path.startsWith("/");
    files.push({
      path,
      availableInSource: safe && exists(input.sourceRepo, path),
      presentInWorkspace: safe && exists(input.worktree, path),
      // Asked of git, never inferred from the name.
      gitIgnored: safe ? await isIgnoredByGit(input.git, input.sourceRepo, path) : false
    });
  }
  return files;
}

/** An example file and the real file it implies. */
const ENV_EXAMPLES: [string, string][] = [
  [".env.example", ".env"],
  [".env.sample", ".env"],
  [".env.template", ".env"],
  [".env.dist", ".env"],
  ["env.example", ".env"],
  [".env.local.example", ".env.local"]
];

// --- Package managers --------------------------------------------------------

type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

const LOCKFILES: { file: string; manager: PackageManager }[] = [
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "package-lock.json", manager: "npm" },
  { file: "yarn.lock", manager: "yarn" },
  { file: "bun.lockb", manager: "bun" }
];

function resolvePackageManager(
  manifest: PackageManifest | null,
  fromLockfile: PackageManager | null
): PackageManager {
  const declared = manifest?.packageManager;
  if (typeof declared === "string") {
    const name = declared.split("@")[0];
    if (name === "pnpm" || name === "npm" || name === "yarn" || name === "bun") return name;
  }
  return fromLockfile ?? "npm";
}

function installCommand(manager: PackageManager): string {
  return manager === "npm" ? "npm install" : `${manager} install`;
}

function runPrefix(manager: PackageManager): string {
  return manager === "yarn" ? "yarn" : `${manager} run`;
}

function pythonInstall(worktree: string): string {
  if (exists(worktree, "uv.lock")) return "uv sync";
  if (exists(worktree, "poetry.lock")) return "poetry install";
  return "pip install -e .";
}

// --- Script and target classification ---------------------------------------

const RUN_SCRIPTS = new Set(["dev", "start", "serve", "develop"]);

/** Deliberately conservative: a script whose name does not clearly state what
 *  kind of check it is produces no proposal at all, which is the same rule
 *  D-037 applies to observed verification. */
function verificationCategory(script: string): VerifyProposal["category"] | null {
  const name = script.toLowerCase();
  if (name === "test" || name.startsWith("test:") || name === "tests") return "test";
  if (name === "typecheck" || name === "type-check" || name === "types" || name === "tsc") return "typecheck";
  if (name === "lint" || name.startsWith("lint:")) return "lint";
  if (name === "build") return "build";
  return null;
}

function addTargets(
  run: RunProposal[],
  verify: VerifyProposal[],
  targets: readonly string[],
  tool: string
): void {
  for (const target of targets) {
    const command = `${tool} ${target}`;
    if (RUN_SCRIPTS.has(target) || target === "run") {
      if (!run.some((entry) => entry.name === commandName(target))) {
        run.push({ name: commandName(target), command });
      }
      continue;
    }
    const category = verificationCategory(target);
    if (category !== null) pushVerify(verify, { name: commandName(target), command, category });
  }
}

function pushVerify(verify: VerifyProposal[], entry: VerifyProposal): void {
  if (verify.some((existing) => existing.name === entry.name)) return;
  verify.push(entry);
}

/** The contract's command names are lowercase and hyphenated; a script called
 *  `test:unit` still needs a name Novus can address it by. */
function commandName(raw: string): string {
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 40);
  return name === "" ? "command" : name;
}

function parseMakeTargets(contents: string): string[] {
  const targets: string[] = [];
  for (const line of contents.split(/\r?\n/).slice(0, 2000)) {
    const match = /^([a-zA-Z0-9][a-zA-Z0-9_.-]*)\s*:(?!=)/.exec(line);
    if (match?.[1] !== undefined && !targets.includes(match[1])) targets.push(match[1]);
  }
  return targets;
}

function parseJustRecipes(contents: string): string[] {
  const recipes: string[] = [];
  for (const line of contents.split(/\r?\n/).slice(0, 2000)) {
    const match = /^([a-zA-Z0-9][a-zA-Z0-9_-]*)(\s+[^:]*)?:(?!=)/.exec(line);
    if (match?.[1] !== undefined && !recipes.includes(match[1])) recipes.push(match[1]);
  }
  return recipes;
}

function parseTaskNames(contents: string): string[] {
  const names: string[] = [];
  let inTasks = false;
  for (const line of contents.split(/\r?\n/).slice(0, 2000)) {
    if (/^tasks:\s*$/.test(line)) {
      inTasks = true;
      continue;
    }
    if (inTasks && /^\S/.test(line)) inTasks = false;
    const match = /^\s{2}([a-zA-Z0-9][a-zA-Z0-9_:-]*):\s*$/.exec(line);
    if (inTasks && match?.[1] !== undefined && !names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

// --- Documentation -----------------------------------------------------------

const DOC_FILES = ["README.md", "README", "readme.md", "CONTRIBUTING.md", "docs/CONTRIBUTING.md"];
const COMMAND_HINT =
  /^(?:\$\s+)?((?:pnpm|npm|yarn|bun|make|just|task|cargo|go|poetry|uv|pip|pytest|docker compose|docker-compose)\s+[^\n]{1,180})$/;
const INSTALL_HINT = /\b(install|sync|fetch|bootstrap|setup)\b/;

/**
 * Commands a project states in a fenced block. This is the whole of Novus's
 * "reading the documentation": a line inside a code fence that begins with a
 * tool everyone recognises. No sentence is interpreted, and nothing found here
 * runs — at most it becomes a proposal somebody has to confirm.
 */
function documentedCommands(worktree: string, signals: string[]): string[] {
  const found: string[] = [];
  for (const file of DOC_FILES) {
    const contents = readText(join(worktree, file));
    if (contents === null) continue;
    signals.push(file);
    let fenced = false;
    for (const line of contents.split(/\r?\n/).slice(0, 3000)) {
      if (line.trimStart().startsWith("```")) {
        fenced = !fenced;
        continue;
      }
      if (!fenced) continue;
      const match = COMMAND_HINT.exec(line.trim());
      const command = match?.[1];
      if (command !== undefined && !found.includes(command)) found.push(command);
      if (found.length >= 8) return found;
    }
  }
  return found;
}

// --- Small readers -----------------------------------------------------------

function describeProject(
  manifest: PackageManifest | null,
  manager: PackageManager,
  python: boolean,
  worktree: string
): string {
  if (manifest) return `Node.js (${manager})`;
  if (python) return "Python";
  if (exists(worktree, "requirements.txt")) return "Python";
  if (exists(worktree, "Cargo.toml")) return "Rust";
  if (exists(worktree, "go.mod")) return "Go";
  if (exists(worktree, "Makefile") || exists(worktree, "makefile")) return "Make";
  return "Unrecognized";
}

function exists(root: string, relative: string): boolean {
  try {
    return existsSync(join(root, relative));
  } catch {
    return false;
  }
}

function readText(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    if (statSync(path).size > MAX_READ_BYTES) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function readJson<T>(path: string): T | null {
  const raw = readText(path);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as T;
  } catch {
    return null;
  }
}

function bounded(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
