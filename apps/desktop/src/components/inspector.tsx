import { useCallback, useEffect, useRef, useState } from "react";
import type {
  FileChange,
  FileDiffResponse,
  Invitation,
  MissionDetailResponse,
  MissionRole,
  VerificationCheck
} from "@novus/contracts";
import { novus } from "../bridge";
import { clockTime, plural, shortSha } from "../format";
import { changedFiles, checkTallies } from "./derive";
import { GatedAction } from "./gated";
import { FileTree } from "./file-tree";
import { HumanMark, ParticipantStack, roleLabel } from "./identity";

function CloseGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

export type InspectorSection = "files" | "overview" | "changes" | "verification";

const SECTIONS: { id: InspectorSection; label: string }[] = [
  { id: "files", label: "All files" },
  { id: "overview", label: "Overview" },
  { id: "changes", label: "Changes" },
  { id: "verification", label: "Verification" }
];

type DiffLoad =
  | { kind: "loading" }
  | { kind: "loaded"; diff: FileDiffResponse }
  | { kind: "failed"; message: string };

/** A unified diff, tinted at 12% of --ok / --danger — the only place those
 *  tokens appear as backgrounds (DESIGN.md#component-behavior). The diff owns
 *  its own horizontal scroll; nothing else in the room scrolls sideways. */
function UnifiedDiff({ diff }: { diff: string }) {
  const lines = diff.replace(/\n+$/, "").split("\n");
  return (
    <div className="diff" data-testid="diff">
      {lines.map((line, index) => {
        const tone = line.startsWith("+++") || line.startsWith("---")
          ? "meta"
          : line.startsWith("@@")
            ? "hunk"
            : line.startsWith("+")
              ? "add"
              : line.startsWith("-")
                ? "del"
                : "ctx";
        return (
          <div key={index} className={`diff-line diff-${tone}`}>
            {line === "" ? " " : line}
          </div>
        );
      })}
    </div>
  );
}

