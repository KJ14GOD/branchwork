import { useState } from "react";
import type {
  Decision,
  HostCheck,
  MergeMethod,
  MissionDetailResponse,
  PullFilesResponse,
  PullRequest
} from "@novus/contracts";
import { DEFAULT_EFFORT, DEFAULT_MODEL } from "@novus/contracts";
import { novus } from "../bridge";
import { clockTime, plural, shortSha } from "../format";
import { Dialog } from "./dialog";
import { GatedAction } from "./gated";

/**
 * Publishing a decision, and the page that operates the pull request it
 * became (D-099, D-100). GitHub remains the source of truth; this surface is
 * the complete interface for working it: the aggregated readiness gate in
 * the Conductor shape, the diffs with inline comments, the host's review
 * threads with resolution and send-to-chat, editable metadata, and the
 * completion verbs — merge with the repository's own allowed methods, update
 * branch, close, delete branch, archive.
 *
 * The merge is never silent (D-100): the confirmation restates every named
 * blocker and proceeding accepts exactly that set, which the server records.
 * What the host itself cannot do is refused in words before anything else.
 */

const DENIAL = "Publishing this decision needs the pr.manage capability.";

type Act = () => Promise<{ ok: boolean; message?: string }>;

export function PullRequestPanel({
  detail,
  decision
}: {
  detail: MissionDetailResponse;
  decision: Decision;
}) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const missionId = detail.mission.missionId;
  // Publishing is the decision's act: every verb targets the decided lane,
  // whichever lane the reader has on screen (D-099).
  const workstreamId = decision.workstreamId;
  const lane =
    detail.workstreams.find((entry) => entry.workstreamId === decision.workstreamId) ??
    detail.workstream;
  const push = detail.branchPush;
  const pull = detail.pullRequest;

  const act = async (call: Act) => {
    setBusy(true);
    setNote(null);
    const result = await call();
    setBusy(false);
    if (!result.ok) setNote(result.message ?? "That did not work.");
    return result.ok;
  };

  const pushed = lane?.remoteHeadSha ?? null;
  const decidedServed = pushed !== null && pushed === decision.checkpointSha;

  if (!pull) {
    return (
      <section className="pull-publish" data-testid="pull-publish">
        <h3 className="field-label">Publish</h3>
        <p className="receipt-line" data-testid="push-state">
          {push?.state === "pending"
            ? "Pushing the branch to GitHub…"
            : push?.state === "failed"
              ? `The push failed: ${push.failureReason ?? "no reason was reported"}`
              : decidedServed
                ? `Branch pushed — GitHub serves the decided revision ${shortSha(decision.checkpointSha ?? "")}`
                : pushed !== null
                  ? `GitHub serves ${shortSha(pushed)}, not the decided revision — push again`
                  : "The branch has never been pushed to GitHub."}
        </p>
        <div className="inline-actions">
          <GatedAction
            capability="pr.manage"
            capabilities={detail.capabilities}
            denialReason={DENIAL}
            holderLogin={detail.control.holderLogin}
            onClick={() => void act(() => novus().pulls.push({ missionId, workstreamId }))}
            variant="secondary"
            testid="push-branch"
          >
            Push branch
          </GatedAction>
          <GatedAction
            capability="pr.manage"
            capabilities={detail.capabilities}
            denialReason={DENIAL}
            holderLogin={detail.control.holderLogin}
            onClick={() => void act(() => novus().pulls.create({ missionId, workstreamId }))}
            variant="secondary"
            disabled={busy || !decidedServed}
            disabledReason="The draft opens once GitHub serves the decided revision — push the branch first."
            testid="create-pull-request"
          >
            Create draft PR
          </GatedAction>
        </div>
        <p className="quiet">
          Novus opens only a draft, and never merges without your explicit word (D-100).
        </p>
        {note && (
          <p className="inline-error" role="alert" data-testid="pull-note">
            {note}
          </p>
        )}
      </section>
    );
  }

  const chosen = detail.approaches.find((approach) => approach.workstreamId === pull.workstreamId);
  return (
    <section className="pull-page" data-testid="pull-page">
      <PullHeadline detail={detail} pull={pull} busy={busy} onAct={act} />
      <p className="receipt-line" data-testid="pull-approach">
        Publishes <strong>{chosen?.name ?? "the chosen approach"}</strong>
        {chosen?.intent ? ` — ${chosen.intent}` : ""}
      </p>
      <p className="receipt-line mono" data-testid="pull-branches">
        {pull.headRef} → {pull.baseRef}
        {pull.headSha ? ` · ${shortSha(pull.headSha)}` : ""}
      </p>

      <ReadinessLedger detail={detail} pull={pull} decision={decision} busy={busy} onAct={act} />
      <PullChanges pull={pull} detail={detail} busy={busy} onAct={act} />
      <PullReview detail={detail} pull={pull} decision={decision} busy={busy} onAct={act} setNote={setNote} />

      {/* Visual evidence: the honest sentence until the artifact store exists. */}
      <h3 className="field-label">Screenshots and videos</h3>
      <p className="quiet" data-testid="pull-visuals">
        No visual evidence is attached — capturing and storing it is not built yet. The checks and
        the diff above are the evidence this request carries.
      </p>

      <h3 className="field-label">What was sent</h3>
      <pre className="prepared-body" data-testid="pull-body">
        {pull.body}
      </pre>

      <Completion detail={detail} pull={pull} decision={decision} busy={busy} onAct={act} missionId={missionId} />
      {note && (
        <p className="inline-error" role="alert" data-testid="pull-note">
          {note}
        </p>
      )}
    </section>
  );
}

