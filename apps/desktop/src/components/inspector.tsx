import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ProcessKind,
  FileChange,
  FileDiffResponse,
  Invitation,
  MissionDetailResponse,
  MissionRole,
  VerificationCheck
} from "@novus/contracts";
import { novus } from "../bridge";
import { clockTime, plural, shortSha } from "../format";
import {
  changedFiles,
  checkTallies,
  laneSessions,
  nextEnabledSkills,
  sessionOfCheck,
  skillRows,
  type SkillRow
} from "./derive";
import { GatedAction } from "./gated";
import { FileTree } from "./file-tree";
import { ProcessLogView } from "./process-log";
import { HumanMark, roleLabel } from "./identity";

function CloseGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

export type InspectorSection = "files" | "overview" | "changes" | "verification" | "output";

/**
 * Three above, two below (D-066).
 *
 * Five equally-weighted tabs made the panel a menu: nothing about the row said
 * which of them you were likely to want. The split is what the *work* is —
 * the files, what changed in them, whether it passed — against what the
 * *workspace* is: where it came from and what its processes printed. The first
 * three are read while working; the last two are consulted.
 */
const SECTIONS: { id: InspectorSection; label: string }[] = [
  { id: "files", label: "All files" },
  { id: "changes", label: "Changes" },
  { id: "verification", label: "Checks" }
];

/** The two below the edge. They open a region of their own rather than taking
 *  the one above, so this is a type the panel can hold on to. */
export type WorkspaceSection = "overview" | "output";

const WORKSPACE_SECTIONS: { id: WorkspaceSection; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "output", label: "Output" }
];

/** How tall the workspace region opens, as a share of the window — the same
 *  measure the terminal dock resizes by, so no new unit is minted. */
const DRAWER_DEFAULT_VH = 46;
const DRAWER_MIN_VH = 12;
const DRAWER_MAX_VH = 70;

/** The fold. Points down when the region is open, right when it is not — the
 *  same twisty the trace and the file tree use. */
