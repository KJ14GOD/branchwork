import { useCallback, useEffect, useRef, useState } from "react";
import type { SettingsScope, WorkspaceProposal } from "@novus/contracts";
import { novus } from "../bridge";
import { draftFrom, settingsToSave, type SetupDraft } from "./workspace-config";

/**
 * Set up workspace (DESIGN.md#component-behavior, D-040 … D-042). A bounded
 * dialog, not a wizard: what Novus detected, what it would propose, the
 * filenames a machine has to supply, and where the configuration gets written
 * — with one primary action, and nothing running until it is pressed.
 *
 * Three rules shape every line of this surface:
 *
 *  - Nothing executes on open. Inspecting reads; it never installs or runs.
 *  - Local files are named, never read. Novus shows filenames and whether Git
 *    ignores them; the contents stay on the machine that has them (D-041), and
 *    a file is copied only after that one file is confirmed here.
 *  - A workspace can only be prepared on the machine that holds the
 *    repository. Controlling a mission is not access to that machine (D-042),
 *    and this dialog says so in words rather than hiding a control.
 */

type Load =
  | { kind: "reading" }
  | { kind: "read"; proposal: WorkspaceProposal }
  | { kind: "refused"; message: string }
  /** The repository is not on this machine, so there is nothing to prepare
   *  here — the honest answer, not a disabled mystery. */
  | { kind: "elsewhere" };

/** Per-file consent: a file moves idle → confirming → outcome, one at a time,
 *  because "copy these six things" is not consent to any one of them. */
type FileState =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "copying" }
  | { kind: "copied" }
  | { kind: "refused"; because: string };

const SCOPES: { id: SettingsScope; label: string; note: string }[] = [
  {
    id: "shared",
    label: "Shared project file",
    note: "Written to .novus/settings.toml — committed, reviewed, and used by everyone on this project."
  },
  {
    id: "local",
    label: "This machine only",
    note: "Written to .novus/settings.local.toml — gitignored, and layered over the shared file here only."
  }
];

