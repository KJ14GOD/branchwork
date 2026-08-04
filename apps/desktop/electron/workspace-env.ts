import { homedir } from "node:os";
import { join } from "node:path";
import type { WorkspaceSettings } from "@novus/contracts";

/**
 * The three execution environments (D-041). Nothing here inherits the parent
 * environment wholesale; each one is built from an allowlist, so a variable
 * reaches a child process because this file names it and for no other reason.
 *
 *  - `harnessEnv` — the operating-system base plus the harness's own
 *    credentials, so Claude Code keeps working under the user's existing local
 *    login. No project secret is ever in it.
 *  - `projectEnv` — the operating-system base, the Novus workspace variables,
 *    the project's declared values, and only the secrets the project's local
 *    configuration explicitly selected. The harness credential is never in it.
 *  - `terminalEnv` — the project environment plus the user's own shell profile,
 *    because it is their machine and their shell. It alone gets
 *    `NOVUS_WORKSPACE_DIR`: an absolute worktree path is a fact about somebody's
 *    laptop and does not belong in a variable a project command might echo into
 *    evidence.
 *
 * The allowlist is deliberately generous about things that are not secrets and
 * strict about things that are. A machine behind a corporate proxy, or one
 * whose CLI lives outside the login shell's PATH, must keep working; dropping a
 * variable to look tidy would break a real person's setup in a way no
 * deterministic test would notice.
 */

/** Variables a process needs in order to be a process on this machine. */
const OS_BASE = [
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TERM",
  "TZ",
  // Where a Linux desktop keeps per-user configuration; a CLI that stores its
  // login under XDG cannot find it without these.
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR"
] as const;

/** Windows cannot start a child process without most of these. */
const WINDOWS_BASE = [
  "SystemRoot",
  "SystemDrive",
  "windir",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "USERNAME",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "COMSPEC",
  "PATHEXT",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS"
] as const;

/**
 * Proxy and certificate settings. Every one of them is load-bearing on a
 * managed machine: without them neither the harness nor a project's package
 * manager can reach the network at all.
 *
 * The proxy variables are the exception to "none of this is a secret" —
 * `https_proxy` is conventionally written `http://user:password@proxy:3128`,
 * and a package manager that cannot reach it prints the whole URL in its error.
 * Stripping the credential is not an option, because then the proxy refuses and
 * nothing works; `proxyCredentials` below hands it to the redactor instead, so
 * the value is forwarded and never reported (D-052).
 */
const NETWORK_BASE = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE"
] as const;

/**
 * The harness's own credentials and configuration. Forwarded to the harness
 * process and to nothing else — this is the disclosure boundary D-041 exists to
 * draw. Prefix-matched rather than enumerated: an `ANTHROPIC_*` or `CLAUDE_*`
 * variable the user has set is part of how their local login works, and
 * guessing which ones matter is how a working installation gets broken.
 */
const HARNESS_PREFIXES = ["ANTHROPIC_", "CLAUDE_", "CODEX_", "OPENAI_"] as const;

/**
 * Cloud-provider credentials the harness uses only when it is pointed at
 * Bedrock or Vertex. Forwarded to the harness in that case alone, because
 * outside it they are somebody's cloud account and no business of a coding
 * agent's.
 */
const BEDROCK_VARS = [
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK"
] as const;
const VERTEX_VARS = ["GOOGLE_APPLICATION_CREDENTIALS", "CLOUD_ML_REGION", "GOOGLE_CLOUD_PROJECT"] as const;

/** Where a CLI installed outside the login shell's PATH usually lives. The
 *  project environment gets the same treatment: no profile is sourced for a
 *  project command either, so its tools have to be findable the same way. */
const EXTRA_UNIX_PATH = (home: string): string[] => [
  join(home, ".local", "bin"),
  join(home, "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin"
];

export type ProcessEnvironment = Record<string, string>;

/** The environment this Electron process was started with. Injectable so the
 *  construction rules can be tested without mutating the real one. */
export type SourceEnvironment = Readonly<Record<string, string | undefined>>;

function pick(source: SourceEnvironment, names: readonly string[], into: ProcessEnvironment): void {
  for (const name of names) {
    const value = source[name];
    if (typeof value === "string" && value !== "") into[name] = value;
  }
}

/** The PATH every Novus-spawned process gets: the parent's, plus the places a
 *  CLI is installed when the login shell was never consulted. */
export function novusPath(source: SourceEnvironment = process.env, platform = process.platform): string {
  const separator = platform === "win32" ? ";" : ":";
  const inherited = (source.PATH ?? source.Path ?? "").split(separator).filter((entry) => entry !== "");
  const home = source.HOME ?? source.USERPROFILE ?? homedir();
  const candidates = platform === "win32" ? inherited : [...inherited, ...EXTRA_UNIX_PATH(home)];
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const entry of candidates) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    ordered.push(entry);
  }
  return ordered.join(separator);
}

/** The operating-system floor both real environments are built on. */
function baseEnvironment(source: SourceEnvironment, platform: NodeJS.Platform): ProcessEnvironment {
  const env: ProcessEnvironment = {};
  pick(source, OS_BASE, env);
  pick(source, NETWORK_BASE, env);
  if (platform === "win32") pick(source, WINDOWS_BASE, env);
  // Always present, even when the parent had none: a child with no HOME cannot
  // find any per-user configuration, including the harness's own login.
  if (env.HOME === undefined && platform !== "win32") env.HOME = homedir();
  env.PATH = novusPath(source, platform);
  return env;
}