function FoldGlyph({ open }: { open: boolean }) {
  return (
    <svg
      className={open ? "twisty-glyph open" : "twisty-glyph"}
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

/**
 * Which kind of process output is showing (D-050). This switch lives here and
 * not in the dock: the dock is the terminal, and the request that opens it is
 * unambiguous (D-049). The panel is where a person goes to *inspect* — the
 * runner, the environment, the diff, the ledger — and a build log is that.
 */
const OUTPUT_KINDS: { kind: ProcessKind; label: string }[] = [
  { kind: "setup", label: "Setup" },
  { kind: "run", label: "App" },
  { kind: "verification", label: "Checks" }
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
    case "automatic":
      return `Run by Novus at the checkpoint · ${where}`;
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
 *  row says outright that what it proved is no longer what is there. With
 *  several conversations in the lane, the row also says whose checkpoint the
 *  revision was (D-096) — never "whose tests", because the worktree a check
 *  exercised holds every chat's work so far. */
function provenanceLine(check: VerificationCheck, provedIn: string | null): string {
  const parts: string[] = [];
  if (check.checkpointSha === null) {
    parts.push("no revision recorded");
  } else {
    parts.push(
      check.stale
        ? `proved ${shortSha(check.checkpointSha)}, since changed`
        : `proved ${shortSha(check.checkpointSha)}`
    );
    if (provedIn) parts.push(`"${provedIn}"'s checkpoint`);
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
function LedgerEntry({
  check,
  provedIn,
  capabilities,
  holderLogin,
  busy,
  onRerun
}: {
  check: VerificationCheck;
  /** The conversation whose checkpoint this check ran at, named only while
   *  the lane holds more than one (D-096); null otherwise. */
  provedIn: string | null;
  capabilities: MissionDetailResponse["capabilities"];
  holderLogin: string | null;
  busy: boolean;
  onRerun: (name: string) => void;
}) {
  /* A result that failed, or that proved a revision the worktree has moved
     past, is the one a reader wants to try again — and trying again is the
     same declared command it was the first time, authorized the same way
     (D-057). A row that passed and still proves the current revision offers
     nothing: there is no question to re-answer. */
  const worthRunningAgain = check.stale || check.outcome === "failed" || check.outcome === "errored";
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
        {worthRunningAgain && (
          <GatedAction
            capability="workspace.command"
            capabilities={capabilities}
            denialReason="Invoking a command this project declared needs the workspace.command capability."
            holderLogin={holderLogin}
            onClick={() => onRerun(check.name)}
            variant="text"
            busy={busy}
            testid="rerun-check"
          >
            Run again
          </GatedAction>
        )}
      </div>
      <div className="ledger-origin" data-testid="ledger-origin">
        {originLine(check)}
      </div>
      <div className="mono ledger-facts" data-testid="ledger-facts">
        {provenanceLine(check, provedIn)}
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
 * The project's skills, reviewed and enabled where the machinery lives
 * (D-118): the manifest the runner published — name, what it says it is, and
 * the digest an approval pins — each row wearing the lane's standing answer
 * in words. A skill is instructions, never authority: enabling one changes
 * what the harness is handed and nothing about what it may do, and the foot
 * sentence says so once. A project that declares none puts nothing here.
 * The action renders for everyone and disables with the capability named
 * (the Permission-denied pattern); the server judges `skills.set` and the
 * manifest match either way.
 */
function SkillsSection({ detail }: { detail: MissionDetailResponse }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const maySet = detail.capabilities.includes("skills.set");
  const rows = skillRows(detail);
  if (rows.length === 0) return null;

  const act = async (choice: { enable: string } | { disable: string }) => {
    if (!detail.workstream) return;
    setBusy(true);
    setError(null);
    const result = await novus().missions.setEnabledSkills({
      missionId: detail.mission.missionId,
      workstreamId: detail.workstream.workstreamId,
      skills: nextEnabledSkills(detail, choice)
    });
    setBusy(false);
    if (!result.ok) setError(result.message);
  };

  const stateWord = (row: SkillRow): { text: string; warn: boolean } | null => {
    if (row.state === "enabled") return { text: "enabled", warn: false };
    if (row.state === "changed") return { text: "changed since enabled", warn: true };
    if (row.state === "vanished") return { text: "no longer in the project", warn: true };
    return null;
  };

  return (
    <div data-testid="inspector-skills">
      <h3 className="inspector-heading">Project skills</h3>
      {rows.map((row) => {
        const word = stateWord(row);
        // One action per row: a currently-enabled skill offers Disable; a
        // changed one offers Enable — review it as it now is and approve
        // that, the server's own refusal words — and a vanished grant is
        // retired with Disable.
        const action = row.state === "off" || row.state === "changed" ? "Enable" : "Disable";
        return (
          <div className="skill-row" data-testid="skill-row" data-skill={row.name} key={row.name}>
            <span className="skill-row-body">
              <span className="mono skill-name">{row.name}</span>
              {word && <span className={word.warn ? "tone-warn" : "skill-state"}> · {word.text}</span>}
              {row.description && <span className="skill-description">{row.description}</span>}
            </span>
            <button
              className="btn btn-text skill-action"
              disabled={!maySet || busy}
              onClick={() => void act(action === "Enable" ? { enable: row.name } : { disable: row.name })}
              title={
                maySet
                  ? action === "Enable"
                    ? `Enable "${row.name}" for this lane's turns, exactly as published`
                    : `Stop carrying "${row.name}"`
                  : "Only a Mission Admin or Operator can change skills (skills.set)."
              }
              data-testid="skill-action"
              data-skill={row.name}
            >
              {action}
            </button>
          </div>
        );
      })}
      {error && (
        <p className="skill-error tone-danger" role="alert" data-testid="skill-error">
          {error}
        </p>
      )}
      <p className="skill-foot">
        A skill teaches the harness this project's own procedures. It grants nothing — every act
        still asks under the lane's permissions — and one that changes is dropped from turns until
        someone enables it as it now is.
      </p>
    </div>
  );
}

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
  hostedHere,
  onClose,
  onDetail,
  onRevoke,
  width
}: {
  detail: MissionDetailResponse;
  section: InspectorSection;
  onSection: (section: InspectorSection) => void;
  /** The file currently taking the room's canvas, so the tree can mark it. */
  openPath: string | null;
  onOpenFile: (path: string) => void;
  /** False when this workstream's repository is not checked out here. Output
   *  and files are read from the machine that holds it and nowhere else. */
  hostedHere: boolean;
  onClose: () => void;
  onDetail: (detail: MissionDetailResponse) => void;
  onRevoke: () => void;
  /** Set by the drag handle beside it; remembered per machine (D-065). */
  width: number;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [outputKind, setOutputKind] = useState<ProcessKind>("setup");
  /**
   * Which workspace section is open below the work, and how tall it is
   *. `null` folds it back to its own row.
   *
   * The panel used to switch: choosing Output *replaced* the diff you were
   * reading, so "what did the build print about this change" cost you the
   * change. Two regions, one column — the work above, the workspace below —
   * and neither takes the other's place.
   */
  const [drawer, setDrawer] = useState<WorkspaceSection | null>("overview");
  const [drawerVh, setDrawerVh] = useState(DRAWER_DEFAULT_VH);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, DiffLoad>>({});
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  /** The check being run again, so its own row says so and no second run starts. */
  const [rerunning, setRerunning] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const files = changedFiles(detail);
  const tallies = checkTallies(detail);
  const { mission, workstream } = detail;

  /**
   * The region above the edge always shows one of its own three. A request for
   * a workspace section — the room's `Overview` action, or the section the
   * shell remembered — opens the region below rather than blanking the work.
   */
  const topSection: InspectorSection =
    section === "overview" || section === "output" ? "changes" : section;

  useEffect(() => {
    if (section === "overview" || section === "output") setDrawer(section);
  }, [section]);

  /** Dragging the workspace region's own top edge. */
  const onDrawerGrab = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = drawerVh;
    const viewport = window.innerHeight || 1;
    const move = (moveEvent: PointerEvent) => {
      const deltaVh = ((startY - moveEvent.clientY) / viewport) * 100;
      setDrawerVh(Math.min(DRAWER_MAX_VH, Math.max(DRAWER_MIN_VH, startHeight + deltaVh)));
    };
    const release = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", release);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", release);
  };

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
      ...(detail.workstream ? { workstreamId: detail.workstream.workstreamId } : {}),
      kind: "verification"
    });
    setVerifying(false);
    if (!result.ok) setVerifyError(result.message);
  };

  /**
   * One named check again, by the name the ledger row carries.
   *
   * Not an edit of the row it came from: the run produces a *new* record, with
   * its own attribution, its own revision, and its own outcome, and the one
   * that failed stays in the ledger. A check's history is the evidence — a
   * ledger that overwrote a failure with a later pass would be a ledger that
   * cannot be used to answer "did this ever fail" (D-057).
   */
  const rerunCheck = async (name: string) => {
    if (rerunning !== null) return; // one at a time; the row says which
    setRerunning(name);
    setVerifyError(null);
    const result = await novus().workspace.command({
      missionId: detail.mission.missionId,
      ...(detail.workstream ? { workstreamId: detail.workstream.workstreamId } : {}),
      kind: "verification",
      name
    });
    setRerunning(null);
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
        style={{ width }}
        role="complementary"
        aria-modal="true"
        aria-label="Mission inspector"
        ref={panelRef}
        data-testid="inspector"
      >
        {/* No identity row. Who holds the baton is the room's sentence, said
            once beneath the mission title; a second copy at the top of the
            panel competed with the panel's own subject (D-066). The close
            control keeps its corner. */}
        <div className="inspector-head">
          <div className="inspector-tabs" role="tablist" aria-label="Inspector sections">
            {SECTIONS.filter((option) => hostedHere || option.id !== "files").map((option) => (
              <button
                key={option.id}
                role="tab"
                aria-selected={topSection === option.id}
                className={topSection === option.id ? "inspector-tab active" : "inspector-tab"}
                onClick={() => onSection(option.id)}
                data-testid={`inspector-tab-${option.id}`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Hide the evidence panel"
            data-testid="inspector-close"
          >
            <CloseGlyph />
          </button>
        </div>

        <div className="inspector-scroll">
          {topSection === "files" && (
            <FileTree
              missionId={detail.mission.missionId}
              workstreamId={detail.workstream?.workstreamId}
              openPath={openPath}
              onOpenFile={onOpenFile}
            />
          )}

          {topSection === "changes" && (
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

          {topSection === "verification" && (
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
                    <LedgerEntry
                      key={check.checkId}
                      check={check}
                      // Whose checkpoint the check ran at (D-096) — said only
                      // while the lane holds several conversations; with one,
                      // there is nobody to tell apart.
                      provedIn={
                        laneSessions(detail).length > 1
                          ? (sessionOfCheck(detail, check)?.title ?? null)
                          : null
                      }
                      capabilities={detail.capabilities}
                      holderLogin={detail.control.holderLogin}
                      busy={rerunning === check.name}
                      onRerun={(name) => void rerunCheck(name)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* The workspace, under the work rather than instead of it. The
            three tabs above answer what the work is; these two answer what the
            workspace is and what it printed, and a person reading a diff should
            not have to give it up to see either. Drag its edge; the chevron
            folds it back to its own row. */}
        <div
          className={drawer === null ? "inspector-drawer" : "inspector-drawer open"}
          style={drawer === null ? undefined : { height: `${drawerVh}vh` }}
          data-testid="inspector-drawer"
        >
          {drawer !== null && (
            <div
              className="inspector-drawer-grip"
              onPointerDown={onDrawerGrab}
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize the workspace section"
              data-testid="inspector-drawer-grip"
            />
          )}

          <div className="inspector-drawer-head">
            <button
              className="icon-button inspector-drawer-fold"
              onClick={() => setDrawer((open) => (open === null ? "overview" : null))}
              aria-expanded={drawer !== null}
              aria-label={drawer === null ? "Show the workspace" : "Fold the workspace away"}
              title={drawer === null ? "Show the workspace" : "Fold the workspace away"}
              data-testid="inspector-drawer-fold"
            >
              <FoldGlyph open={drawer !== null} />
            </button>
            <div className="inspector-tabs" role="tablist" aria-label="Workspace sections">
              {WORKSPACE_SECTIONS.filter((option) => hostedHere || option.id !== "output").map((option) => (
                <button
                  key={option.id}
                  role="tab"
                  aria-selected={drawer === option.id}
                  className={drawer === option.id ? "inspector-tab active" : "inspector-tab"}
                  onClick={() => setDrawer(option.id === drawer ? null : (option.id as WorkspaceSection))}
                  data-testid={`inspector-tab-${option.id}`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {/* Output is a log that owns its own scrolling, so it fills the
              region rather than sitting in a scrolling column of its own. */}
          {drawer !== null && (
            <div
              className={
                drawer === "output" ? "inspector-drawer-body log" : "inspector-drawer-body"
              }
              data-testid="inspector-drawer-body"
            >
              {drawer === "output" && (
                <>
                  <div className="output-kinds" role="tablist" aria-label="Which output">
                    {OUTPUT_KINDS.map((entry) => (
                      <button
                        key={entry.kind}
                        role="tab"
                        aria-selected={outputKind === entry.kind}
                        className={outputKind === entry.kind ? "output-kind active" : "output-kind"}
                        onClick={() => setOutputKind(entry.kind)}
                        data-testid="output-kind"
                        data-kind={entry.kind}
                      >
                        {entry.label}
                      </button>
                    ))}
                  </div>
                  <ProcessLogView
                    missionId={detail.mission.missionId}
                    workstreamId={detail.workstream?.workstreamId}
                    kind={outputKind}
                  />
                </>
              )}

              {drawer === "overview" && (
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
                        "No machine has registered to run this."
                      )}
                    </span>
                  </div>

                  <SkillsSection detail={detail} />

                  <h3 className="inspector-heading">Participants</h3>
                  <ul className="participant-list" data-testid="participant-list">
                    {detail.participants.map((participant) => (
                      <li
                        key={participant.userId}
                        // A disconnected participant dims and never disappears
                        // (DESIGN.md#component-behavior); the state itself is
                        // said in words, never a dot.
                        className={
                          participant.connection === "connected"
                            ? "participant-row"
                            : "participant-row participant-away"
                        }
                      >
                        <HumanMark login={participant.login} name={participant.name} />
                        <span className="participant-name">{participant.name ?? participant.login}</span>
                        <span className="participant-role">{roleLabel(participant.role)}</span>
                        {participant.connection !== "connected" && (
                          <span className="participant-connection" data-testid="participant-connection">
                            {participant.connection}
                          </span>
                        )}
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
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