/** The headline with its state sentence, the labels, and the title editor. */
function PullHeadline({
  detail,
  pull,
  busy,
  onAct
}: {
  detail: MissionDetailResponse;
  pull: PullRequest;
  busy: boolean;
  onAct: (call: Act) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(pull.title);
  const [labels, setLabels] = useState(pull.labels.join(", "));
  if (editing) {
    return (
      <div className="pull-edit" data-testid="pull-edit">
        <input
          className="input"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          aria-label="Pull request title"
          data-testid="pull-title-input"
        />
        <input
          className="input"
          value={labels}
          onChange={(event) => setLabels(event.target.value)}
          placeholder="labels, comma-separated"
          aria-label="Labels"
          data-testid="pull-labels-input"
        />
        <div className="inline-actions">
          <GatedAction
            capability="pr.manage"
            capabilities={detail.capabilities}
            denialReason={DENIAL}
            holderLogin={detail.control.holderLogin}
            onClick={() =>
              void onAct(async () => {
                const result = await novus().pulls.setMetadata({
                  pullRequestId: pull.pullRequestId,
                  title: title.trim(),
                  labels: labels
                    .split(",")
                    .map((label) => label.trim())
                    .filter((label) => label.length > 0)
                });
                if (result.ok) setEditing(false);
                return result;
              })
            }
            variant="secondary"
            busy={busy}
            testid="pull-edit-save"
          >
            Save
          </GatedAction>
          <button className="btn btn-text" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }
  return (
    <>
      <p className="receipt-line" data-testid="pull-headline">
        <strong>PR #{pull.number}</strong>{" "}
        {pull.state === "draft"
          ? "is a draft on GitHub"
          : pull.state === "ready"
            ? "awaits review on GitHub"
            : pull.state === "merged"
              ? `was merged${pull.mergedBy ? ` by ${pull.mergedBy}` : ""} on GitHub${
                  pull.mergedAt ? ` at ${clockTime(pull.mergedAt)}` : ""
                }`
              : "was closed on GitHub without merging"}
        {" · "}
        <a href={pull.url} target="_blank" rel="noreferrer" data-testid="pull-url">
          Open on GitHub
        </a>
        {(pull.state === "draft" || pull.state === "ready") && (
          <>
            {" · "}
            <button className="btn btn-text" onClick={() => setEditing(true)} data-testid="pull-edit-open">
              Edit
            </button>
          </>
        )}
      </p>
      <p className="receipt-line" data-testid="pull-title">
        {pull.title}
        {pull.labels.length > 0 && (
          <span className="quiet" data-testid="pull-labels">
            {" "}
            · {pull.labels.join(" · ")}
          </span>
        )}
      </p>
    </>
  );
}

function checkWord(check: HostCheck): { word: string; tone: string } {
  if (check.status === "passed") return { word: "passed", tone: "tone-ok" };
  if (check.status === "failed") return { word: "failed", tone: "tone-danger" };
  if (check.status === "skipped") return { word: "skipped", tone: "" };
  return { word: "running", tone: "" };
}

/**
 * The aggregated gate (D-100), in the evidence-ledger style: the host's
 * checks with their required flags, the review decision, conflicts, branch
 * state — and Novus's own facts beside them, because "ready to merge" is a
 * claim about both halves. Every unmet item is a named row, never a summary
 * color.
 */
function ReadinessLedger({
  detail,
  pull,
  decision,
  busy,
  onAct
}: {
  detail: MissionDetailResponse;
  pull: PullRequest;
  decision: Decision;
  busy: boolean;
  onAct: (call: Act) => Promise<boolean>;
}) {
  const readiness = pull.readiness;
  const openThreads = pull.reviewThreads.filter((thread) => thread.state === "open").length;
  const chosen = detail.approaches.find((approach) => approach.workstreamId === pull.workstreamId);
  return (
    <section className="pull-readiness" data-testid="pull-readiness">
      <h3 className="field-label">Merge readiness</h3>
      {readiness === null ? (
        <p className="quiet">GitHub has not been asked yet; the next sync fills this in.</p>
      ) : (
        <ul className="tool-list" data-testid="readiness-rows">
          {readiness.checks.map((check, index) => {
            const { word, tone } = checkWord(check);
            return (
              <li key={index}>
                <span className="mono tool-name">
                  {check.name}
                  {check.required ? " · required" : ""}
                </span>
                <span className={`tool-detail ${tone}`}>{word}</span>
              </li>
            );
          })}
          {readiness.checks.length === 0 && (
            <li>
              <span className="tool-name">No checks or deployments reported</span>
              <span className="tool-detail">the host has nothing to say yet</span>
            </li>
          )}
          <li data-testid="readiness-review">
            <span className="tool-name">Review</span>
            <span
              className={
                readiness.reviewDecision === "changes_requested" ? "tool-detail tone-warn" : "tool-detail"
              }
            >
              {readiness.reviewDecision === "approved"
                ? `approved (${readiness.approvals})`
                : readiness.reviewDecision === "changes_requested"
                  ? `${plural(readiness.changesRequested, "change request")} outstanding`
                  : "no review recorded"}
            </span>
          </li>
          <li data-testid="readiness-conflicts">
            <span className="tool-name">Conflicts</span>
            <span className={pull.mergeable === "conflict" ? "tool-detail tone-warn" : "tool-detail"}>
              {pull.mergeable === "conflict"
                ? `conflicts with ${pull.baseRef} — resolve before merging`
                : pull.mergeable === "clean"
                  ? "merges cleanly"
                  : "the host has not said yet"}
            </span>
          </li>
          <li data-testid="readiness-branch">
            <span className="tool-name">Branch</span>
            <span className={readiness.behindBy ? "tool-detail tone-warn" : "tool-detail"}>
              {readiness.behindBy
                ? `${plural(readiness.behindBy, "commit")} behind ${pull.baseRef}`
                : "up to date with its base"}
              {readiness.aheadBy ? ` · ${readiness.aheadBy} ahead` : ""}
            </span>
            {readiness.behindBy !== null &&
              readiness.behindBy > 0 &&
              (pull.state === "draft" || pull.state === "ready") && (
                <GatedAction
                  capability="pr.manage"
                  capabilities={detail.capabilities}
                  denialReason={DENIAL}
                  holderLogin={detail.control.holderLogin}
                  onClick={() => void onAct(() => novus().pulls.updateBranch(pull.pullRequestId))}
                  variant="text"
                  busy={busy}
                  testid="update-branch"
                >
                  Update branch
                </GatedAction>
              )}
          </li>
          <li data-testid="readiness-threads">
            <span className="tool-name">Comments</span>
            <span className={openThreads > 0 ? "tool-detail tone-warn" : "tool-detail"}>
              {openThreads > 0 ? `${plural(openThreads, "comment")} unresolved` : "nothing unresolved"}
            </span>
          </li>
          <li data-testid="readiness-novus">
            <span className="tool-name">Novus verification</span>
            <span className="tool-detail">
              {chosen
                ? chosen.checksRun === 0
                  ? "nothing ran against the decided revision"
                  : `${chosen.checksPassed} passed, ${chosen.checksFailed} failed, ${chosen.unresolvedChecks} unresolved`
                : "no evidence recorded"}
            </span>
          </li>
          {decision.acceptedRisks && (
            <li data-testid="readiness-risks">
              <span className="tool-name">Accepted risk</span>
              <span className="tool-detail">{decision.acceptedRisks}</span>
            </li>
          )}
        </ul>
      )}
      {readiness?.syncedAt && (
        <p className="quiet">last asked GitHub at {clockTime(readiness.syncedAt)}</p>
      )}
    </section>
  );
}

interface PatchLine {
  text: string;
  tone: "add" | "del" | "ctx" | "hunk" | "meta";
  /** The line's number in the new file — what an inline comment anchors to. */
  newLine: number | null;
}

function parsePatch(patch: string): PatchLine[] {
  const out: PatchLine[] = [];
  let newLine = 0;
  for (const text of patch.replace(/\n+$/, "").split("\n")) {
    if (text.startsWith("@@")) {
      const match = /\+(\d+)/.exec(text);
      newLine = match ? Number(match[1]) : newLine;
      out.push({ text, tone: "hunk", newLine: null });
      continue;
    }
    if (text.startsWith("+")) {
      out.push({ text, tone: "add", newLine });
      newLine += 1;
    } else if (text.startsWith("-")) {
      out.push({ text, tone: "del", newLine: null });
    } else {
      out.push({ text, tone: "ctx", newLine });
      newLine += 1;
    }
  }
  return out;
}

/** Split rows: deletions pair with the additions that replaced them. */
function splitRows(lines: PatchLine[]): { left: PatchLine | null; right: PatchLine | null }[] {
  const rows: { left: PatchLine | null; right: PatchLine | null }[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.tone === "hunk" || line.tone === "meta") {
      rows.push({ left: line, right: line });
      index += 1;
      continue;
    }
    if (line.tone === "ctx") {
      rows.push({ left: line, right: line });
      index += 1;
      continue;
    }
    const dels: PatchLine[] = [];
    while (index < lines.length && lines[index]!.tone === "del") {
      dels.push(lines[index]!);
      index += 1;
    }
    const adds: PatchLine[] = [];
    while (index < lines.length && lines[index]!.tone === "add") {
      adds.push(lines[index]!);
      index += 1;
    }
    const height = Math.max(dels.length, adds.length, dels.length === 0 && adds.length === 0 ? 1 : 0);
    for (let at = 0; at < height; at += 1) {
      rows.push({ left: dels[at] ?? null, right: adds[at] ?? null });
    }
    if (dels.length === 0 && adds.length === 0) index += 1;
  }
  return rows;
}

/**
 * The request's own commits and changed files, unified or split, fetched on
 * demand from the host — and every rendered new-file line carries the quiet
 * comment affordance, which is how an inline comment knows its anchor.
 */
function PullChanges({
  pull,
  detail,
  busy,
  onAct
}: {
  pull: PullRequest;
  detail: MissionDetailResponse;
  busy: boolean;
  onAct: (call: Act) => Promise<boolean>;
}) {
  const [loaded, setLoaded] = useState<PullFilesResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"unified" | "split">("unified");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [commenting, setCommenting] = useState<{ path: string; line: number } | null>(null);

  const show = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (loaded === null) {
      const result = await novus().pulls.files(pull.pullRequestId);
      if (result.ok) setLoaded(result.value);
    }
  };

  return (
    <section className="pull-changes" data-testid="pull-changes">
      <div className="pull-section-head">
        <h3 className="field-label">Commits and changed files</h3>
        <button className="btn btn-text" onClick={() => void show()} data-testid="pull-changes-toggle">
          {open ? "Hide" : "Show"}
        </button>
        {open && (
          <span className="file-modes" role="group" aria-label="How to show the diff">
            <button
              className={view === "unified" ? "dock-view active" : "dock-view"}
              aria-pressed={view === "unified"}
              onClick={() => setView("unified")}
              data-testid="diff-unified"
            >
              Unified
            </button>
            <button
              className={view === "split" ? "dock-view active" : "dock-view"}
              aria-pressed={view === "split"}
              onClick={() => setView("split")}
              data-testid="diff-split"
            >
              Split
            </button>
          </span>
        )}
      </div>
      {open && loaded === null && <p className="quiet">Asking GitHub…</p>}
      {open && loaded !== null && (
        <>
          <ul className="tool-list" data-testid="pull-commits">
            {loaded.commits.map((commit) => (
              <li key={commit.sha}>
                <span className="mono tool-name">{shortSha(commit.sha)}</span>
                <span className="tool-detail">
                  {commit.message} — {commit.author}
                </span>
              </li>
            ))}
          </ul>
          {loaded.files.map((file) => (
            <div key={file.path} className="pull-file" data-testid="pull-file">
              <button
                className="pull-file-row"
                onClick={() => setExpanded(expanded === file.path ? null : file.path)}
                aria-expanded={expanded === file.path}
              >
                <span className="mono">{file.path}</span>
                <span className="quiet">
                  {file.changeState} · <span className="tone-ok">+{file.additions}</span>{" "}
                  <span className="tone-danger">−{file.deletions}</span>
                </span>
              </button>
              {expanded === file.path &&
                (file.patch === null ? (
                  <p className="quiet">The host sent no text diff for this file.</p>
                ) : view === "unified" ? (
                  <div className="diff" data-testid="pull-diff-unified">
                    {parsePatch(file.patch).map((line, index) => (
                      <div key={index} className={`diff-line diff-${line.tone} pull-diff-line`}>
                        {line.newLine !== null && (
                          <button
                            className="pull-line-comment"
                            title={`Comment on line ${line.newLine}`}
                            aria-label={`Comment on ${file.path} line ${line.newLine}`}
                            onClick={() => setCommenting({ path: file.path, line: line.newLine! })}
                            data-testid="line-comment"
                          >
                            +
                          </button>
                        )}
                        <span>{line.text === "" ? " " : line.text}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="diff pull-split" data-testid="pull-diff-split">
                    {splitRows(parsePatch(file.patch)).map((row, index) => (
                      <div key={index} className="pull-split-row">
                        <div
                          className={`diff-line diff-${row.left ? (row.left.tone === "add" ? "ctx" : row.left.tone) : "ctx"}`}
                        >
                          {row.left && row.left.tone !== "add" ? row.left.text || " " : " "}
                        </div>
                        <div
                          className={`diff-line diff-${row.right ? (row.right.tone === "del" ? "ctx" : row.right.tone) : "ctx"}`}
                        >
                          {row.right && row.right.tone !== "del" ? row.right.text || " " : " "}
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
            </div>
          ))}
          {commenting && (
            <InlineCommentDialog
              detail={detail}
              pull={pull}
              anchor={commenting}
              busy={busy}
              onAct={onAct}
              onClose={() => setCommenting(null)}
            />
          )}
        </>
      )}
    </section>
  );
}

function InlineCommentDialog({
  detail,
  pull,
  anchor,
  busy,
  onAct,
  onClose
}: {
  detail: MissionDetailResponse;
  pull: PullRequest;
  anchor: { path: string; line: number };
  busy: boolean;
  onAct: (call: Act) => Promise<boolean>;
  onClose: () => void;
}) {
  const [body, setBody] = useState("");
  return (
    <Dialog label={`Comment on ${anchor.path}:${anchor.line}`} onClose={onClose}>
      <header className="dialog-head">
        <h2>Comment on the line</h2>
        <p className="dialog-sub mono">
          {anchor.path}:{anchor.line}
        </p>
      </header>
      <div className="dialog-body">
        <textarea
          className="input pull-comment-input"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Say it here; it lands on the GitHub thread."
          aria-label="Inline comment"
          data-testid="inline-comment-input"
        />
      </div>
      <footer className="dialog-actions">
        <button className="btn btn-text" onClick={onClose}>
          Cancel
        </button>
        <GatedAction
          capability="pr.manage"
          capabilities={detail.capabilities}
          denialReason={DENIAL}
          holderLogin={detail.control.holderLogin}
          onClick={() =>
            void onAct(async () => {
              const result = await novus().pulls.comment({
                pullRequestId: pull.pullRequestId,
                body: body.trim(),
                path: anchor.path,
                line: anchor.line
              });
              if (result.ok) onClose();
              return result;
            })
          }
          variant="secondary"
          disabled={busy || body.trim().length === 0}
          disabledReason="Say something first."
          testid="inline-comment-send"
        >
          Comment
        </GatedAction>
      </footer>
    </Dialog>
  );
}

/**
 * Review, operated in-house: who was asked, the host's threads with Resolve
 * and Send to chat, the conversation comment, and the stewarding verbs.
 * Sending to chat turns a comment into a prefilled direction for the decided
 * lane's conversation — Conductor's send-feedback-to-agent (D-100).
 */
function PullReview({
  detail,
  pull,
  decision,
  busy,
  onAct,
  setNote
}: {
  detail: MissionDetailResponse;
  pull: PullRequest;
  decision: Decision;
  busy: boolean;
  onAct: (call: Act) => Promise<boolean>;
  setNote: (note: string | null) => void;
}) {
  const [reviewers, setReviewers] = useState("");
  const [comment, setComment] = useState("");
  const names = reviewers
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const openState = pull.state === "draft" || pull.state === "ready";
  const openThreads = pull.reviewThreads.filter((thread) => thread.state === "open");

  const sendToChat = (thread: PullRequest["reviewThreads"][number]) =>
    void onAct(async () => {
      const quoted = thread.body.length > 400 ? `${thread.body.slice(0, 399)}…` : thread.body;
      const result = await novus().missions.direct({
        missionId: detail.mission.missionId,
        workstreamId: decision.workstreamId,
        body: `Address this review comment from ${thread.author}${thread.path ? ` on ${thread.path}` : ""}: "${quoted}"`,
        model: DEFAULT_MODEL,
        effort: DEFAULT_EFFORT
      });
      if (result.ok) {
        setNote(
          result.value.dispatched
            ? "Sent — the chat is on it."
            : (result.value.deferred ?? "Queued for the chat.")
        );
      }
      return result;
    });

  return (
    <section className="pull-review" data-testid="pull-review">
      <h3 className="field-label">Review</h3>
      <p className="receipt-line" data-testid="pull-reviewers">
        {pull.requestedReviewers.length === 0
          ? "Nobody has been asked for review yet."
          : `Review requested from ${pull.requestedReviewers.join(", ")}.`}
        {openThreads.length > 0 ? ` ${plural(openThreads.length, "comment")} open.` : ""}
      </p>
      {pull.reviewThreads.length > 0 && (
        <ul className="tool-list" data-testid="pull-threads">
          {pull.reviewThreads.map((thread, index) => (
            <li key={thread.threadId ?? index}>
              <span className="tool-name">
                {thread.author}
                {thread.path ? (
                  <>
                    {" "}
                    · <span className="mono">{thread.path}</span>
                    {thread.line !== null ? <span className="mono">:{thread.line}</span> : null}
                  </>
                ) : null}
                {" · "}
                {thread.state === "open" ? "open" : "resolved"}
              </span>
              <span className="tool-detail">{thread.body}</span>
              {openState && thread.state === "open" && (
                <span className="inline-actions">
                  {thread.threadId && (
                    <GatedAction
                      capability="pr.manage"
                      capabilities={detail.capabilities}
                      denialReason={DENIAL}
                      holderLogin={detail.control.holderLogin}
                      onClick={() =>
                        void onAct(() =>
                          novus().pulls.resolveThread({
                            pullRequestId: pull.pullRequestId,
                            threadId: thread.threadId!
                          })
                        )
                      }
                      variant="text"
                      busy={busy}
                      testid="resolve-thread"
                    >
                      Resolve
                    </GatedAction>
                  )}
                  <button
                    className="btn btn-text"
                    onClick={() => sendToChat(thread)}
                    data-testid="send-to-chat"
                  >
                    Send to chat
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {openState && (
        <div className="pull-review-controls">
          <div className="inline-actions">
            <input
              className="input"
              value={reviewers}
              onChange={(event) => setReviewers(event.target.value)}
              placeholder="GitHub logins, comma-separated"
              aria-label="Reviewers to request"
              data-testid="reviewer-input"
            />
            <GatedAction
              capability="pr.manage"
              capabilities={detail.capabilities}
              denialReason={DENIAL}
              holderLogin={detail.control.holderLogin}
              onClick={() =>
                void onAct(async () => {
                  const result = await novus().pulls.requestReview({
                    pullRequestId: pull.pullRequestId,
                    reviewers: names
                  });
                  if (result.ok) setReviewers("");
                  return result;
                })
              }
              variant="secondary"
              disabled={busy || names.length === 0}
              disabledReason="Name at least one reviewer."
              testid="request-review"
            >
              Request review
            </GatedAction>
          </div>
          <div className="inline-actions">
            <input
              className="input"
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder="Comment on the conversation…"
              aria-label="Conversation comment"
              data-testid="pull-comment-input"
            />
            <GatedAction
              capability="pr.manage"
              capabilities={detail.capabilities}
              denialReason={DENIAL}
              holderLogin={detail.control.holderLogin}
              onClick={() =>
                void onAct(async () => {
                  const result = await novus().pulls.comment({
                    pullRequestId: pull.pullRequestId,
                    body: comment.trim()
                  });
                  if (result.ok) setComment("");
                  return result;
                })
              }
              variant="secondary"
              disabled={busy || comment.trim().length === 0}
              disabledReason="Say something first."
              testid="pull-comment-send"
            >
              Comment
            </GatedAction>
          </div>
        </div>
      )}
    </section>
  );
}

/** The named blockers a merge would accept, computed for the confirmation
 *  from the same facts the server judges — the server recomputes and is the
 *  authority; this only makes the confirm honest before the click. */
export function namedBlockers(pull: PullRequest): string[] {
  const readiness = pull.readiness;
  if (readiness === null) return [];
  const blockers: string[] = [];
  if (readiness.changesRequested > 0) {
    blockers.push(`${plural(readiness.changesRequested, "change request")} outstanding`);
  }
  const openThreads = pull.reviewThreads.filter((thread) => thread.state === "open").length;
  if (openThreads > 0) blockers.push(`${plural(openThreads, "review comment")} unresolved`);
  for (const check of readiness.checks.filter((entry) => !entry.required && entry.status === "failed").slice(0, 5)) {
    blockers.push(`check ${check.name} failing`);
  }
  const pending = readiness.checks.filter((entry) => entry.status === "pending").length;
  if (pending > 0) blockers.push(`${plural(pending, "check")} still running`);
  if (readiness.behindBy !== null && readiness.behindBy > 0) {
    blockers.push(`the branch is ${plural(readiness.behindBy, "commit")} behind its base`);
  }
  return blockers;
}

/**
 * Completion (D-100): the explicit acts, state-dependent, GitHub performing
 * each underneath. The merge confirm restates every named blocker; the host's
 * own refusals (draft, conflict, failing required check) disable the control
 * with the reason instead of offering a click that can only fail.
 */
function Completion({
  detail,
  pull,
  decision,
  busy,
  onAct,
  missionId
}: {
  detail: MissionDetailResponse;
  pull: PullRequest;
  decision: Decision;
  busy: boolean;
  onAct: (call: Act) => Promise<boolean>;
  missionId: string;
}) {
  void decision;
  const [confirming, setConfirming] = useState<"merge" | "close" | "delete" | null>(null);
  const [method, setMethod] = useState<MergeMethod | null>(null);
  const methods = pull.readiness?.allowedMergeMethods ?? [];
  const blockers = namedBlockers(pull);
  const hostRefuses =
    pull.mergeable === "conflict"
      ? `conflicts with ${pull.baseRef} must be resolved first`
      : pull.readiness?.checks.some((check) => check.required && check.status === "failed")
        ? "a required check is failing"
        : null;

  return (
    <section className="pull-completion" data-testid="pull-completion">
      <h3 className="field-label">Completion</h3>
      {pull.state === "draft" && (
        <div className="inline-actions">
          <GatedAction
            capability="pr.manage"
            capabilities={detail.capabilities}
            denialReason={DENIAL}
            holderLogin={detail.control.holderLogin}
            onClick={() => void onAct(() => novus().pulls.markReady(pull.pullRequestId))}
            variant="secondary"
            busy={busy}
            testid="mark-ready"
          >
            Mark ready for review
          </GatedAction>
          <GatedAction
            capability="pr.manage"
            capabilities={detail.capabilities}
            denialReason={DENIAL}
            holderLogin={detail.control.holderLogin}
            onClick={() => setConfirming("close")}
            variant="text"
            busy={busy}
            testid="close-pull"
          >
            Close without merging
          </GatedAction>
        </div>
      )}
      {pull.state === "ready" && (
        <div className="inline-actions">
          <GatedAction
            capability="pr.manage"
            capabilities={detail.capabilities}
            denialReason={DENIAL}
            holderLogin={detail.control.holderLogin}
            onClick={() => {
              setMethod(methods[0] ?? "merge");
              setConfirming("merge");
            }}
            variant="primary"
            disabled={busy || hostRefuses !== null}
            disabledReason={hostRefuses ? `GitHub refuses this merge: ${hostRefuses}.` : undefined}
            testid="merge-open"
          >
            Merge…
          </GatedAction>
          <GatedAction
            capability="pr.manage"
            capabilities={detail.capabilities}
            denialReason={DENIAL}
            holderLogin={detail.control.holderLogin}
            onClick={() => setConfirming("close")}
            variant="text"
            busy={busy}
            testid="close-pull"
          >
            Close without merging
          </GatedAction>
        </div>
      )}
      {(pull.state === "merged" || pull.state === "closed") && (
        <div className="inline-actions">
          <GatedAction
            capability="pr.manage"
            capabilities={detail.capabilities}
            denialReason={DENIAL}
            holderLogin={detail.control.holderLogin}
            onClick={() => setConfirming("delete")}
            variant="secondary"
            busy={busy}
            testid="delete-branch"
          >
            Delete remote branch
          </GatedAction>
          {pull.state === "merged" && detail.capabilities.includes("mission.archive") && (
            <button
              className="btn btn-text"
              onClick={() => void onAct(() => novus().missions.archive(missionId))}
              data-testid="archive-after-merge"
            >
              Archive this mission
            </button>
          )}
        </div>
      )}
      <p className="quiet" data-testid="pull-no-silent-merge">
        Every completion act here is yours, explicitly — GitHub performs it, Novus records who asked,
        and nothing ever merges silently (D-100).
      </p>

      {confirming === "merge" && (
        <Dialog label={`Merge PR #${pull.number}`} onClose={() => setConfirming(null)}>
          {/* The dialog's own axis (D-076): one head naming the act with its
              consequence beneath, the choice and the accepted facts as the
              body, the two actions at the foot. A confirmation is a quiet
              room, not a form. */}
          <header className="dialog-head">
            <h2>Merge PR #{pull.number}</h2>
            <p className="dialog-sub">
              GitHub performs the merge into <span className="mono">{pull.baseRef}</span>. This is
              not undoable from Novus.
            </p>
          </header>
          <div className="dialog-body">
            <div className="confirm-field">
              <span className="field-label">Method</span>
              <div className="segment" role="radiogroup" aria-label="Merge method">
                {methods.map((candidate) => (
                  <button
                    key={candidate}
                    role="radio"
                    aria-checked={method === candidate}
                    className={method === candidate ? "segment-tab active" : "segment-tab"}
                    onClick={() => setMethod(candidate)}
                    data-testid={`method-${candidate}`}
                  >
                    {candidate}
                  </button>
                ))}
              </div>
            </div>
            {blockers.length > 0 && (
              <div className="confirm-field" data-testid="merge-blockers">
                <span className="field-label tone-warn">Merged over deliberately, if you proceed</span>
                <ul className="confirm-facts">
                  {blockers.map((blocker, index) => (
                    <li key={index}>{blocker}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <footer className="dialog-actions">
            <button className="btn btn-text" onClick={() => setConfirming(null)}>
              Cancel
            </button>
            <button
              className="btn btn-danger"
              disabled={busy || method === null}
              onClick={() =>
                void onAct(async () => {
                  const result = await novus().pulls.merge({
                    pullRequestId: pull.pullRequestId,
                    method: method ?? "merge",
                    acknowledgeBlockers: blockers.length > 0
                  });
                  if (result.ok) setConfirming(null);
                  return result;
                })
              }
              data-testid="merge-confirm"
            >
              {blockers.length > 0 ? "Merge, accepting the above" : "Merge"}
            </button>
          </footer>
        </Dialog>
      )}
      {confirming === "close" && (
        <Dialog label={`Close PR #${pull.number}`} onClose={() => setConfirming(null)}>
          <header className="dialog-head">
            <h2>Close PR #{pull.number}</h2>
            <p className="dialog-sub">
              The request closes on GitHub without merging. The branch and the mission stay exactly
              as they are.
            </p>
          </header>
          <footer className="dialog-actions">
            <button className="btn btn-text" onClick={() => setConfirming(null)}>
              Cancel
            </button>
            <button
              className="btn btn-danger"
              disabled={busy}
              onClick={() =>
                void onAct(async () => {
                  const result = await novus().pulls.close(pull.pullRequestId);
                  if (result.ok) setConfirming(null);
                  return result;
                })
              }
              data-testid="close-confirm"
            >
              Close without merging
            </button>
          </footer>
        </Dialog>
      )}
      {confirming === "delete" && (
        <Dialog label={`Delete ${pull.headRef}`} onClose={() => setConfirming(null)}>
          <header className="dialog-head">
            <h2>Delete the remote branch</h2>
            <p className="dialog-sub">
              Deletes <span className="mono">{pull.headRef}</span> on GitHub. The mission branch in
              this machine's checkout is not touched, and nothing about the merged history changes.
            </p>
          </header>
          <footer className="dialog-actions">
            <button className="btn btn-text" onClick={() => setConfirming(null)}>
              Cancel
            </button>
            <button
              className="btn btn-danger"
              disabled={busy}
              onClick={() =>
                void onAct(async () => {
                  const result = await novus().pulls.deleteBranch(pull.pullRequestId);
                  if (result.ok) setConfirming(null);
                  return result;
                })
              }
              data-testid="delete-branch-confirm"
            >
              Delete remote branch
            </button>
          </footer>
        </Dialog>
      )}
    </section>
  );
}