function isHarnessVariable(name: string): boolean {
  return HARNESS_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * The harness process's environment: the base, plus everything that makes the
 * user's own local harness login work, and nothing a project declared.
 *
 * Claude Code authenticates through the installation the person already signed
 * in to. On macOS that is an OAuth credential in the Keychain reached through
 * `HOME`; on other platforms it is a file under `~/.claude`, or an
 * `ANTHROPIC_*` variable, or a custom `CLAUDE_CONFIG_DIR`. All of them survive
 * here on purpose.
 */
export function harnessEnv(
  source: SourceEnvironment = process.env,
  platform: NodeJS.Platform = process.platform
): ProcessEnvironment {
  const env = baseEnvironment(source, platform);
  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== "string" || value === "") continue;
    if (isHarnessVariable(name)) env[name] = value;
  }
  if (source.CLAUDE_CODE_USE_BEDROCK === "1") pick(source, BEDROCK_VARS, env);
  if (source.CLAUDE_CODE_USE_VERTEX === "1") pick(source, VERTEX_VARS, env);
  return env;
}

/** What a project command is told about the workspace it is running in. */
export interface WorkspaceVariables {
  /** One active workspace per workstream, so this identifies both. */
  workspaceId: string;
  missionBranch: string;
  /** The port this particular command should listen on, when one applies. */
  port: number | null;
  portRangeStart: number | null;
  portRangeEnd: number | null;
}

function novusVariables(workspace: WorkspaceVariables): ProcessEnvironment {
  const env: ProcessEnvironment = {
    NOVUS_WORKSPACE_ID: workspace.workspaceId,
    NOVUS_MISSION_BRANCH: workspace.missionBranch
  };
  if (workspace.port !== null) env.NOVUS_PORT = String(workspace.port);
  if (workspace.portRangeStart !== null) env.NOVUS_PORT_RANGE_START = String(workspace.portRangeStart);
  if (workspace.portRangeEnd !== null) env.NOVUS_PORT_RANGE_END = String(workspace.portRangeEnd);
  return env;
}

/**
 * The environment for a project's own setup, run, and verification commands.
 *
 * `settings` is the already-layered configuration, so `settings.env` is the
 * shared file's values with the machine-local file's on top; `secrets` is what
 * this machine holds, and only the names the configuration selected are read
 * from it. The harness credential is structurally absent: the base is an
 * allowlist and this function never consults `HARNESS_PREFIXES`.
 */
export function projectEnv(
  workspace: WorkspaceVariables,
  settings: WorkspaceSettings,
  secrets: Readonly<Record<string, string>> = {},
  source: SourceEnvironment = process.env,
  platform: NodeJS.Platform = process.platform
): ProcessEnvironment {
  const env = baseEnvironment(source, platform);
  Object.assign(env, novusVariables(workspace));
  for (const [name, value] of Object.entries(settings.env)) env[name] = value;
  for (const name of settings.secretNames) {
    const value = secrets[name];
    if (typeof value === "string" && value !== "") env[name] = value;
  }
  return env;
}

/**
 * The interactive terminal's environment (D-042 keeps it to the person whose
 * machine this is). The PTY that would use it is deliberately not built in this
 * slice; the construction exists and is tested so the deferred slice inherits a
 * boundary rather than inventing one.
 *
 * `profile` is whatever the user's own login shell exports. It sits under the
 * project's declared values, so a project that pins a variable still gets it,
 * and above nothing that Novus decided — this is the user's shell.
 */
export interface TerminalEnvInput {
  workspace: WorkspaceVariables;
  settings: WorkspaceSettings;
  secrets?: Readonly<Record<string, string>>;
  /** What the user's own login shell exports. */
  profile?: Readonly<Record<string, string>>;
  /** The worktree the terminal opens in. */
  workspaceDir: string;
  source?: SourceEnvironment;
  platform?: NodeJS.Platform;
}

export function terminalEnv(input: TerminalEnvInput): ProcessEnvironment {
  const source = input.source ?? process.env;
  const platform = input.platform ?? process.platform;
  const env: ProcessEnvironment = baseEnvironment(source, platform);
  for (const [name, value] of Object.entries(input.profile ?? {})) {
    if (value !== "") env[name] = value;
  }
  Object.assign(env, projectEnv(input.workspace, input.settings, input.secrets ?? {}, source, platform));
  // The one environment allowed to know where the workspace is on disk.
  env.NOVUS_WORKSPACE_DIR = input.workspaceDir;
  return env;
}

/** True when a variable name carries the harness's own credentials. Exported so
 *  the assertion "no project command ever sees this" is testable by name. */
export function isHarnessCredentialName(name: string): boolean {
  return isHarnessVariable(name);
}

/**
 * The passwords inside whatever proxy configuration this machine forwards.
 *
 * Novus never asked for these and cannot be given them through Set up
 * workspace — they arrive from the environment the app was launched in — so
 * they are the one class of credential the redactor has to go and find rather
 * than be handed. Only the password is returned: the host, port, and username
 * are diagnostic, and an error that says which proxy refused is worth keeping.
 */
export function proxyCredentials(env: NodeJS.ProcessEnv = process.env): string[] {
  const found = new Set<string>();
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
    const raw = env[name];
    if (!raw) continue;
    try {
      const url = new URL(raw);
      // Decoded, because that is the form a tool prints it back in; and raw,
      // because some print it exactly as it was given.
      if (url.password) {
        found.add(url.password);
        found.add(decodeURIComponent(url.password));
      }
    } catch {
      // Not a URL. Nothing to take out of it, and nothing to report either.
    }
  }
  return [...found];
}
