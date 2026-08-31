import { useState } from "react";
import { attachmentForm } from "@novus/contracts";
import type { ApprovalRequest, Direction, DirectionAttachment, MissionDetailResponse } from "@novus/contracts";
import { novus } from "../bridge";
import { clockTime, compactCount, elapsed, plural, shortSha, usd } from "../format";
import { FileBadge, HarnessMark, HumanMark } from "./identity";
import { HarnessGlyph } from "./harness-glyph";
import { HARNESSES, type HarnessId } from "@novus/contracts";
import { Markdown } from "./markdown";
import type { ControlBlock, Feed, FeedBlock, Segment, ToolStep, TraceBlock, UsageTotals, WorkerView } from "./derive-feed";
import { buildFeed, HARNESS_NAME, workerFiles, workerState } from "./derive-feed";

/** The rendering half of the direction thread; the projection lives in
 *  derive-feed.ts. Re-exported so existing importers keep one entry point. */
export { buildFeed, workerFiles, workerState };
export type { Feed, FeedBlock, TraceBlock, ControlBlock, WorkerView };


/** One disclosure per trace: every tool call and every unnamed event the
 *  direction produced, counted honestly and out of the way. */
/**
 * The turn's workers as their own quiet rows on the trace (D-108, reversing
 * D-107's placement inside the disclosure on the owner's sight of it): the
 * way a terminal shows subagents — one line each, the purpose, the last
 * thing it did, its state in a word — and Enter or a click steps in. They
 * take the milestone anatomy, like CHECKPOINT, because that is what they
 * are: something the turn produced, worth one glance.
 */
