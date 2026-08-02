import type { WorkspaceProposal, WorkspaceSettings } from "@novus/contracts";

/**
 * Pure reading of a `WorkspaceProposal` (D-040). Two questions get answered
 * here and nowhere else, because the Run control and the setup dialog must
 * never disagree about them:
 *
 *  1. What has the project actually *declared*? Only a declared command may be
 *     invoked; a command Novus merely inferred is a suggestion and has to be
 *     confirmed through the setup dialog first (DESIGN.md#component-behavior).
 *  2. What does the shared file say once the machine-local file is layered over
 *     it? `settings.local.toml` wins key by key (D-040).
 *
 * Nothing here executes, fetches, or fabricates: it reads one proposal.
 */

export type RunCommand = WorkspaceSettings["run"][number];
export type VerifyCommand = WorkspaceSettings["verify"][number];

export const EMPTY_SETTINGS: WorkspaceSettings = {
  run: [],
  concurrentRuns: false,
  verify: [],
  env: {},
  secretNames: [],
  localFiles: []
};

/** Commands layer by name: a local entry with the same name replaces the
 *  shared one, a new name is added. That is what "may override any command"
 *  means for a list (D-040). */
function mergeByName<T extends { name: string }>(base: T[], over: T[]): T[] {
  const merged = base.map((entry) => over.find((candidate) => candidate.name === entry.name) ?? entry);
  const names = new Set(base.map((entry) => entry.name));
  return [...merged, ...over.filter((entry) => !names.has(entry.name))];
}

/** What this project has declared, shared file layered with the local one.
 *  Null when the project has declared nothing at all yet. */
export function declaredSettings(proposal: WorkspaceProposal): WorkspaceSettings | null {
  const { shared, local } = proposal;
  if (!shared && !local) return null;
  if (!local) return shared;
  if (!shared) return local;
  return {
    setup: local.setup ?? shared.setup,
    run: mergeByName(shared.run, local.run),
    defaultRun: local.defaultRun ?? shared.defaultRun,
    concurrentRuns: local.concurrentRuns,
    verify: mergeByName(shared.verify, local.verify),
    env: { ...shared.env, ...local.env },
    secretNames: [...new Set([...shared.secretNames, ...local.secretNames])],
    localFiles: [...new Set([...shared.localFiles, ...local.localFiles])]
  };
}

/** The declared run commands, the default first (DESIGN.md#component-behavior). */
export function runsInOrder(settings: WorkspaceSettings): RunCommand[] {
  const preferred = settings.defaultRun;
  if (!preferred) return settings.run;
  const first = settings.run.filter((entry) => entry.name === preferred);
  return [...first, ...settings.run.filter((entry) => entry.name !== preferred)];
}

export interface CommandItem {
  kind: "setup" | "run" | "verification";
  /** Absent for setup: a project declares exactly one. */
  name?: string;
  /** What the menu row reads. */
  label: string;
  /** The command line itself, shown in mono so it is never mistaken for prose. */
  command: string;
  /** Novus inferred this one; it is not in the project's files. A suggestion
   *  never executes — pressing it opens the setup dialog to confirm it. */
  suggested: boolean;
  isDefault: boolean;
}

/**
 * Everything the Run control may list, in reading order: setup, then run
 * commands with the default first, then verification. Declared entries come
 * before suggestions of the same kind, and a suggestion whose name is already
 * declared disappears — the declaration is the truth.
 */