function ChangeRow({
  file,
  expanded,
  onToggle,
  load
}: {
  file: FileChange;
  expanded: boolean;
  onToggle: () => void;
  load: DiffLoad | undefined;
}) {
  return (
    <div className="change-item">
      <button
        className={expanded ? "change-row selected" : "change-row"}
        onClick={onToggle}
        aria-expanded={expanded}
        data-testid="change-row"
      >
        <span className="mono change-path" title={file.path}>
          {file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
        </span>
        <span className="change-state">{file.changeState}</span>
        <span className="change-counts mono">
          <span className="count-add">+{file.additions}</span>
          <span className="count-del">−{file.deletions}</span>
        </span>
      </button>
      {expanded && (
        <div className="change-diff">
          {file.binary ? (
            <p className="quiet">Binary file — no diff to show.</p>
          ) : load === undefined || load.kind === "loading" ? (
            <p className="quiet">Loading the diff…</p>
          ) : load.kind === "failed" ? (
            <p className="inline-error" role="alert">
              {load.message}
            </p>
          ) : load.diff.diff === null ? (
            <p className="quiet">No diff was recorded for this file.</p>
          ) : (
            <>
              <UnifiedDiff diff={load.diff.diff} />
              {load.diff.truncated && <p className="quiet">This diff was truncated when it was recorded.</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Where a check came from, in words (PRODUCT.md VerificationCheck, D-037).
 * Collapsing "the agent said it ran" and "a person ran it" into one green row
 * is the fabrication the ledger exists to prevent, so the origin is never
 * abbreviated to a colour or a glyph.
 */
function originLine(check: VerificationCheck): string {
  const where = `reported by ${check.environment}`;
  switch (check.origin) {
    case "harness":
      return `Observed from Claude Code · ${where}`;
    case "participant":
      return `Run by ${check.requestedByLogin ?? "a participant"} · ${where}`;
    case "external":
      return `Reported by CI · ${where}`;
  }
}

/** A duration the runner measured, as a compact elapsed time. */
function elapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** The revision a check proves, its exit code, and how long it took. A stale
 *  row says outright that what it proved is no longer what is there. */
function provenanceLine(check: VerificationCheck): string {
  const parts: string[] = [];
  if (check.checkpointSha === null) {
    parts.push("no revision recorded");
  } else {
    parts.push(
      check.stale
        ? `proved ${shortSha(check.checkpointSha)}, since changed`
        : `proved ${shortSha(check.checkpointSha)}`
    );
  }
  if (check.exitCode !== null) parts.push(`exit ${check.exitCode}`);
  if (check.durationMs !== null) parts.push(elapsed(check.durationMs));
  return parts.join(" · ");
}

/**
 * The evidence ledger (DESIGN.md signature element 3). Two columns in mono,
 * `--ok` only on a check that passed *and* still proves the current revision;
 * a stale row dims to `--text-3` and says what it proved, because a result
 * that has been overtaken is history, not proof.
 */
function LedgerEntry({ check }: { check: VerificationCheck }) {
  return (
    <div
      className={check.stale ? "ledger-entry stale" : "ledger-entry"}
      data-testid="ledger-entry"
      data-stale={check.stale ? "true" : "false"}
    >
      <div className="ledger-row">
        <span className="mono ledger-name" title={check.command}>
          {check.name}
        </span>
        <span className={`mono ledger-outcome outcome-${check.outcome}`}>{check.outcome}</span>
      </div>
      <div className="ledger-origin" data-testid="ledger-origin">
        {originLine(check)}
      </div>
      <div className="mono ledger-facts" data-testid="ledger-facts">
        {provenanceLine(check)}
      </div>
      {check.output && (check.outcome === "failed" || check.outcome === "errored") && (
        <details className="disclosure">
          <summary>Output</summary>
          <pre className="mono check-output">{check.output}</pre>
        </details>
      )}
    </div>
  );
}

/**
 * Changes and Verification, plus the machinery that never belongs in the
 * mission header (DESIGN.md prohibited pattern 12): a contextual inspector,
 * an overlay and not a permanent column (DESIGN.md#layout).
 */

/**
 * Inviting someone is the only way a mission gets a second responsible human,
 * so it lives with the participants rather than behind a menu. The token is
 * shown exactly once, here, because the server only ever stores its hash: if
 * this is dismissed without copying it, the invitation has to be reissued.
 */
function InviteSection({ detail }: { detail: MissionDetailResponse }) {
  const [invitations, setInvitations] = useState<Invitation[] | null>(null);
  const [issued, setIssued] = useState<{ token: string; role: MissionRole } | null>(null);
  const [role, setRole] = useState<MissionRole>("contributor");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const canInvite = detail.capabilities.includes("mission.invite");

  const refresh = useCallback(async () => {
    if (!canInvite) return;
    const result = await novus().invites.list(detail.mission.missionId);
    if (result.ok) setInvitations(result.value);
  }, [canInvite, detail.mission.missionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!canInvite) return null;

  const create = async () => {
    setBusy(true);
    setError(null);
    setCopied(false);
    const result = await novus().invites.create({ missionId: detail.mission.missionId, role });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setIssued({ token: result.value.token, role });
    await refresh();
  };

  const revoke = async (invitationId: string) => {
    setBusy(true);
    const result = await novus().invites.revoke(invitationId);
    setBusy(false);
    if (!result.ok) setError(result.message);
    await refresh();
  };

  const copy = async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.token);
      setCopied(true);
    } catch {
      // Clipboard access can be refused; the token is selectable either way.
      setCopied(false);
    }
  };

  const live = (invitations ?? []).filter(
    (invitation) => !invitation.redeemedAt && !invitation.revokedAt
  );
  const spent = (invitations ?? []).filter((invitation) => invitation.redeemedAt);

  return (
    <>
      <h3 className="inspector-heading">Invite someone</h3>
      <div className="invite-row">
        <label className="invite-role">
          <span className="kv-label">Role</span>
          <select
            className="invite-select"
            value={role}
            onChange={(event) => setRole(event.target.value as MissionRole)}
            data-testid="invite-role"
          >
            <option value="contributor">Contributor</option>
            <option value="operator">Operator</option>
            <option value="viewer">Viewer</option>
            <option value="mission_admin">Mission Admin</option>
          </select>
        </label>
        <button
          className="btn btn-primary"
          onClick={() => void create()}
          disabled={busy}
          data-testid="create-invitation"
        >
          Create invitation
        </button>
      </div>

      {issued && (
        <div className="invite-issued" data-testid="invitation-token">
          <p className="quiet">
            Send this to the person you are inviting. It works once, expires in seven days, and
            Novus cannot show it again.
          </p>
          <code className="invite-token mono">{issued.token}</code>
          <button className="btn btn-secondary" onClick={() => void copy()} data-testid="copy-invitation">
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}

      {error && (
        <p className="inline-error" role="alert" data-testid="invite-error">
          {error}
        </p>
      )}

      {live.length > 0 && (
        <ul className="invite-list">
          {live.map((invitation) => (
            <li key={invitation.invitationId} className="invite-item">
              <span className="invite-state">
                Unredeemed · {roleLabel(invitation.role)}
              </span>
              <button
                className="btn btn-text"
                onClick={() => void revoke(invitation.invitationId)}
                disabled={busy}
                data-testid="revoke-invitation"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      {spent.length > 0 && (
        <p className="quiet" data-testid="invitations-redeemed">
          {plural(spent.length, "invitation")} redeemed.
        </p>
      )}
    </>
  );
}

export function Inspector({
  detail,
  section,
  onSection,
  openPath,
  onOpenFile,
  onClose,
  onDetail,
  onRevoke
}: {
  detail: MissionDetailResponse;
  section: InspectorSection;
  onSection: (section: InspectorSection) => void;
  /** The file currently taking the room's canvas, so the tree can mark it. */
  openPath: string | null;
  onOpenFile: (path: string) => void;
  onClose: () => void;
  onDetail: (detail: MissionDetailResponse) => void;
  onRevoke: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, DiffLoad>>({});
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const files = changedFiles(detail);
  const tallies = checkTallies(detail);
  const { mission, workstream } = detail;

  // Escape closes the panel. Focus is deliberately not trapped and not stolen:
  // this is a docked region beside the room, not a modal over it, so tabbing
  // continues naturally between the trace, the composer, and the evidence.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const toggleFile = useCallback(
    async (file: FileChange) => {
      if (expanded === file.changeId) {
        setExpanded(null);
        return;
      }
      setExpanded(file.changeId);
      if (diffs[file.changeId] || file.binary) return;
      setDiffs((prev) => ({ ...prev, [file.changeId]: { kind: "loading" } }));
      const result = await novus().evidence.fileDiff(file.changeId);
      setDiffs((prev) => ({
        ...prev,
        [file.changeId]: result.ok
          ? { kind: "loaded", diff: result.value }
          : { kind: "failed", message: result.message }
      }));
    },
    [diffs, expanded]
  );

  /** Every check the project declared, in one request: the runner decides what
   *  that means, because the commands live in the repository, not here. */
  const runVerification = async () => {
    setVerifying(true);
    setVerifyError(null);
    const result = await novus().workspace.command({
      missionId: detail.mission.missionId,
      kind: "verification"
    });
    setVerifying(false);
    if (!result.ok) setVerifyError(result.message);
  };

  const retryBranch = async () => {
    if (!workstream) return;
    setRetrying(true);
    setRetryError(null);
    const result = await novus().missions.retryBranch(workstream.workstreamId);
    setRetrying(false);
    if (result.ok) onDetail({ ...detail, workstream: result.value });
    else setRetryError(result.message);
  };

  return (
    <>
      <aside
        className="inspector"
        role="complementary"
        aria-modal="true"
        aria-label="Mission inspector"
        ref={panelRef}
        data-testid="inspector"
      >
        <div className="inspector-identity">
          <ParticipantStack
            participants={detail.participants}
          />
          <span className="inspector-controller" data-testid="panel-controller">
            {/* The baton lives on the controller's mark in the stack beside this
                line. One mark, one meaning — it is not repeated here. */}
            {detail.control.holderLogin ? (
              detail.control.holderUserId === detail.viewerUserId
                ? "You have control"
                : `${detail.control.holderLogin} has control`
            ) : (
              <>
                No controller
              </>
            )}
          </span>
          <button className="icon-button" onClick={onClose} aria-label="Hide the evidence panel" data-testid="inspector-close">
            <CloseGlyph />
          </button>
        </div>

        <div className="inspector-head">
          <div className="inspector-tabs" role="tablist" aria-label="Inspector sections">
            {SECTIONS.map((option) => (
              <button
                key={option.id}
                role="tab"
                aria-selected={section === option.id}
                className={section === option.id ? "inspector-tab active" : "inspector-tab"}
                onClick={() => onSection(option.id)}
                data-testid={`inspector-tab-${option.id}`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="inspector-scroll">
          {section === "files" && (
            <FileTree missionId={detail.mission.missionId} openPath={openPath} onOpenFile={onOpenFile} />
          )}

          {section === "overview" && (
            <div data-testid="inspector-overview">
              <div className="kv" data-testid="repo-block">
                <span className="kv-label">Repository</span>
                <span className="kv-value" data-testid="repo-name">
                  {mission.repository?.name ?? "No repository recorded"}
                </span>

                {workstream && (
                  <>
                    <span className="kv-label">Mission branch</span>
                    <span className="kv-value mono" data-testid="ws-branch">
                      {workstream.missionBranch}
                    </span>

                    <span className="kv-label">Base</span>
                    <span className="kv-value mono" data-testid="ws-base" title={workstream.baseSha}>
                      {workstream.baseRef} · {shortSha(workstream.baseSha)}
                    </span>

                    <span className="kv-label">Branch</span>
                    <span className="kv-value" data-testid="ws-branch-status">
                      {workstream.branchStatus === "created" && "Created"}
                      {workstream.branchStatus === "pending" && "Pending"}
                      {workstream.branchStatus === "failed" && (
                        <>
                          <span className="inline-error" data-testid="branch-error">
                            {workstream.branchError ?? "Branch creation failed."}
                          </span>{" "}
                          <button
                            className="btn btn-text"
                            onClick={() => void retryBranch()}
                            disabled={retrying}
                            data-testid="retry-branch"
                          >
                            Retry
                          </button>
                          {retryError && (
                            <span className="inline-error" role="alert" data-testid="retry-error">
                              {retryError}
                            </span>
                          )}
                        </>
                      )}
                    </span>
                  </>
                )}

                <span className="kv-label">Runner</span>
                <span className="kv-value" data-testid="runner-status">
                  {detail.runner ? (
                    <>
                      {detail.runner.label} · {detail.runner.online ? "online" : "offline"}
                      {!detail.runner.online && detail.runner.lastSeenAt
                        ? ` · last heard ${clockTime(detail.runner.lastSeenAt)}`
                        : ""}
                    </>
                  ) : (
                    "No runner has registered for this workstream."
                  )}
                </span>
              </div>

              <h3 className="inspector-heading">Participants</h3>
              <ul className="participant-list" data-testid="participant-list">
                {detail.participants.map((participant) => (
                  <li key={participant.userId} className="participant-row">
                    <HumanMark login={participant.login} name={participant.name} />
                    <span className="participant-name">{participant.name ?? participant.login}</span>
                    <span className="participant-role">{roleLabel(participant.role)}</span>
                  </li>
                ))}
                {detail.participants.length === 0 && <li className="quiet">No participants recorded.</li>}
              </ul>
              <InviteSection detail={detail} />

              {detail.control.holderLogin && (
                <div className="inspector-actions">
                  <GatedAction
                    capability="control.revoke"
                    capabilities={detail.capabilities}
                    denialReason="Only a Mission Admin can revoke control."
                    holderLogin={detail.control.holderLogin}
                    onClick={onRevoke}
                    variant="secondary"
                    testid="revoke-control"
                  >
                    Revoke control
                  </GatedAction>
                </div>
              )}
            </div>
          )}

          {section === "changes" && (
            <div data-testid="inspector-changes">
              {files.length === 0 ? (
                <p className="quiet" data-testid="changes-empty">
                  No files have changed yet.
                </p>
              ) : (
                <>
                  <p className="inspector-summary">
                    {plural(files.length, "file")} changed on{" "}
                    <span className="mono">{workstream?.missionBranch ?? "the mission branch"}</span>
                  </p>
                  {files.map((file) => (
                    <ChangeRow
                      key={file.changeId}
                      file={file}
                      expanded={expanded === file.changeId}
                      onToggle={() => void toggleFile(file)}
                      load={diffs[file.changeId]}
                    />
                  ))}
                </>
              )}
            </div>
          )}

          {section === "verification" && (
            <div data-testid="inspector-verification">
              <div className="ledger-head">
                {/* Silent when there is nothing to tally: the empty state below
                    says it once, and saying it twice is not more honest. */}
                <span className="inspector-summary" data-testid="checks-summary">
                  {tallies.total === 0
                    ? ""
                    : [
                        `${plural(tallies.passed, "check")} passed`,
                        tallies.failed > 0 ? `${tallies.failed} failed` : null,
                        tallies.stale > 0 ? `${tallies.stale} proved an earlier revision` : null
                      ]
                        .filter((part) => part !== null)
                        .join(" · ")}
                </span>
                {/* Running a check is a declared command like any other, so the
                    server authorizes it the same way (D-042). */}
                <GatedAction
                  capability="workspace.command"
                  capabilities={detail.capabilities}
                  denialReason="Invoking a command this project declared needs the workspace.command capability."
                  holderLogin={detail.control.holderLogin}
                  onClick={() => void runVerification()}
                  variant="secondary"
                  busy={verifying}
                  testid="run-verification"
                >
                  Run verification
                </GatedAction>
              </div>
              {verifyError && (
                <p className="inline-error" role="alert" data-testid="verify-error">
                  {verifyError}
                </p>
              )}
              {detail.checks.length === 0 ? (
                <p className="quiet" data-testid="checks-empty">
                  No checks observed.
                </p>
              ) : (
                <div className="ledger" data-testid="ledger">
                  {detail.checks.map((check) => (
                    <LedgerEntry key={check.checkId} check={check} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
