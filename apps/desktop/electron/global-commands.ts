import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { GlobalSlashCommandsSchema, MAX_GLOBAL_SLASH_COMMANDS, SkillNameSchema } from "@novus/contracts";

/**
 * The harness's own slash commands (D-188): built-ins and the operator's
 * user-level commands, which the CLI loads into every turn regardless of the
 * pinned settings — the command half of D-186's fact.
 *
 * There is no file to discover these from: built-ins are the CLI's own. The
 * one honest source is the CLI itself — every session's `system/init` line
 * enumerates `slash_commands` — so the capture is taken from the stream the
 * runner already parses, remembered on this machine, and published on the
 * next `workspace.declared` like the global skills are. Names only, already
 * loaded, nothing to enable: the composer's / menu offers them because they
 * genuinely work when typed.
 *
 * What is deliberately not kept: the CLI's `terminal_slash_commands` (its own
 * word for commands that only draw terminal UI), and any plugin-scoped name
 * carrying a colon — the composed plugin's own commands are the repo group,
 * governed and listed with their descriptions, and no other plugin can load
 * under the pinned argv.
 */

function storePath(userDataPath: string): string {
  return join(userDataPath, "global-slash-commands.json");
}

/** The last capture, validated; a missing or malformed store reads as none. */
export function recallGlobalSlashCommands(userDataPath: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(storePath(userDataPath), "utf8"));
    return GlobalSlashCommandsSchema.catch([]).parse(raw);
  } catch {
    return [];
  }
}

/**
 * Remembers what a session's init line announced. Filtered to names the
 * schema can carry, sorted and bounded so the store is stable; an unchanged
 * capture writes nothing. Returns whether the stored list changed, so the
 * caller can republish the manifest the moment the machine learns something
 * new rather than waiting for the next announce.
 */
export function captureGlobalSlashCommands(
  userDataPath: string,
  announced: readonly string[],
  terminalOnly: readonly string[] = []
): boolean {
  const excluded = new Set(terminalOnly);
  const names = [
    ...new Set(
      announced.filter(
        (name) =>
          typeof name === "string" &&
          !excluded.has(name) &&
          !name.includes(":") &&
          SkillNameSchema.safeParse(name).success
      )
    )
  ]
    .sort()
    .slice(0, MAX_GLOBAL_SLASH_COMMANDS);
  const previous = recallGlobalSlashCommands(userDataPath);
  if (previous.length === names.length && previous.every((name, index) => name === names[index])) {
    return false;
  }
  try {
    const target = storePath(userDataPath);
    mkdirSync(dirname(target), { recursive: true });
    // Written beside and renamed in: a capture torn by a crash reads as
    // malformed and therefore as none, never as half a list.
    writeFileSync(`${target}.tmp`, JSON.stringify(names, null, 2));
    renameSync(`${target}.tmp`, target);
    return true;
  } catch {
    // A machine that cannot remember the list simply offers none; the next
    // session's init line is another chance.
    return false;
  }
}
