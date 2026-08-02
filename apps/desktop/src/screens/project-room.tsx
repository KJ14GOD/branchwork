import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BaseRevision,
  Direction,
  Effort,
  Mission,
  MissionDetailResponse,
  ModelId
} from "@novus/contracts";
import { novus } from "../bridge";
import { Composer, type SubmitOutcome } from "../components/composer";
import {
  controller as controllerOf,
  deriveStateLine,
  viewerIsController
} from "../components/derive";
import {
  ControlEventRow,
  TraceView,
  buildFeed
} from "../components/direction-trace";
import { GatedAction } from "../components/gated";
import { Baton, HumanMark } from "../components/identity";
import type { InspectorSection } from "../components/inspector";
import { clockTime, deriveGoal, shortSha, truncateLabel } from "../format";
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
 * The Mission Room (D-032). Top to bottom it answers the room's questions in
 * one order: what work (the title), what is happening and what happens next
 * (the state line), who is in control and who is here (the authority row),
 * what the agent did and which direction caused it (the trace), and what
 * changed and what was verified (the inspector, one keystroke away).
 *
 * Repository, model, and revision machinery live in the inspector, never in
 * the header (DESIGN.md prohibited pattern 12).
 */
export function ProjectRoom({
  project,
  details,
  selectedMissionId,
  onInspector,
  onSelectTab,
  onDetail,
  onCreated
}: {
  project: Project;
  details: Record<string, MissionDetailResponse>;
  selectedMissionId: string | null;
  /** Opening the evidence panel is the shell's job — it owns the panel and the
   *  control that shows it. The room only ever asks for a section. */
  onInspector: (section: InspectorSection | null) => void;
  onSelectTab: (missionId: string | null) => void;
  onDetail: (detail: MissionDetailResponse) => void;
  onCreated: (mission: Mission) => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  const isDraft = selectedMissionId === null;
  const detail = selectedMissionId === null ? undefined : details[selectedMissionId];
  // Agents run where the repository is: local, on this machine (D-032).
  const executionAvailable = project.provider === "local" && project.onThisMachine;

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

  // One poll carries the whole room: state, participants, control, directions,
  // executions, evidence (ARCHITECTURE.md — MissionDetailResponse).
  useEffect(() => {
    if (selectedMissionId === null) return;
    let live = true;
    const tick = async () => {
      const result = await novus().missions.get(selectedMissionId);
      if (live && result.ok) onDetail(result.value);
    };
    void tick();
    const timer = setInterval(() => void tick(), 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [selectedMissionId, onDetail]);

  // Auto-scroll on new activity unless the reader scrolled up.
  const eventCount = detail?.events.length ?? 0;
  useEffect(() => {
    const element = scrollRef.current;
    if (element && pinnedRef.current) element.scrollTop = element.scrollHeight;
  }, [eventCount, selectedMissionId]);

  // Resizing the window must not strand the feed halfway up: a reader who was
  // at the bottom stays at the bottom.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    pinnedRef.current = element.scrollTop + element.clientHeight >= element.scrollHeight - 48;
  };

  // Room keys (DESIGN.md#keyboard): G then C/V/A, R to request control.
  const chordRef = useRef(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (chordRef.current) {
        chordRef.current = false;
        if (key === "c") onInspector("changes");
        else if (key === "v") onInspector("verification");
        else if (key === "a") onInspector(null);
        return;
      }
      if (key === "g") {
        chordRef.current = true;
        setTimeout(() => {
          chordRef.current = false;
        }, 1200);
      } else if (key === "r" && detail?.capabilities.includes("control.request")) {
        void novus().control.request(detail.mission.missionId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail]);

  const submit = async ({
    body,
    model,
    effort
  }: {
    body: string;
    model: ModelId;
    effort: Effort;
  }): Promise<SubmitOutcome> => {
    setActionError(null);
    if (isDraft) {
      if (!draft || draft.base.kind !== "resolved") {
        return { ok: false, message: "The base revision is not resolved yet." };
      }
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
        return {
          ok: false,
          message:
            created.code === "offline"
              ? "Can't reach Novus. Nothing was created — try again when you're back online."
              : created.message
        };
      }
      const directed = await novus().missions.direct({
        missionId: created.value.mission.missionId,
        body,
        model,
        effort
      });
      setDraft(null);
      onCreated(created.value.mission);
      if (!directed.ok) {
        // The mission exists but the words never landed. Say so at the site of
        // the failure rather than swallowing what the user typed.
        setActionError(offlineOr(directed.code, directed.message));
        return { ok: false, message: offlineOr(directed.code, directed.message) };
      }
      return {
        ok: true,
        queued: !directed.value.dispatched,
        deferred: directed.value.deferred
      };
    }

    if (!detail) return { ok: false, message: "This workstream is still loading." };
    const result = await novus().missions.direct({
      missionId: detail.mission.missionId,
      body,
      model,
      effort
    });
    if (!result.ok) return { ok: false, message: offlineOr(result.code, result.message) };
    return { ok: true, queued: !result.value.dispatched, deferred: result.value.deferred };
  };

  const feed = useMemo(() => (detail ? buildFeed(detail) : null), [detail]);
  const stateLine = detail ? deriveStateLine(detail) : null;
  const controller = detail ? controllerOf(detail) : null;
  const isController = detail ? viewerIsController(detail) : false;
  const liveOffer = detail?.control.liveOffer ?? null;
  const offerIsLive =
    liveOffer !== null && ["open", "accepted", "waiting_for_boundary"].includes(liveOffer.state);

  const runAction = async (call: Promise<{ ok: boolean; message?: string }>) => {
    const result = await call;
    if (!result.ok) setActionError(result.message ?? "That did not go through.");
    else setActionError(null);
  };

  const directionActions = (direction: Direction) => {
    if (!detail) return null;
    // Apply and Reject belong to the lease, not to authorship: the server
    // grants `direction.apply` to whoever holds the baton, including for their
    // own direction, so the interface may never hide a verb the server allows
    // (AGENTS.md rule 13, in the mirror). Cancel belongs to the author.
    const mine = direction.authorUserId === detail.viewerUserId;
    return (
      <span className="inline-actions">
        <GatedAction
          capability="direction.apply"
          capabilities={detail.capabilities}
          denialReason="Only the controller can apply direction."
          holderLogin={detail.control.holderLogin}
          onClick={() =>
            void runAction(
              novus().missions.resolveDirection({ directionId: direction.directionId, action: "apply" })
            )
          }
          variant="secondary"
          testid="apply-direction"
        >
          Apply
        </GatedAction>
        <GatedAction
          capability="direction.apply"
          capabilities={detail.capabilities}
          denialReason="Only the controller can reject direction."
          holderLogin={detail.control.holderLogin}
          onClick={() =>
            void runAction(
              novus().missions.resolveDirection({ directionId: direction.directionId, action: "reject" })
            )
          }
          variant="text"
          testid="reject-direction"
        >
          Reject
        </GatedAction>
        {mine && (
          <button
            className="btn btn-text"
            onClick={() => void runAction(novus().missions.cancelDirection(direction.directionId))}
            data-testid="cancel-direction"
          >
            Cancel
          </button>
        )}
      </span>
    );
  };

  const title = isDraft ? "New workstream" : (detail?.mission.goal ?? "Loading workstream");

  return (
    <div className="room" data-testid="project-room">
      <div className="room-main">
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

      <header className="room-header">
        <h1 className="mission-title" data-testid="room-goal" title={title}>
          {title}
        </h1>

        <div className="state-line" role="status" aria-live="polite" data-testid="state-line">
          {stateLine ? (
            <>
              <span
                className={`status-dot ${stateLine.tone}${stateLine.working ? " breath" : ""}`}
                data-testid={stateLine.working ? "working" : "state-dot"}
              />
              <span className="state-name">{stateLine.name}</span>
              <span className="state-detail">— {stateLine.detail}</span>
              {stateLine.suffix && <span className="state-detail">· {stateLine.suffix}</span>}
              {stateLine.action?.kind === "stop" && detail && (
                <GatedAction
                  capability="execution.stop"
                  capabilities={detail.capabilities}
                  denialReason="Only participants who can stop this execution may stop it."
                  onClick={() => void runAction(novus().missions.stop(detail.mission.missionId))}
                  variant="secondary"
                  testid="stop"
                >
                  Stop
                </GatedAction>
              )}
              {(stateLine.action?.kind === "changes" || stateLine.action?.kind === "verification") && (
                <button
                  className="btn btn-secondary"
                  onClick={() =>
                    onInspector(stateLine.action?.kind === "verification" ? "verification" : "changes")
                  }
                  data-testid="state-action"
                >
                  {stateLine.action.label}
                </button>
              )}
            </>
          ) : (
            <>
              <span className="status-dot neutral" />
              <span className="state-name">Ready</span>
              <span className="state-detail">
                {isDraft ? "— the first direction creates this workstream" : "— loading this workstream"}
              </span>
              {isDraft && !executionAvailable && (
                <span className="state-detail">
                  · no machine has this repository checked out for Novus yet
                </span>
              )}
            </>
          )}
        </div>

        <div className="authority-row">
          {detail ? (
            <>
              <span className="controller-slot" data-testid="controller">
                {controller ? (
                  <>
                    <HumanMark login={controller.login} name={controller.name} />
                    <Baton holderUserId={controller.userId} />
                    <span className="controller-name">
                      {isController ? "You have the baton" : `${controller.name ?? controller.login} has the baton`}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="status-dot warn" />
                    <span className="controller-name">No one holds the baton</span>
                  </>
                )}
              </span>
              {!isController && (
                <GatedAction
                  capability="control.request"
                  capabilities={detail.capabilities}
                  denialReason="Only participants who can operate this mission may request control."
                  holderLogin={detail.control.holderLogin}
                  onClick={() => void runAction(novus().control.request(detail.mission.missionId))}
                  variant="text"
                  testid="request-control"
                >
                  Request control
                </GatedAction>
              )}
              <span className="head-spacer" />
            </>
          ) : (
            <span className="controller-name quiet">
              {isDraft ? "Nobody has joined this workstream yet" : "Loading participants…"}
            </span>
          )}
        </div>
      </header>

      {actionError && (
        <p className="inline-error room-error" role="alert" data-testid="action-error">
          {actionError}
        </p>
      )}

      <div className="feed-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="feed" data-testid="chat">
          {isDraft ? (
            <DraftCanvas draft={draft} project={project} onRetry={() => void resolveBase()} />
          ) : detail && feed ? (
            <>
              {feed.setup && (
                <div
                  className={feed.setup.danger ? "workspace-row danger" : "workspace-row"}
                  data-testid="setup-row"
                >
                  <span className="status-dot neutral" />
                  <span>{feed.setup.label}</span>
                  <button
                    className="btn btn-text workspace-row-action"
                    onClick={() => onInspector("overview")}
                    data-testid="setup-overview"
                  >
                    Overview
                  </button>
                </div>
              )}
              {feed.blocks.map((block) =>
                block.kind === "control" ? (
                  <ControlEventRow key={block.key} block={block} />
                ) : (
                  <TraceView
                    key={block.key}
                    block={block}
                    controllerUserId={detail.control.holderUserId}
                    controllerLogin={detail.control.holderLogin}
                    viewerIsController={isController}
                    onOpenChanges={() => onInspector("changes")}
                    onOpenVerification={() => onInspector("verification")}
                    actions={block.direction ? directionActions(block.direction) : null}
                  />
                )
              )}

              {detail.control.openRequests
                .filter((request) => request.state === "open")
                .map((request) => (
                  <div className="authority-card" key={request.requestId} data-testid="control-request">
                    <span className="status-dot warn" />
                    <HumanMark login={request.requesterLogin} />
                    <span className="authority-text">
                      <strong>{request.requesterLogin}</strong> requests control
                    </span>
                    <span className="trace-time">{clockTime(request.createdAt)}</span>
                    {request.requesterUserId === detail.viewerUserId ? (
                      <button
                        className="btn btn-text"
                        onClick={() => void runAction(novus().control.withdrawRequest(detail.mission.missionId))}
                        data-testid="withdraw-request"
                      >
                        Withdraw
                      </button>
                    ) : (
                      <span className="inline-actions">
                        <GatedAction
                          capability="control.offer"
                          capabilities={detail.capabilities}
                          denialReason="Only the controller can offer control."
                          holderLogin={detail.control.holderLogin}
                          onClick={() =>
                            void runAction(
                              novus().control.offer({
                                missionId: detail.mission.missionId,
                                toUserId: request.requesterUserId
                              })
                            )
                          }
                          variant="secondary"
                          testid="offer-control"
                        >
                          Offer
                        </GatedAction>
                        <GatedAction
                          capability="control.offer"
                          capabilities={detail.capabilities}
                          denialReason="Only the controller can decline a request for control."
                          holderLogin={detail.control.holderLogin}
                          onClick={() => void runAction(novus().control.declineRequest(request.requestId))}
                          variant="text"
                          testid="decline-request"
                        >
                          Decline
                        </GatedAction>
                      </span>
                    )}
                  </div>
                ))}

              {liveOffer && offerIsLive && (
                <div className="authority-card" data-testid="handoff-offer">
                  <span className="status-dot warn" />
                  <HumanMark login={liveOffer.fromLogin} />
                  <span className="authority-text">
                    <strong>{liveOffer.fromLogin}</strong> offers control to{" "}
                    {liveOffer.toUserId === detail.viewerUserId ? "you" : liveOffer.toLogin}
                  </span>
                  <span className="trace-time">{clockTime(liveOffer.createdAt)}</span>
                  {liveOffer.toUserId === detail.viewerUserId ? (
                    <span className="inline-actions">
                      <GatedAction
                        capability="control.accept"
                        capabilities={detail.capabilities}
                        denialReason="Only the named recipient can accept this offer."
                        onClick={() => void runAction(novus().control.acceptOffer(liveOffer.offerId))}
                        variant="secondary"
                        testid="accept-offer"
                      >
                        Accept
                      </GatedAction>
                      <button
                        className="btn btn-text"
                        onClick={() => void runAction(novus().control.declineOffer(liveOffer.offerId))}
                        data-testid="decline-offer"
                      >
                        Decline
                      </button>
                    </span>
                  ) : (
                    <GatedAction
                      capability="control.offer"
                      capabilities={detail.capabilities}
                      denialReason="Only the controller can withdraw this offer."
                      holderLogin={detail.control.holderLogin}
                      onClick={() => void runAction(novus().control.withdrawOffer(liveOffer.offerId))}
                      variant="text"
                      testid="withdraw-offer"
                    >
                      Withdraw
                    </GatedAction>
                  )}
                </div>
              )}

              {feed.blocks.length === 0 && !feed.setup && (
                <p className="quiet" data-testid="feed-empty">
                  Nothing has happened here yet.
                </p>
              )}
            </>
          ) : (
            <div data-testid="feed-loading">
              <div className="placeholder-block" />
              <div className="placeholder-block" />
              <div className="placeholder-block" />
            </div>
          )}
        </div>
      </div>

      <Composer
        key={selectedMissionId ?? "draft"}
        /* A draft has no mission yet, so no server capabilities exist to read:
           creating one is an org act (PRODUCT.md#roles-and-capabilities) and
           the creator becomes its Mission Admin. */
        capabilities={isDraft ? ["direction.submit"] : (detail?.capabilities ?? null)}
        isController={isController || isDraft}
        onSubmit={submit}
      />

      </div>

    </div>
  );
}

/** The "+" tab before its first message: the pinned base, quietly, and one
 *  left-aligned sentence — never a form and never a marketing empty state. */
function DraftCanvas({
  draft,
  project,
  onRetry
}: {
  draft: Draft | null;
  project: Project;
  onRetry: () => void;
}) {
  if (draft === null || draft.base.kind === "resolving") {
    return <p className="quiet">Resolving the base revision…</p>;
  }
  if (draft.base.kind === "failed") {
    return (
      <p className="quiet">
        <span className="inline-error" data-testid="base-error">
          {draft.base.message}
        </span>{" "}
        <button className="btn btn-text" onClick={onRetry} data-testid="base-retry">
          Try again
        </button>
      </p>
    );
  }
  return (
    <div className="draft-canvas">
      <p className="draft-lead">The first direction creates this workstream and starts Claude Code.</p>
      <p className="quiet" data-testid="draft-base">
        Pinned to {project.name} · <span className="mono">{draft.base.base.ref}</span> ·{" "}
        <span className="mono">{shortSha(draft.base.base.sha)}</span>
      </p>
    </div>
  );
}
