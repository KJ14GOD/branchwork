import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DictationEnginesSchema, DictionarySchema, type DictationEngines } from "@novus/contracts";

/**
 * What this machine keeps for dictation (D-240, D-241): one preferences
 * file — whether the final pass runs, the person's own dictionary, and the
 * engines the last probe found on this Mac. No key, no credential, nothing
 * a vendor issued: the hearing is the system's own recognizer and the
 * editing is the machine's own coding agent CLI on the person's login.
 */

export interface DictationPrefs {
  refine: boolean;
  dictionary: string[];
  engines: DictationEngines | null;
}

const DEFAULT_PREFS: DictationPrefs = { refine: true, dictionary: [], engines: null };

export class DictationStore {
  constructor(private readonly deps: { userDataPath: string }) {}

  private prefsPath(): string {
    return join(this.deps.userDataPath, "dictation.json");
  }

  prefs(): DictationPrefs {
    try {
      const path = this.prefsPath();
      if (!existsSync(path)) return { ...DEFAULT_PREFS };
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<DictationPrefs>;
      const dictionary = DictionarySchema.safeParse(raw.dictionary);
      const engines = DictationEnginesSchema.nullable().safeParse(raw.engines ?? null);
      return {
        refine: typeof raw.refine === "boolean" ? raw.refine : DEFAULT_PREFS.refine,
        dictionary: dictionary.success ? dictionary.data : [],
        engines: engines.success ? engines.data : null
      };
    } catch {
      return { ...DEFAULT_PREFS };
    }
  }

  setPrefs(partial: { refine?: boolean; dictionary?: string[] }): DictationPrefs {
    const next = { ...this.prefs() };
    if (partial.refine !== undefined) next.refine = partial.refine;
    if (partial.dictionary !== undefined) {
      // Tidied, never refused: a blank line or a duplicate is not an error a
      // person should have to read about.
      const seen = new Set<string>();
      next.dictionary = partial.dictionary
        .map((word) => word.trim())
        .filter((word) => word.length > 0 && !seen.has(word.toLowerCase()) && seen.add(word.toLowerCase()));
    }
    this.write(next);
    return next;
  }

  setEngines(engines: DictationEngines | null): DictationPrefs {
    const next = { ...this.prefs(), engines };
    this.write(next);
    return next;
  }

  private write(prefs: DictationPrefs): void {
    mkdirSync(this.deps.userDataPath, { recursive: true });
    writeFileSync(this.prefsPath(), JSON.stringify(prefs, null, 2), { mode: 0o600 });
  }
}