export function commandItems(proposal: WorkspaceProposal): CommandItem[] {
  const declared = declaredSettings(proposal);
  const items: CommandItem[] = [];

  const declaredSetup = declared?.setup?.command ?? null;
  if (declaredSetup) {
    items.push({ kind: "setup", label: "Setup", command: declaredSetup, suggested: false, isDefault: false });
  } else if (proposal.setup) {
    items.push({ kind: "setup", label: "Setup", command: proposal.setup, suggested: true, isDefault: false });
  }

  const declaredRuns = declared ? runsInOrder(declared) : [];
  const defaultRun = declared?.defaultRun ?? declaredRuns[0]?.name ?? null;
  for (const entry of declaredRuns) {
    items.push({
      kind: "run",
      name: entry.name,
      label: entry.name,
      command: entry.command,
      suggested: false,
      isDefault: entry.name === defaultRun
    });
  }
  for (const entry of proposal.run) {
    if (declaredRuns.some((declaredRun) => declaredRun.name === entry.name)) continue;
    items.push({
      kind: "run",
      name: entry.name,
      label: entry.name,
      command: entry.command,
      suggested: true,
      isDefault: false
    });
  }

  const declaredVerify = declared?.verify ?? [];
  for (const entry of declaredVerify) {
    items.push({
      kind: "verification",
      name: entry.name,
      label: entry.name,
      command: entry.command,
      suggested: false,
      isDefault: false
    });
  }
  for (const entry of proposal.verify) {
    if (declaredVerify.some((declaredCheck) => declaredCheck.name === entry.name)) continue;
    items.push({
      kind: "verification",
      name: entry.name,
      label: entry.name,
      command: entry.command,
      suggested: true,
      isDefault: false
    });
  }

  return items;
}

/** One editable line in the setup dialog. The name is fixed by the project;
 *  the command is what a person may correct before saving. */
export interface CommandDraft {
  name: string;
  command: string;
  suggested: boolean;
}

export interface SetupDraft {
  setup: string;
  setupSuggested: boolean;
  run: CommandDraft[];
  verify: CommandDraft[];
  defaultRun: string | null;
}

/** The dialog opens on what the project declared, filled in with what Novus
 *  would propose where the project said nothing. Nothing here runs. */
export function draftFrom(proposal: WorkspaceProposal): SetupDraft {
  const items = commandItems(proposal);
  const setup = items.find((item) => item.kind === "setup");
  const run = items.filter((item) => item.kind === "run");
  return {
    setup: setup?.command ?? "",
    setupSuggested: setup?.suggested ?? false,
    run: run.map((item) => ({ name: item.name ?? "", command: item.command, suggested: item.suggested })),
    verify: items
      .filter((item) => item.kind === "verification")
      .map((item) => ({ name: item.name ?? "", command: item.command, suggested: item.suggested })),
    defaultRun: run.find((item) => item.isDefault)?.name ?? run[0]?.name ?? null
  };
}

/**
 * The settings that get written to the chosen file. The file being written is
 * the base, so saving to the machine-local file never copies the whole shared
 * configuration into it; only the commands on screen are set. Working
 * directories, preview information, and categories ride along from wherever
 * the command was declared — the dialog edits command lines, not plumbing.
 */
export function settingsToSave(
  draft: SetupDraft,
  proposal: WorkspaceProposal,
  scope: "shared" | "local"
): WorkspaceSettings {
  const declared = declaredSettings(proposal);
  const base = (scope === "shared" ? proposal.shared : proposal.local) ?? EMPTY_SETTINGS;
  const knownRun = [...(declared?.run ?? []), ...proposal.run];
  const knownVerify = [...(declared?.verify ?? []), ...proposal.verify];
  const setup = draft.setup.trim();

  return {
    ...base,
    setup: setup ? { command: setup, cwd: (declared?.setup ?? base.setup)?.cwd } : undefined,
    run: draft.run
      .filter((entry) => entry.command.trim().length > 0)
      .map((entry) => {
        const known = knownRun.find((candidate) => candidate.name === entry.name);
        return { ...known, name: entry.name, command: entry.command.trim() };
      }),
    defaultRun: draft.defaultRun ?? undefined,
    verify: draft.verify
      .filter((entry) => entry.command.trim().length > 0)
      .map((entry) => {
        const known = knownVerify.find((candidate) => candidate.name === entry.name);
        return { category: known?.category ?? "test", ...known, name: entry.name, command: entry.command.trim() };
      }),
    // Names only, never values (D-041). Recording which files this project
    // needs is a fact about the project; the contents stay on the machine.
    localFiles: [...new Set([...base.localFiles, ...proposal.localFiles.map((file) => file.path)])]
  };
}
