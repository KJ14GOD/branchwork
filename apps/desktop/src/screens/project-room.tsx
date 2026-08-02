import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { BaseRevision, MissionDetailResponse, MissionEvent } from "@novus/contracts";
import { novus } from "../bridge";
import { deriveGoal, shortSha, truncateLabel } from "../format";
import type { Project } from "./project-shell";

type BaseLoad =
  | { kind: "resolving" }
  | { kind: "resolved"; base: BaseRevision }
  | { kind: "failed"; message: string };

/** A "+" tab before its first message: no mission exists yet. The creationKey
 *  is minted when the tab opens and reused on retry, so a retried first
 *  message can never mint a second mission (D-031). */
interface Draft {
  creationKey: string;
  base: BaseLoad;
}

function offlineOr(code: string, message: string): string {
  return code === "offline" ? "Can't reach Novus. Check your connection and try again." : message;
}

/**
 * Repository continuity, collapsed into the room's inspector (D-032): branch,
 * base, and branch status with retry — compact label/value rows, never the
 * canvas.
 */
function RepositoryInspector({
  detail,
  onDetail
}: {
  detail: MissionDetailResponse;
  onDetail: (detail: MissionDetailResponse) => void;
}) {
  const { mission, workstream } = detail;
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  if (!mission.repository || !workstream) {
    return <p className="inspector-note">No repository recorded for this mission.</p>;
  }

  const retry = async () => {
    setRetrying(true);
    setRetryError(null);
    const result = await novus().missions.retryBranch(workstream.workstreamId);
    setRetrying(false);
    if (result.ok) onDetail({ ...detail, workstream: result.value });
    else setRetryError(offlineOr(result.code, result.message));
  };

  return (
    <div className="repo-block" data-testid="repo-block">
      <span className="repo-label">Repository</span>
      <span className="repo-value" data-testid="repo-name">{mission.repository.name}</span>

      <span className="repo-label">Base</span>
      <span className="repo-value mono" data-testid="ws-base" title={workstream.baseSha}>
        {workstream.baseRef} · {shortSha(workstream.baseSha)}
      </span>

      <span className="repo-label">Mission branch</span>
      <span className="repo-value mono" data-testid="ws-branch">{workstream.missionBranch}</span>

      <span className="repo-label">Branch status</span>
      <span className="repo-value" data-testid="ws-branch-status">
        {workstream.branchStatus === "created" && <span className="branch-created">✓ Branch created</span>}
        {workstream.branchStatus === "pending" && <span className="branch-pending">Branch pending</span>}
        {workstream.branchStatus === "failed" && (
          <>
            <span className="inline-error" data-testid="branch-error">
              {workstream.branchError ?? "Branch creation failed."}
            </span>{" "}
            <button className="btn btn-text" onClick={retry} disabled={retrying} data-testid="retry-branch">
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
    </div>
  );
}

function SysLine({ children, danger, testid }: { children: ReactNode; danger?: boolean; testid?: string }) {
  return (
    <div className={danger ? "sys-line danger" : "sys-line"} data-testid={testid ?? "sys-line"}>
      {children}
    </div>
  );
}

/** The event feed rendered as a conversation (D-032 chat room). */
function Feed({ detail }: { detail: MissionDetailResponse }) {
  const events = [...detail.events].sort((a, b) => a.seq - b.seq);
  const nodes: ReactNode[] = [];
  let prevKind: string | null = null;

  const push = (event: MissionEvent, node: ReactNode) => {
    nodes.push(<div key={event.eventId} className="feed-item">{node}</div>);
    prevKind = event.kind;
  };

  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;
    switch (event.kind) {
      case "mission.created":
        // Its content IS the first user message; rendering it would double it.
        break;
      case "direction.submitted":
        push(event, <div className="msg-user" data-testid="msg-user">{String(payload.body ?? "")}</div>);
        break;
      case "harness.text":
        push(
          event,
          <div className="msg-agent" data-testid="msg-agent">
            <span className="mark-slot">
              {prevKind !== "harness.text" && (
                <span className="identity-mark system-mark" title="Claude Code">cc</span>
              )}
            </span>
            <span className="msg-agent-text">{String(payload.text ?? "")}</span>
          </div>
        );
        break;
      case "harness.tool":
        push(event, <div className="tool-line" data-testid="tool-line">· {String(payload.tool ?? "tool")}</div>);
        break;
      case "execution.started":
        push(event, <SysLine>Claude Code started</SysLine>);
        break;
      case "execution.completed":
        push(event, <SysLine>Turn completed</SysLine>);
        break;
      case "execution.failed":
        push(
          event,
          <SysLine danger>
            Turn failed{typeof payload.error === "string" ? ` — ${payload.error}` : ""}
          </SysLine>
        );
        break;
      case "execution.stopped":
        push(event, <SysLine>Stopped</SysLine>);
        break;
      case "workspace.checkpoint":
        push(
          event,
          <SysLine testid="checkpoint-line">
            checkpoint <span className="mono">{shortSha(String(payload.sha ?? ""))}</span>
          </SysLine>
        );
        break;
      case "workstream.created": {
        const branch = typeof payload.missionBranch === "string" ? payload.missionBranch : "a branch";
        const ref = typeof payload.baseRef === "string" ? payload.baseRef : "base";
        const sha = typeof payload.baseSha === "string" ? ` @ ${shortSha(payload.baseSha)}` : "";
        push(
          event,
          <SysLine>{`${detail.mission.createdByLogin} allocated branch ${branch} from ${ref}${sha}`}</SysLine>
        );
        break;
      }
      case "workstream.branch_created":
        push(event, <SysLine>branch created</SysLine>);
        break;
      case "workstream.branch_failed":
        push(event, <SysLine danger>branch creation failed</SysLine>);
        break;
      default:
        push(event, <SysLine>{event.kind}</SysLine>);
    }
  }

  return <>{nodes}</>;
}

/**
 * The project room (D-032): workstream tabs, a chat-shaped mission feed, and
 * the persistent composer. A "+" tab is a mission that does not exist yet —
 * the first message creates it, with the goal derived from the message.
 */
export function ProjectRoom({
  project,
  details,
  selectedMissionId,
  onSelectTab,
  onDetail,
  onCreated
}: {
  project: Project;
  details: Record<string, MissionDetailResponse>;
  selectedMissionId: string | null;
  onSelectTab: (missionId: string | null) => void;
  onDetail: (detail: MissionDetailResponse) => void;
  onCreated: (detail: MissionDetailResponse) => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const isDraft = selectedMissionId === null;
  const detail = selectedMissionId === null ? undefined : details[selectedMissionId];
  // Agents run where the repository is: local, on this machine (D-032).
  const canExecute = project.provider === "local" && project.onThisMachine;
  // A draft on a repository nothing can execute would swallow the first
  // message: the mission would be created and the words would go nowhere.
  // Say so before it is typed, not after (D-032 honesty rule).
  const composerEnabled = canExecute;

  const resolveBase = useCallback(async () => {
    setDraft((prev) =>
      prev
        ? { ...prev, base: { kind: "resolving" } }
        : { creationKey: crypto.randomUUID(), base: { kind: "resolving" } }
    );
    const result =
      project.provider === "local"
        ? await novus().repos.baseLocal(project.providerRepoId)
        : await novus().repos.base(project.providerRepoId);
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            base: result.ok
              ? { kind: "resolved", base: result.value }
              : { kind: "failed", message: offlineOr(result.code, result.message) }
          }
        : prev
    );
  }, [project.provider, project.providerRepoId]);

  useEffect(() => {
    if (isDraft && draft === null) void resolveBase();
  }, [isDraft, draft, resolveBase]);

  // The composer is the room's one focus target; it takes focus per tab.
  useEffect(() => {
    inputRef.current?.focus();
  }, [selectedMissionId]);

  // Poll the mission while its tab is visible: the feed and the running state
  // both come from the server every 2 seconds.
  useEffect(() => {
    if (selectedMissionId === null) {
      setRunning(false);
      return;
    }
    let live = true;
    const tick = async () => {
      const [detailResult, runningResult] = await Promise.all([
        novus().missions.get(selectedMissionId),
        canExecute ? novus().missions.running(selectedMissionId) : Promise.resolve(null)
      ]);
      if (!live) return;
      if (detailResult.ok) onDetail(detailResult.value);
      if (runningResult?.ok) setRunning(runningResult.value);
    };
    void tick();
    const timer = setInterval(() => void tick(), 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [selectedMissionId, canExecute, onDetail]);

  // Auto-scroll on new events unless the user scrolled up to read.
  const eventCount = detail?.events.length ?? 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [eventCount, selectedMissionId]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 48;
  };

  useEffect(() => {
    if (!inspectorOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setInspectorOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inspectorOpen]);

  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, Math.floor(window.innerHeight * 0.4))}px`;
  };

  const send = async () => {
    const body = text.trim();
    if (!body || sending || running) return;
    setSendError(null);

    if (isDraft) {
      if (!draft || draft.base.kind !== "resolved") return;
      setSending(true);
      const created = await novus().missions.create({
        goal: deriveGoal(body),
        successCriteria: body,
        provider: project.provider,
        providerRepoId: project.providerRepoId,
        baseRef: draft.base.base.ref,
        baseSha: draft.base.base.sha,
        creationKey: draft.creationKey
      });
      if (!created.ok) {
        setSending(false);
        setSendError(
          created.code === "offline"
            ? "Can't reach Novus. Nothing was created — try again when you're back online."
            : created.message
        );
        return;
      }
      if (canExecute) {
        const directed = await novus().missions.direct({
          missionId: created.value.mission.missionId,
          body
        });
        setSending(false);
        if (!directed.ok) {
          // The mission exists but the words never landed anywhere. Keep them
          // in the composer rather than swallowing what the user typed.
          setSendError(offlineOr(directed.code, directed.message));
          setDraft(null);
          onCreated({ mission: created.value.mission, workstream: created.value.workstream, events: [] });
          return;
        }
        setRunning(true);
      } else {
        setSending(false);
      }
      setText("");
      setDraft(null);
      onCreated({ mission: created.value.mission, workstream: created.value.workstream, events: [] });
      return;
    }

    if (!detail?.workstream || !canExecute) return;
    setSending(true);
    const result = await novus().missions.direct({
      missionId: detail.mission.missionId,
      body
    });
    setSending(false);
    if (result.ok) {
      setText("");
      setRunning(true);
    } else {
      setSendError(offlineOr(result.code, result.message));
    }
  };

  const stop = () => {
    if (selectedMissionId) void novus().missions.stop(selectedMissionId);
  };

  return (
    <div className="room" data-testid="project-room">
      <div className="tabbar" role="tablist" aria-label={`Workstreams in ${project.name}`}>
        {project.missions.map((mission) => (
          <button
            key={mission.missionId}
            role="tab"
            aria-selected={mission.missionId === selectedMissionId}
            className={mission.missionId === selectedMissionId ? "tab active" : "tab"}
            onClick={() => onSelectTab(mission.missionId)}
            title={mission.goal}
            data-testid="ws-tab"
          >
            {truncateLabel(mission.goal)}
          </button>
        ))}
        {isDraft && (
          <button role="tab" aria-selected className="tab active" data-testid="draft-tab">
            New
          </button>
        )}
        <button
          className="tab tab-new"
          onClick={() => onSelectTab(null)}
          title="New workstream (⌘T)"
          aria-label="New workstream"
          data-testid="new-tab"
        >
          +
        </button>
      </div>

      {!isDraft && detail && (
        <div className="room-head">
          <span className="room-goal" data-testid="room-goal">{detail.mission.goal}</span>
          <span className="head-spacer" />
          <button
            className="btn btn-text"
            onClick={() => setInspectorOpen((open) => !open)}
            aria-expanded={inspectorOpen}
            data-testid="inspector-toggle"
          >
            Details
          </button>
          {inspectorOpen && (
            <div className="inspector" role="dialog" aria-label="Repository details" data-testid="inspector">
              <RepositoryInspector detail={detail} onDetail={onDetail} />
            </div>
          )}
        </div>
      )}

      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="chat" data-testid="chat">
          {isDraft ? (
            draft === null || draft.base.kind === "resolving" ? (
              <p className="quiet-line">Resolving base…</p>
            ) : draft.base.kind === "failed" ? (
              <p className="quiet-line">
                <span className="inline-error" data-testid="base-error">{draft.base.message}</span>{" "}
                <button className="btn btn-text" onClick={() => void resolveBase()} data-testid="base-retry">
                  Try again
                </button>
              </p>
            ) : (
              <p className="quiet-line" data-testid="draft-base">
                {project.name} · <span className="mono">{draft.base.base.ref}</span> ·{" "}
                <span className="mono">{shortSha(draft.base.base.sha)}</span>
              </p>
            )
          ) : detail ? (
            <Feed detail={detail} />
          ) : (
            <div data-testid="feed-loading">
              <div className="placeholder-block" />
              <div className="placeholder-block" />
              <div className="placeholder-block" />
            </div>
          )}
        </div>
      </div>

      <div className="composer-bar" data-testid="composer">
        {sendError && (
          <p className="inline-error" role="alert" data-testid="send-error">{sendError}</p>
        )}
        <textarea
          ref={inputRef}
          className="composer-input"
          placeholder="Direct the agent — what should happen?"
          value={text}
          rows={1}
          disabled={!composerEnabled || running || sending}
          onChange={(event) => {
            setText(event.target.value);
            grow(event.target);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          aria-label="Direct the agent"
          data-testid="composer-input"
        />
        <div className="composer-foot">
          {canExecute && (
            <span className="harness-chip">
              <span className="identity-mark system-mark" title="Claude Code">cc</span>
              Claude Code · Local
            </span>
          )}
          {!composerEnabled && (
            <span className="composer-note" data-testid="composer-disabled">
              Agents run on local repositories for now — cloud execution arrives later.
            </span>
          )}
          {running && (
            <span className="composer-working" data-testid="working">
              <span className="status-dot active breath" />
              Working…
              <button className="btn btn-text" onClick={stop} data-testid="stop">
                Stop
              </button>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
