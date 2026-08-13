import { createHash } from "node:crypto";
import type {
  DeclaredCommand,
  ProjectSkill,
  Readiness,
  ResolvedReadiness,
  WorkspaceSettings
} from "@novus/contracts";

/**
 * What a project declared, resolved once into immutable snapshots (D-043).
 *
 * The problem this solves is a real window, not a theoretical one. A
 * participant reads "run the test suite", presses it, and the control plane
 * authorizes *a name*. If the runner then re-opened `.novus/settings.toml` at
 * execution time, a harness turn that had edited that file in between would
 * decide what actually ran. The person authorized one thing and a different
 * thing happened, with no way to tell afterwards.
 *
 * So the name is what is authorized and the **snapshot** is what runs. The
 * runner publishes what it read; the control plane hands that exact snapshot
 * back with the command it enqueues; the runner executes it verbatim. Editing
 * the configuration changes what the *next* command will be — which is the
 * correct outcome, and a visible one, because the published list changes too.
 *
 * The digest exists so the two can be compared: same configuration, same
 * digest, on any machine, in any order of keys.
 */

/** Every field stated, so the digest does not depend on who parsed the file. */
function resolveReadiness(readiness: Readiness | undefined): ResolvedReadiness | null {
  if (readiness === undefined) return null;
  return {
    kind: readiness.kind,
    url: readiness.url ?? null,
    port: readiness.port ?? null,
    timeoutSeconds: readiness.timeoutSeconds,
    stopOnFailure: readiness.stopOnFailure
  };
}

/** Minutes to milliseconds, with the project's own default underneath. */
function timeoutMs(minutes: number | undefined, fallbackMinutes: number): number {
  return (minutes ?? fallbackMinutes) * 60_000;
}

/**
 * Separators no field can contain, so `a|b` and `ab|` can never hash alike.
 * Named rather than written inline, because a control character in a source
 * file is invisible to the next reader.
 */
const RECORD = "\u001e";
const UNIT = "\u001f";

/**
 * A stable string for exactly the fields that decide what runs. Written by hand
 * rather than `JSON.stringify` of the object, because key order and future
 * additions would silently change every digest.
 */
export function canonicalCommand(command: Omit<DeclaredCommand, "digest">): string {
  const readiness = command.readiness;
  return [
    command.kind,
    command.name,
    command.command,
    command.cwd ?? "",
    command.timeoutMs === null ? "" : String(command.timeoutMs),
    command.category ?? "",
    command.port === null ? "" : String(command.port),
    command.previewUrl ?? "",
    readiness === null
      ? ""
      : [
          readiness.kind,
          readiness.url ?? "",
          readiness.port === null ? "" : String(readiness.port),
          String(readiness.timeoutSeconds),
          String(readiness.stopOnFailure)
        ].join(UNIT)
  ].join(RECORD);
}

export function commandDigest(command: Omit<DeclaredCommand, "digest">): string {
  return createHash("sha256").update(canonicalCommand(command)).digest("hex").slice(0, 16);
}

function seal(command: Omit<DeclaredCommand, "digest">): DeclaredCommand {
  return { ...command, digest: commandDigest(command) };
}

/**
 * Every command this project declared, in the order the room shows them: the
 * setup command, then run commands with the default first, then checks.
 *
 * A run command carries no `timeoutMs` at all. That is not an oversight: a run
 * command is a server, and Novus imposes no ceiling on work it was told to keep
 * doing (D-034). Only finite commands have deadlines.
 */
export function declaredCommands(settings: WorkspaceSettings): DeclaredCommand[] {
  const out: DeclaredCommand[] = [];
  const timeouts = settings.timeouts;

  if (settings.setup !== undefined) {
    out.push(
      seal({
        kind: "setup",
        name: "setup",
        command: settings.setup.command,
        cwd: settings.setup.cwd ?? null,
        timeoutMs: timeoutMs(settings.setup.timeoutMinutes, timeouts.setupMinutes),
        category: null,
        port: null,
        previewUrl: null,
        readiness: null
      })
    );
  }

  const runs = [...settings.run].sort((a, b) => {
    const preferred = settings.defaultRun;
    if (preferred === undefined) return 0;
    return Number(b.name === preferred) - Number(a.name === preferred);
  });
  for (const run of runs) {
    out.push(
      seal({
        kind: "run",
        name: run.name,
        command: run.command,
        cwd: run.cwd ?? null,
        timeoutMs: null,
        category: null,
        port: run.port ?? null,
        previewUrl: run.previewUrl ?? null,
        readiness: resolveReadiness(run.readiness)
      })
    );
  }

  for (const check of settings.verify) {
    out.push(
      seal({
        kind: "verification",
        name: check.name,
        command: check.command,
        cwd: check.cwd ?? null,
        timeoutMs: timeoutMs(check.timeoutMinutes, timeouts.verifyMinutes),
        category: check.category,
        port: null,
        previewUrl: null,
        readiness: null
      })
    );
  }

  return out;
}

/** Whether two published lists say the same thing, so a re-read that changed
 *  nothing does not become an event. */
export function sameCommands(a: readonly DeclaredCommand[], b: readonly DeclaredCommand[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry.digest === b[index]?.digest);
}

/** The same question for the skill manifest (D-118): name-ordered lists, so
 *  index-wise digest equality is set equality. */
export function sameSkills(a: readonly ProjectSkill[], b: readonly ProjectSkill[]): boolean {
  return (
    a.length === b.length &&
    a.every((entry, index) => entry.name === b[index]?.name && entry.digest === b[index]?.digest)
  );
}