export function WorkspaceSetupDialog({
  missionId,
  /** Whether this viewer is at the machine that holds the repository. */
  preparableHere,
  onClose
}: {
  missionId: string;
  preparableHere: boolean;
  onClose: () => void;
}) {
  const [load, setLoad] = useState<Load>(preparableHere ? { kind: "reading" } : { kind: "elsewhere" });
  const [draft, setDraft] = useState<SetupDraft | null>(null);
  const [scope, setScope] = useState<SettingsScope>("shared");
  const [files, setFiles] = useState<Record<string, FileState>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SettingsScope | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const read = useCallback(async () => {
    if (!preparableHere) return;
    setLoad({ kind: "reading" });
    const result = await novus().workspace.inspect(missionId);
    if (result.ok) {
      setLoad({ kind: "read", proposal: result.value });
      setDraft(draftFrom(result.value));
      return;
    }
    // The machine itself says the repository is somewhere else; say that
    // rather than reporting it as a failure (D-042).
    setLoad(
      result.code === "not_this_machine" || result.code === "not_local"
        ? { kind: "elsewhere" }
        : { kind: "refused", message: result.message }
    );
  }, [missionId, preparableHere]);

  useEffect(() => {
    void read();
  }, [read]);

  // Esc closes; focus is trapped and restored (DESIGN.md#keyboard).
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      opener?.focus();
    };
  }, [onClose]);

  const save = async () => {
    if (load.kind !== "read" || !draft || saving) return;
    setSaving(true);
    setSaveError(null);
    const result = await novus().workspace.save({
      missionId,
      scope,
      settings: settingsToSave(draft, load.proposal, scope)
    });
    setSaving(false);
    if (!result.ok) {
      setSaveError(result.message);
      return;
    }
    setSaved(scope);
    // What is declared has changed, so the surface re-reads rather than
    // continuing to show what it proposed a moment ago.
    await read();
  };

  const supply = async (path: string) => {
    setFiles((prev) => ({ ...prev, [path]: { kind: "copying" } }));
    const result = await novus().workspace.prepareLocalFiles({ missionId, paths: [path] });
    if (!result.ok) {
      setFiles((prev) => ({ ...prev, [path]: { kind: "refused", because: result.message } }));
      return;
    }
    const outcome = result.value.find((file) => file.path === path);
    setFiles((prev) => ({
      ...prev,
      [path]: outcome?.copied
        ? { kind: "copied" }
        : { kind: "refused", because: outcome?.refusedBecause ?? "the machine did not say why" }
    }));
  };

  const proposal = load.kind === "read" ? load.proposal : null;

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div
        className="dialog setup-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Set up workspace"
        ref={panelRef}
        data-testid="workspace-setup"
      >
        <div className="dialog-head">
          <h2 className="dialog-title">Set up workspace</h2>
          {/* Not promised where it cannot happen: the body says why instead. */}
          {load.kind !== "elsewhere" && (
            <p className="dialog-context">
              Novus reads this project and proposes how to install, run, and verify it. Nothing runs
              until you ask for it.
            </p>
          )}
        </div>

        <div className="dialog-results setup-body">
          {load.kind === "reading" && <p className="quiet">Reading the project…</p>}

          {load.kind === "elsewhere" && (
            <div className="setup-section" data-testid="setup-elsewhere">
              <p className="setup-lead">
                This workspace can only be prepared on the machine that holds the repository.
              </p>
              <p className="setup-note">
                Controlling this mission is not access to that machine. From here you can invoke the
                commands the project has declared — the setup command, its run commands, and its
                verification commands — and nothing else.
              </p>
            </div>
          )}

          {load.kind === "refused" && (
            <div className="setup-section">
              <p className="inline-error" role="alert" data-testid="setup-error">
                {load.message}
              </p>
              <button className="btn btn-text" onClick={() => void read()} data-testid="setup-retry">
                Try again
              </button>
            </div>
          )}

          {proposal && draft && (
            <>
              <section className="setup-section" data-testid="setup-detected">
                <div className="kv">
                  <span className="kv-label">Detected</span>
                  <span className="kv-value" data-testid="setup-project-type">
                    {proposal.projectType}
                  </span>
                  {proposal.signals.length > 0 && (
                    <>
                      <span className="kv-label">From</span>
                      <span className="kv-value mono setup-signals">{proposal.signals.join(" · ")}</span>
                    </>
                  )}
                </div>
                {proposal.blockers.length > 0 && (
                  <ul className="setup-blockers" data-testid="setup-blockers">
                    {proposal.blockers.map((blocker) => (
                      <li key={blocker}>
                        <span className="status-dot warn" />
                        {blocker}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="setup-section">
                <h3 className="setup-label">Setup command</h3>
                <div className="setup-command">
                  {/* An empty name cell, so every command in this dialog sits
                      on one grid rather than three ragged ones. */}
                  <span className="setup-command-name" aria-hidden="true" />
                  <input
                    className="input mono"
                    value={draft.setup}
                    placeholder="Nothing to install"
                    onChange={(event) =>
                      setDraft((prev) => (prev ? { ...prev, setup: event.target.value } : prev))
                    }
                    aria-label="Setup command"
                    data-testid="setup-command"
                  />
                  <span className="setup-flags">
                    {draft.setupSuggested && draft.setup.length > 0 && (
                      <span className="setup-suggested">suggested</span>
                    )}
                  </span>
                </div>
              </section>

              <CommandSection
                title="Run commands"
                testid="setup-run"
                empty="This project has no run command yet."
                entries={draft.run}
                defaultName={draft.defaultRun}
                onChange={(index, value) =>
                  setDraft((prev) =>
                    prev
                      ? {
                          ...prev,
                          run: prev.run.map((entry, position) =>
                            position === index ? { ...entry, command: value } : entry
                          )
                        }
                      : prev
                  )
                }
              />

              <CommandSection
                title="Verification commands"
                testid="setup-verify"
                empty="This project has no verification command yet."
                entries={draft.verify}
                defaultName={null}
                onChange={(index, value) =>
                  setDraft((prev) =>
                    prev
                      ? {
                          ...prev,
                          verify: prev.verify.map((entry, position) =>
                            position === index ? { ...entry, command: value } : entry
                          )
                        }
                      : prev
                  )
                }
              />

              <section className="setup-section" data-testid="setup-files">
                <h3 className="setup-label">Files this workspace needs</h3>
                <p className="setup-note">
                  Novus reads the names of these files, never their contents. A file is copied only
                  after you confirm that one file, and only when Git already ignores it.
                </p>
                {proposal.localFiles.length === 0 ? (
                  <p className="quiet" data-testid="setup-files-empty">
                    None — this project asked for no machine-local files.
                  </p>
                ) : (
                  <ul className="file-list">
                    {proposal.localFiles.map((file) => (
                      <LocalFileRow
                        key={file.path}
                        path={file.path}
                        availableInSource={file.availableInSource}
                        presentInWorkspace={file.presentInWorkspace}
                        gitIgnored={file.gitIgnored}
                        state={files[file.path] ?? { kind: "idle" }}
                        onAsk={() => setFiles((prev) => ({ ...prev, [file.path]: { kind: "confirming" } }))}
                        onCancel={() => setFiles((prev) => ({ ...prev, [file.path]: { kind: "idle" } }))}
                        onConfirm={() => void supply(file.path)}
                      />
                    ))}
                  </ul>
                )}
              </section>

              <section className="setup-section" data-testid="setup-scope">
                <h3 className="setup-label">Where this is saved</h3>
                <div className="segment" role="group" aria-label="Where this is saved">
                  {SCOPES.map((option) => (
                    <button
                      key={option.id}
                      className="btn btn-secondary"
                      aria-pressed={scope === option.id}
                      onClick={() => setScope(option.id)}
                      data-testid={`scope-${option.id}`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <p className="setup-note">{SCOPES.find((option) => option.id === scope)?.note}</p>
              </section>
            </>
          )}
        </div>

        <div className="dialog-actions">
          {saveError && (
            <span className="inline-error" role="alert" data-testid="setup-save-error">
              {saveError}
            </span>
          )}
          {saved && !saveError && (
            <span className="dialog-note" data-testid="setup-saved">
              Saved to the {saved === "shared" ? "shared project file" : "machine-local file"}.
            </span>
          )}
          <span className="dialog-spacer" />
          <button className="btn btn-text" onClick={onClose} data-testid="setup-close">
            Close
          </button>
          {/* Absent, not disabled, where a workspace can never be prepared:
              there is no configuration to write from this machine (D-042). */}
          {load.kind !== "elsewhere" && (
            <button
              className="btn btn-primary"
              onClick={() => void save()}
              disabled={load.kind !== "read" || saving}
              data-testid="setup-save"
            >
              Save configuration
            </button>
          )}
        </div>
      </div>
    </>
  );
}

function CommandSection({
  title,
  testid,
  empty,
  entries,
  defaultName,
  onChange
}: {
  title: string;
  testid: string;
  empty: string;
  entries: { name: string; command: string; suggested: boolean }[];
  /** The run command the Run control offers first, when there is one. */
  defaultName: string | null;
  onChange: (index: number, value: string) => void;
}) {
  return (
    <section className="setup-section" data-testid={testid}>
      <h3 className="setup-label">{title}</h3>
      {entries.length === 0 ? (
        <p className="quiet">{empty}</p>
      ) : (
        entries.map((entry, index) => (
          <div className="setup-command" key={entry.name}>
            <span className="setup-command-name">{entry.name}</span>
            <input
              className="input mono"
              value={entry.command}
              onChange={(event) => onChange(index, event.target.value)}
              aria-label={`${title} — ${entry.name}`}
              data-testid={`${testid}-command`}
            />
            <span className="setup-flags">
              {entry.name === defaultName && <span className="setup-suggested">default</span>}
              {entry.suggested && <span className="setup-suggested">suggested</span>}
            </span>
          </div>
        ))
      )}
    </section>
  );
}

/**
 * One filename, what is known about it, and — only when copying it could
 * possibly be right — a confirmation for that one file. The row states the
 * consequence in a sentence before anything moves.
 */
function LocalFileRow({
  path,
  availableInSource,
  presentInWorkspace,
  gitIgnored,
  state,
  onAsk,
  onCancel,
  onConfirm
}: {
  path: string;
  availableInSource: boolean;
  presentInWorkspace: boolean;
  gitIgnored: boolean;
  state: FileState;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const facts = [
    availableInSource ? "in the source checkout" : "not in the source checkout",
    presentInWorkspace ? "already in the workspace" : "not in the workspace yet",
    gitIgnored ? "Git ignores it" : "Git does not ignore it"
  ].join(" · ");
  const copyable = availableInSource && gitIgnored && !presentInWorkspace;

  return (
    <li className="file-row" data-testid="local-file">
      <span className="mono file-path">{path}</span>
      <span className="file-facts">{facts}</span>
      {state.kind === "idle" && copyable && (
        <button className="btn btn-text file-action" onClick={onAsk} data-testid="file-supply">
          Copy into the workspace
        </button>
      )}
      {state.kind === "idle" && !copyable && (
        <span className="file-outcome" data-testid="file-blocked">
          {presentInWorkspace
            ? "Nothing to do"
            : !availableInSource
              ? "Not on this machine to copy"
              : "Only a Git-ignored file may be copied"}
        </span>
      )}
      {state.kind === "confirming" && (
        <span className="file-confirm" data-testid="file-confirm">
          <span className="file-question">
            Copy {path} into the workspace? Novus reads its name, never its contents.
          </span>
          <button className="btn btn-text" onClick={onCancel} data-testid="file-cancel">
            Cancel
          </button>
          <button className="btn btn-secondary" onClick={onConfirm} data-testid="file-confirm-yes">
            Copy this file
          </button>
        </span>
      )}
      {state.kind === "copying" && <span className="file-outcome">Copying…</span>}
      {state.kind === "copied" && (
        <span className="file-outcome" data-testid="file-copied">
          Copied into the workspace
        </span>
      )}
      {state.kind === "refused" && (
        <span className="inline-error file-outcome" data-testid="file-refused">
          Refused — {state.because}
        </span>
      )}
    </li>
  );
}