function WorkerRows({
  workers,
  settled,
  onOpenWorker
}: {
  workers: WorkerView[];
  settled: boolean;
  onOpenWorker?: (workerId: string) => void;
}) {
  return (
    <div className="worker-rows" data-testid="worker-rollup">
      {workers.map((worker, index) => {
        const state = workerState(worker, settled);
        const last = worker.steps[worker.steps.length - 1] ?? null;
        const doing = last
          ? last.label === "said"
            ? (last.detail ?? "")
            : [last.label, last.detail].filter(Boolean).join(" ")
          : null;
        return (
          <button
            key={worker.id}
            className="milestone worker-line"
            data-testid="worker-row"
            onClick={() => onOpenWorker?.(worker.id)}
          >
            <span className="milestone-label">{index === 0 ? "workers" : ""}</span>
            <span className="worker-purpose">{worker.purpose ?? "Worker"}</span>
            {doing && <span className="worker-last mono">{doing}</span>}
            {state && (
              <span
                className={state === "failed" ? "worker-state tone-danger" : "worker-state"}
                data-testid="worker-state"
              >
                {state}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The steps between one thing the harness said and the next, where they
 * happened (D-203, reversing D-108's single end-of-turn disclosure): the
 * terminal's shape. Collapsed to one quiet line that names the run — `Read
 * ×21 · Bash ×3 · Grep` — because twenty-one reads of one file are one fact,
 * and expanding shows every step. The words that referred to these actions
 * sit directly above and below, which is the whole point.
 */
function runSummary(steps: ToolStep[]): string {
  const groups: { label: string; count: number }[] = [];
  for (const entry of steps) {
    const last = groups[groups.length - 1];
    if (last && last.label === entry.label) last.count += 1;
    else groups.push({ label: entry.label, count: 1 });
  }
  return groups.map((group) => (group.count > 1 ? `${group.label} ×${group.count}` : group.label)).join(" · ");
}

function ActivityRun({ steps }: { steps: ToolStep[] }) {
  return (
    <details className="disclosure activity-run" data-testid="technical-activity">
      <summary>
        <Chevron />
        <span className="mono activity-summary">{runSummary(steps)}</span>
        <span className="disclosure-count">{plural(steps.length, "step")}</span>
      </summary>
      <ul className="tool-list">
        {steps.map((step, index) => (
          <li
            key={index}
            data-testid="tool-line"
            className={step.nested ? "tool-line-nested" : undefined}
            // Indent is the grouping, as it is everywhere else in the trace: a
            // worker's step sits under the turn that spawned it.
            data-worker={step.nested ? "true" : undefined}
          >
            <span className="mono tool-name">{step.label}</span>
            {step.detail && <span className="tool-detail">{step.detail}</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}

function Chevron() {
  return (
    <svg
      className="disclosure-chevron"
      viewBox="0 0 16 16"
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

function CheckpointRow({
  segment,
  onOpenChanges
}: {
  segment: Segment & { kind: "checkpoint" };
  /** Opens Changes for this turn's checkpoint when it has one (D-213), else
   *  the mission-wide list. */
  onOpenChanges: (checkpointId: string | null) => void;
}) {
  const checkpoint = segment.checkpoint;
  return (
    <div className="milestone" data-testid="checkpoint-line">
      <span className="milestone-label">Checkpoint</span>
      <span className="milestone-body">
        {checkpoint ? (
          <>
            {plural(checkpoint.filesChanged, "file")} changed{" "}
            {/* The sign says which way; the colour agrees with it. Same two
                tokens the diff itself uses, so one change reads the same in
                the trace and in the panel (D-065). */}
            <span className="change-counts mono">
              <span className="count-add">+{checkpoint.additions}</span>
              <span className="count-del">−{checkpoint.deletions}</span>
            </span>
          </>
        ) : (
          "checkpoint recorded"
        )}
        {segment.sha && <span className="mono milestone-sha"> {shortSha(segment.sha)}</span>}
        {checkpoint?.withheldSecrets ? ` · ${plural(checkpoint.withheldSecrets, "secret")} withheld` : ""}
        {/* A scoped turn's shell side-effects, or a parallel sibling's work in
            flight: named, never committed by this turn (D-097). */}
        {checkpoint && checkpoint.driftPaths.length > 0 ? (
          <span className="tone-warn" data-testid="checkpoint-drift">
            {` · ${plural(checkpoint.driftPaths.length, "file")} outside its scope, uncommitted`}
          </span>
        ) : checkpoint?.uncommitted ? (
          " · uncommitted"
        ) : (
          ""
        )}
      </span>
      {checkpoint && checkpoint.filesChanged > 0 && (
        <button
          className="btn btn-text milestone-action"
          onClick={() => onOpenChanges(segment.checkpoint?.checkpointId ?? null)}
          data-testid="trace-open-changes"
        >
          Changes
        </button>
      )}
    </div>
  );
}

function ChecksRow({
  segment,
  onOpenVerification
}: {
  segment: Segment & { kind: "checks" };
  onOpenVerification: () => void;
}) {
  const passed = segment.checks.filter((check) => check.outcome === "passed").length;
  const failed = segment.checks.filter(
    (check) => check.outcome === "failed" || check.outcome === "errored"
  ).length;
  return (
    <div className="milestone" data-testid="verification-line">
      <span className="milestone-label">Verification</span>
      <span className="milestone-body">
        {failed > 0 ? `${failed} failed, ${passed} passed` : `${plural(passed, "check")} passed`}
      </span>
      <button className="btn btn-text milestone-action" onClick={onOpenVerification} data-testid="trace-open-verification">
        Verification
      </button>
    </div>
  );
}

function SegmentView({
  segment,
  continued = false,
  printout = false,
  harness = null,
  onOpenChanges,
  onOpenVerification
}: {
  segment: Segment;
  /** Which harness spoke this turn (D-232); null names Claude Code, the
   *  only speaker there was before harnesses were plural. */
  harness?: HarnessId | null;
  /** True for harness speech that follows earlier speech in the same turn,
   *  so the identity is stated once per turn rather than per paragraph. */
  continued?: boolean;
  /** True when the turn answered a built-in command (D-216): speech is the
   *  CLI's own printout and renders preformatted. */
  printout?: boolean;
  onOpenChanges: (checkpointId: string | null) => void;
  onOpenVerification: () => void;
}) {
  switch (segment.kind) {
    case "activity":
      return <ActivityRun steps={segment.steps} />;
    case "workers":
      // Resolved by the block, which holds the workers' live state.
      return null;
    case "harness":
      return (
        <div className={continued ? "harness-turn harness-continued" : "harness-turn"} data-testid="msg-agent">
          {/* One identity per turn (D-065), said once: speech that resumes
              after a run of activity is the same speaker continuing, and a
              repeated mark every few lines would be the chat-app clutter
              signature element 2 refuses. */}
          {!continued && (
            <span className="harness-identity">
              {harness === "codex" ? (
                <span className="mark mark-harness" aria-hidden="true">
                  <HarnessGlyph harness="codex" fallback={null} />
                </span>
              ) : (
                <HarnessMark />
              )}
              <span className="harness-name">
                {HARNESSES.find((entry) => entry.id === harness)?.label ?? HARNESS_NAME}
              </span>
            </span>
          )}
          <div className="harness-body">
            {/* The harness speaks markdown; showing its `##` and `**` raw made
                every substantive reply read like source. Rendered through the
                same element-only Markdown as a file preview (D-048), because a
                reply is repository-adjacent content by the same argument. A
                built-in command's answer is the one exception (D-216): it is
                the CLI's own printout, and markdown ate its line breaks and
                read its underscores as emphasis — so it is shown as it came. */}
            {printout ? (
              <pre className="md-pre mono harness-printout" data-testid="harness-printout">
                {segment.texts.join("\n")}
              </pre>
            ) : (
              segment.texts.map((paragraph, index) => <Markdown key={index} source={paragraph} />)
            )}
          </div>
        </div>
      );
    case "checkpoint":
      return <CheckpointRow segment={segment} onOpenChanges={onOpenChanges} />;
    case "checks":
      return <ChecksRow segment={segment} onOpenVerification={onOpenVerification} />;
    case "note":
      return (
        <div className={`trace-note tone-${segment.tone}`} data-testid="trace-note">
          {segment.login && <HumanMark login={segment.login} />}
          <span>{segment.text}</span>
        </div>
      );
    case "outcome":
      return (
        <div className={`trace-outcome tone-${segment.tone}`} data-testid="trace-outcome">
          {segment.text}
        </div>
      );
  }
}

/**
 * What the turn cost, stated beside the model that ran it — apparatus, at the
 * meta step, never a tile and never a chart (DESIGN.md prohibited pattern 16).
 *
 * A figure the harness did not report is left out rather than shown as zero:
 * every number here is the harness's own claim, and inventing a zero would be
 * Novus asserting something nobody told it.
 */
function usageLine(usage: UsageTotals | null): string | null {
  if (!usage) return null;
  const parts: string[] = [];
  if (usage.inputTokens > 0 || usage.outputTokens > 0) {
    parts.push(`${compactCount(usage.inputTokens)} in`, `${compactCount(usage.outputTokens)} out`);
  }
  if (usage.costUsd !== null) parts.push(usd(usage.costUsd));
  if (usage.durationMs !== null) parts.push(elapsed(usage.durationMs));
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Line treatment carries the direction's lifecycle: live threads keep the
 *  accent line, settled or waiting ones fall back to the neutral edge. */
function traceStateClass(direction: Direction | null): string {
  if (!direction) return "trace";
  switch (direction.state) {
    case "submitted":
    case "queued":
      return "trace trace-waiting";
    case "rejected":
    case "superseded":
    case "cancelled":
      return "trace trace-settled";
    case "applied":
      return "trace";
  }
}

export function TraceView({
  block,
  controllerUserId,
  controllerLogin,
  viewerIsController,
  onOpenChanges,
  onOpenVerification,
  onOpenWorker,
  onOpenImage,
  actions,
  approvals,
  queuePosition
}: {
  block: TraceBlock;
  controllerUserId: string | null;
  controllerLogin: string | null;
  viewerIsController: boolean;
  onOpenChanges: (checkpointId: string | null) => void;
  onOpenVerification: () => void;
  /** Opens one worker's own view on the canvas (D-107). */
  onOpenWorker?: (workerId: string) => void;
  /** Brings an attached image to the front at full size (D-152). */
  onOpenImage?: (image: { artifactId: string; label: string; mimeType: string }) => void;
  /** Apply / Reject / Cancel for a direction still awaiting judgment. */
  actions?: React.ReactNode;
  /** Permission questions this execution is blocked on, if any. */
  approvals?: React.ReactNode;
  /** "2 of 3" while several directions wait in this lane's queue; null when
   *  the waiting row would be numbering a queue of one (DESIGN.md *Direction
   *  queued*). */
  queuePosition?: string | null;
}) {
  const direction = block.direction;
  const waiting = direction?.state === "submitted" || direction?.state === "queued";
  const ownedByController =
    direction !== null && controllerUserId !== null && direction.authorUserId === controllerUserId;
  const settled =
    direction?.state === "rejected" ||
    direction?.state === "superseded" ||
    direction?.state === "cancelled";
  // Reading order inside a trace: what was asked, what the harness said, how
  // it did it, what it produced, how it ended. Grouped speech and compact
  // milestone rows — no stage chrome down the side (D-125, reversing D-124's
  // spine: agent work loops, and a fixed four-step timeline read as theater).
  // The turn as it happened (D-203): speech, the activity between speech, and
  // the workers where they were spawned — one stream, in stream order.
  const stream = block.segments.filter(
    (segment) =>
      segment.kind === "harness" ||
      segment.kind === "note" ||
      segment.kind === "activity" ||
      segment.kind === "workers"
  );
  let spoke = false;
  const checkpoints = block.segments.filter((segment) => segment.kind === "checkpoint");
  const checkRuns = block.segments.filter((segment) => segment.kind === "checks");
  const outcomes = block.segments.filter((segment) => segment.kind === "outcome");

  return (
    <article
      className={traceStateClass(direction)}
      data-testid="direction-trace"
      data-direction-state={direction?.state ?? "none"}
      // The block's own address (D-168): the direction that opened it, so a
      // capture's `executionId` can resolve to a real turn to scroll to
      // rather than only the conversation it happened in.
      data-block-key={block.key}
    >
      {/* What the person said, on the room's right (D-162). A turn is a
          conversation with two sides, and giving each its own side is what
          lets a reader find the question without reading the answer. The
          attribution stays — this room can hold several people, so "who said
          it" is not decoration the way it is in a two-party chat. */}
      {block.body !== null && (
        <div className="trace-said">
          <header className="trace-head">
            {block.authorLogin && <HumanMark login={block.authorLogin} />}
            <span className="trace-author">{block.authorLogin ?? "Unattributed"}</span>
            {block.authorUserId && block.authorUserId === controllerUserId && (
              <span className="trace-controller">holds the baton</span>
            )}
            {block.at && <span className="trace-time">{clockTime(block.at)}</span>}
          </header>
          <p className="trace-body prose" data-testid="msg-user">
            {block.body}
          </p>
        </div>
      )}

      {/* What the person sent with the words (D-150). The image itself, at a
          size that reads without taking the turn over — the picture is the
          point, and a filename beside a turn about a screenshot says less than
          the screenshot does. An attachment whose bytes never verified is
          named rather than dropped: the record must not imply the harness saw
          something it did not. */}
      {/* What the message was pointed at (D-182): quiet pills, the transcript
          pill's shape — a file by its path, a check by its name and the
          outcome it had when referenced. References the reader can follow in
          the panel; nothing here opens bytes. */}
      {(direction?.context ?? []).length > 0 && (
        <div className="trace-attachments" data-testid="direction-context">
          {(direction?.context ?? []).map((ref) => (
            <span
              className="trace-attachment-transcript"
              key={ref.kind === "file" ? `file:${ref.path}` : `check:${ref.checkId}`}
              title={ref.kind === "file" ? ref.path : ref.command}
              data-testid="trace-context"
            >
              <span className="trace-attachment-transcript-name">
                {ref.kind === "file" ? ref.path : `${ref.name} · ${ref.outcome}`}
              </span>
            </span>
          ))}
        </div>
      )}
      {(direction?.attachments ?? []).length > 0 && (
        <div className="trace-attachments" data-testid="direction-attachments">
          {(direction?.attachments ?? []).map((image) =>
            image.state !== "available" ? (
              <span className="trace-attachment-missing" key={image.artifactId}>
                {image.label} — not uploaded, so the turn never saw it
              </span>
            ) : image.kind === "transcript" ? (
              /* A carried sibling's record (D-173), worn quietly (D-175): one
                 line, no size, no staging note — context, not cargo. Clicking
                 still opens the document. */
              <button
                className="trace-attachment-transcript"
                key={image.artifactId}
                onClick={() => void novus().artifacts.openLocal(image.artifactId)}
                title={`Open ${image.label}`}
                data-testid="trace-transcript"
              >
                <span className="trace-attachment-transcript-name">{image.label}</span>
              </button>
            ) : attachmentForm(image.mimeType) !== "image" ? (
              <DocChip
                key={image.artifactId}
                attachment={image}
                onOpen={
                  onOpenImage &&
                  (image.mimeType === "application/pdf" ||
                    image.mimeType.startsWith("video/") ||
                    image.mimeType.startsWith("audio/"))
                    ? () =>
                        onOpenImage({
                          artifactId: image.artifactId,
                          label: image.label,
                          mimeType: image.mimeType
                        })
                    : undefined
                }
              />
            ) : (
              <button
                className="trace-attachment-open"
                key={image.artifactId}
                // The picture is the control (D-152): clicking it brings it to
                // the front at full size, and nothing about it navigates.
                onClick={() => onOpenImage?.({ artifactId: image.artifactId, label: image.label, mimeType: image.mimeType })}
                aria-label={`Open ${image.label}`}
              >
                <img
                  className="trace-attachment-image"
                  src={`novus-artifact://${image.artifactId}/blob`}
                  // The name is not shown — a screenshot's filename says
                  // nothing a person reading the picture needs — but it stays
                  // the accessible name, the one place it is still the only
                  // thing a reader has.
                  alt={image.label}
                  title={image.label}
                  loading="lazy"
                />
              </button>
            )
          )}
        </div>
      )}
      {/* The controller's own direction applies at the next receptive point
          without further action (PRODUCT.md#direction), so it is never
          presented to them as something to approve. */}
      {waiting && ownedByController && (
        <div className="trace-waiting-row" data-testid="direction-queued">
          <span>Queued — applies at the next safe point</span>
          {queuePosition && (
            <span className="queue-position" data-testid="queue-position">
              {queuePosition} in the queue
            </span>
          )}
          {actions}
        </div>
      )}
      {waiting && !ownedByController && (
        <div className="trace-waiting-row" data-testid="direction-waiting">
          <span>
            {viewerIsController
              ? "Waiting for you — apply or reject it here"
              : controllerLogin
                ? `Waiting for ${controllerLogin} to apply this direction`
                : "Waiting — no one holds the baton"}
          </span>
          {queuePosition && (
            <span className="queue-position" data-testid="queue-position">
              {queuePosition} in the queue
            </span>
          )}
          {actions}
        </div>
      )}
      {settled && direction && (
        <div className="trace-waiting-row" data-testid="direction-settled">
          <span>
            {direction.state === "rejected" &&
              (block.resolvedBy ? `Rejected by ${block.resolvedBy}` : "Rejected")}
            {direction.state === "superseded" && "Superseded by a later direction"}
            {direction.state === "cancelled" &&
              (block.resolvedBy ? `Cancelled by ${block.resolvedBy}` : "Cancelled by its author")}
            {direction.resolutionReason ? ` — ${direction.resolutionReason}` : ""}
          </span>
        </div>
      )}

      {(block.machinery || block.usage) && (
        <div className="trace-machinery" data-testid="trace-machinery">
          {[block.machinery, usageLine(block.usage)].filter(Boolean).join(" · ")}
        </div>
      )}

      {stream.map((segment) => {
        if (segment.kind === "workers") {
          const spawned = segment.ids
            .map((id) => block.workers.find((worker) => worker.id === id))
            .filter((worker): worker is WorkerView => worker !== undefined);
          return spawned.length > 0 ? (
            <WorkerRows key={segment.key} workers={spawned} settled={block.settled} onOpenWorker={onOpenWorker} />
          ) : null;
        }
        const continued = segment.kind === "harness" && spoke;
        if (segment.kind === "harness") spoke = true;
        return (
          <SegmentView
            key={segment.key}
            harness={block.harness}
            segment={segment}
            continued={continued}
            printout={block.printout}
            onOpenChanges={onOpenChanges}
            onOpenVerification={onOpenVerification}
          />
        );
      })}

      {checkpoints.map((segment) => (
        <SegmentView
          key={segment.key}
          harness={block.harness}
          segment={segment}
          onOpenChanges={onOpenChanges}
          onOpenVerification={onOpenVerification}
        />
      ))}

      {checkRuns.map((segment) => (
        <SegmentView
          key={segment.key}
          harness={block.harness}
          segment={segment}
          onOpenChanges={onOpenChanges}
          onOpenVerification={onOpenVerification}
        />
      ))}

      {outcomes.map((segment) => (
        <SegmentView
          key={segment.key}
          harness={block.harness}
          segment={segment}
          onOpenChanges={onOpenChanges}
          onOpenVerification={onOpenVerification}
        />
      ))}

      {/* Last, because it is where the harness stopped: everything above is
          what it did, and this is what it is waiting on (D-062). */}
      {approvals}
    </article>
  );
}

/**
 * A permission the harness is asking for, in the thread where it asked.
 *
 * Not a dialog and not a notification centre: the question belongs beside the
 * work that raised it, because "may I run this" is only answerable by someone
 * reading what came before it (DESIGN.md#state-presentation).
 *
 * Only the lease holder may answer, and that is the server's decision — this
 * renders what the server said about the viewer's capabilities and nothing it
 * inferred locally. Everyone else is told who can, which is the honest answer
 * to "why is this waiting" and the thing a room full of people needs to know.
 */
export function ApprovalRow({
  approval,
  viewerLogin,
  capabilities,
  controllerLogin,
  busy,
  error,
  askedIn,
  onRespond,
  onRequestControl
}: {
  approval: ApprovalRequest;
  /** The signed-in person, so a lent account's question renders its buttons
   *  to its owner and its owner alone (D-217). */
  viewerLogin: string;
  capabilities: MissionDetailResponse["capabilities"];
  controllerLogin: string | null;
  busy: boolean;
  error: string | null;
  /** The session the question came from, named only while the lane holds more
   *  than one conversation — the question blocks the lane's one workspace, so
   *  the card renders whichever session is selected, attributed (D-083). */
  askedIn?: string | null;
  onRespond: (decision: "approve" | "deny") => void;
  onRequestControl: (() => void) | null;
}) {
  // A lent account's question is its owner's alone (D-217): the baton does not
  // decide it, the lender does. Everyone else — controller included — is told
  // whose account it is, because that is the honest answer to "why can't I
  // answer this".
  const lender = approval.lender;
  const mayAnswer = lender ? lender.login === viewerLogin : capabilities.includes("approval.respond");
  return (
    <div className="approval" data-testid="approval" data-approval-id={approval.approvalId}>
      <div className="approval-ask">
        <span className="approval-tool mono" data-testid="approval-tool">
          {approval.displayName}
        </span>
        <span className="approval-summary" data-testid="approval-summary">
          {approval.summary}
        </span>
        {lender && (
          <span className="approval-lender" data-testid="approval-lender">
            {lender.login === viewerLogin
              ? `your own ${lender.service} — only you can answer`
              : `${lender.login}'s own ${lender.service} — only they can answer`}
          </span>
        )}
        {askedIn && (
          <span className="approval-asked" data-testid="approval-asked-in">
            asked in &quot;{askedIn}&quot;
          </span>
        )}
      </div>
      {mayAnswer ? (
        <div className="approval-actions">
          <button
            className="btn btn-primary"
            onClick={() => onRespond("approve")}
            disabled={busy}
            data-testid="approval-approve"
          >
            Approve once
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => onRespond("deny")}
            disabled={busy}
            data-testid="approval-deny"
          >
            Deny
          </button>
          {/* Said plainly, because "Approve" on its own reads like a policy. */}
          <span className="approval-note">This one act only — nothing is remembered.</span>
        </div>
      ) : lender ? (
        <div className="approval-actions" data-testid="approval-lender-only">
          <span className="approval-note">
            Only {lender.login} can answer — it spends their own {lender.service}, not the lane.
          </span>
        </div>
      ) : (
        <div className="approval-actions" data-testid="approval-denied-to-viewer">
          <span className="approval-note">
            {controllerLogin
              ? `${controllerLogin} holds the baton and can answer this.`
              : "Nobody holds the baton, so nobody can answer this yet."}
          </span>
          {onRequestControl && (
            <button className="btn btn-text" onClick={onRequestControl} data-testid="approval-request-control">
              Request control
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="inline-error" role="alert" data-testid="approval-error">
          {error}
        </p>
      )}
    </div>
  );
}

export function ControlEventRow({ block }: { block: ControlBlock }) {
  return (
    <div className="control-event" data-testid="control-event">
      {block.login && <HumanMark login={block.login} />}
      <span>{block.text}</span>
      <span className="trace-time">{clockTime(block.at)}</span>
    </div>
  );
}

/** The kind a document chip states beneath its name. */
function docKindOf(mime: string): string {
  if (mime === "application/pdf") return "PDF · read by the model";
  if (mime.startsWith("audio/")) return "Audio · staged for the agent";
  if (mime.startsWith("video/")) return "Video · staged for the agent";
  if (mime.startsWith("text/")) return "Text · staged for the agent";
  return "File · staged for the agent";
}

function docSizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A document or staged file as a clickable chip (D-151, D-153, D-165): named
 * with its kind and weight, and clicking opens it with the machine's own
 * default app — what clicking a file means everywhere else. A refusal takes
 * the meta line's place in its own words.
 */
function DocChip({
  attachment,
  onOpen
}: {
  attachment: DirectionAttachment;
  /** Opens on the room's own canvas — PDFs, video, audio (D-165 amended,
   *  in-app first like Codex); absent falls back to the OS default app. */
  onOpen?: () => void;
}) {
  const [note, setNote] = useState<string | null>(null);
  return (
    <button
      className="trace-attachment-doc"
      onClick={() => {
        if (onOpen) {
          onOpen();
          return;
        }
        void novus()
          .artifacts.openLocal(attachment.artifactId)
          .then((result) => setNote(result.ok ? null : result.message ?? null));
      }}
      title={`Open ${attachment.label}`}
    >
      <FileBadge mime={attachment.mimeType} size={24} />
      <span className="trace-attachment-doc-text">
        <span className="trace-attachment-doc-name">{attachment.label}</span>
        <span className="trace-attachment-doc-meta">
          {note ?? `${docKindOf(attachment.mimeType)} · ${docSizeOf(attachment.byteSize)}`}
        </span>
      </span>
    </button>
  );
}
