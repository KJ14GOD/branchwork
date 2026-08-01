import { useEffect, useMemo, useRef, useState } from "react";

import type { SessionEvent } from "@novus/contracts";
import type { AttemptComparison, SessionSummary } from "@novus/contracts/protocol";
import { formatSpend } from "@novus/ui";

import { bridge } from "./bridge.ts";
import {
  approachKey,
  decideDecisionRoom,
  missionLayout,
  openDecisionRoom,
  type ViewMode,
} from "./decision-room.ts";
import { FileTree, FileViewer } from "./components/browse-panel.tsx";
import { CommandOverlay, type Command } from "./components/command-overlay.tsx";
import { CompareScreen } from "./components/compare-screen.tsx";
import { DecisionSpine } from "./components/decision-spine.tsx";
import { Composer } from "./components/composer.tsx";
import {
  ControlPanel,
  MissionAuthority,
  PendingDirection,
} from "./components/control-panel.tsx";
import { FileChangesPanel } from "./components/file-changes-panel.tsx";
import { appliedDiffsByPath } from "./applied-diffs.ts";
import { InvitePanel } from "./components/invite-panel.tsx";
import { TerminalPanel } from "./components/terminal-panel.tsx";
import { groupKeyFor, TimelineView } from "./components/timeline-view.tsx";
import { useComparison } from "./use-comparison.ts";
import { missionPhases } from "./mission-phase.ts";
import { useFileChanges } from "./use-file-changes.ts";
import { useAuthority } from "./use-authority.ts";
import { useGithub } from "./use-github.ts";
import { useSessionUsage } from "./use-session-usage.ts";
import { useFileTree } from "./use-file-tree.ts";
import { usePresence } from "./use-presence.ts";
import { useSessionActions } from "./use-session-actions.ts";
import { useSessionEvents } from "./use-session-events.ts";
import type { Theme } from "./use-theme.ts";
import { useTurnModel } from "./use-turn-model.ts";

type Filter = "all" | "tools" | "patches";

const MIN_TERMINAL_HEIGHT = 140;
const MAX_TERMINAL_HEIGHT = 640;
const DEFAULT_TERMINAL_HEIGHT = 280;

/** What the tab strip in `App` needs to know about a tab it is not rendering. */
export type TabStatus = {
  runStatus: string;
  additions: number;
  deletions: number;
};

// All three proposal tools. Kept deliberately in step with the guest's own
// copy in apps/guest/src/timeline.ts — the two clients each keep their own
// predicate, and when only the guest learned about creations and deletions
// the host's patch filter, patch count, and "jump to latest patch" all
// silently disagreed with what a teammate was looking at.
const isPatchEvent = (
  event: SessionEvent,
): event is Extract<SessionEvent, { type: "tool.completed" }> =>
  event.type === "tool.completed" &&
  (event.payload.result.name === "propose_patch" ||
    event.payload.result.name === "propose_new_file" ||
    event.payload.result.name === "propose_deletion");

const isAppliedPatchEvent = (event: SessionEvent): boolean =>
  event.type === "tool.completed" && event.payload.result.name === "apply_patch";

const formatElapsed = (events: SessionEvent[]): string => {
  const first = events.at(0);
  const last = events.at(-1);

  if (!first || !last) {
    return "—";
  }

  const ms =
    new Date(last.occurredAt).getTime() - new Date(first.occurredAt).getTime();

  if (ms < 1000) {
    return `${ms}ms`;
  }

  return `${(ms / 1000).toFixed(1)}s`;
};

/**
 * Sentence case for a machine-shaped word.
 *
 * Every status, phase and stream state this app shows arrives lowercase
 * because that is how it is spelled in the contract. Rendering the contract's
 * spelling verbatim is what made the chrome read as affected — see the "tone"
 * section of novus-ui/SKILL.md. The contract keeps its spelling; the screen
 * gets a capital letter.
 */
const sentenceCase = (value: string): string =>
  value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);

/** The last path segment, which is the part a person calls the repository. */
const basename = (path: string): string =>
  path.split("/").filter(Boolean).at(-1) ?? path;

/** Everything before that, shown quieter and dropped first when space is tight. */
const dirname = (path: string): string => {
  const cut = path.lastIndexOf("/");

  return cut <= 0 ? "" : path.slice(0, cut);
};

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("") || "?";

/**
 * One attempt, in the rail.
 *
 * Deliberately not a link to anything new: it opens the compare screen, which
 * is where a decision is actually made from. This exists so a session with
 * live forks *reads as one at a glance*, which was the gap — the evidence
 * still lives in one place.
 */
const AttemptRow = ({
  attempt,
  chosen,
  onOpen,
}: {
  attempt: AttemptComparison;
  chosen: boolean;
  onOpen: () => void;
}) => {
  const dot = chosen
    ? "attempt__dot attempt__dot--chosen"
    : attempt.status === "running"
      ? "attempt__dot attempt__dot--running"
      : attempt.status === "failed"
        ? "attempt__dot attempt__dot--failed"
        : "attempt__dot";

  return (
    <button
      className="attempt"
      type="button"
      onClick={onOpen}
      title={`${attempt.label} — ${attempt.status}`}
    >
      <span className="attempt__head">
        <span className={dot} />
        <span className="attempt__label">{attempt.label}</span>
      </span>
      <span className="attempt__stats">
        <span>
          <span className="stat__add">+{attempt.additions}</span>{" "}
          <span className="stat__del">−{attempt.deletions}</span>
        </span>
        <span>
          {attempt.filesChanged.length} file
          {attempt.filesChanged.length === 1 ? "" : "s"}
        </span>
        {attempt.testsRun === 0 ? (
          <span>No tests</span>
        ) : attempt.green === true ? (
          <span className="attempt__stat--pass">Tests pass</span>
        ) : (
          <span className="attempt__stat--fail">
            {attempt.testsPassed}/{attempt.testsRun} pass
          </span>
        )}
      </span>
    </button>
  );
};

/**
 * One open session, rendered in full.
 *
 * Instantiated once per open tab — every tab mounts one of these and keeps it
 * mounted (hidden with `display: none`, never unmounted) while another tab is
 * active, so a background tab's event stream, presence poll, and terminal keep
 * running rather than being torn down and rebuilt on every switch. `session`
 * is fixed for the component's whole life: it is the summary the tab was
 * opened with, not state this component manages.
 */
export const SessionTab = ({
  session,
  endpoint,
  active,
  theme,
  onStatus,
  onCloseTab,
}: {
  session: SessionSummary;
  endpoint: string;
  active: boolean;
  theme: Theme;
  /** Reports this tab's live status upward, for the tab strip's own chip. */
  onStatus: (status: TabStatus) => void;
  onCloseTab: () => void;
}) => {
  const {
    error: actionError,
    ask,
    invite,
    direct,
    cancel,
    pause,
    resume,
    handoff,
    requestControl,
    answerHandoff,
  } = useSessionActions(endpoint, session);
  const host = bridge();
  const [mode, setMode] = useState<ViewMode>("timeline");
  const [inviting, setInviting] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(DEFAULT_TERMINAL_HEIGHT);
  const comparison = useComparison(endpoint, session.id);
  const presence = usePresence(endpoint, session.id);
  const authority = useAuthority(endpoint, session.id);
  const github = useGithub(endpoint, session.id);
  const { events, status, reconnect } = useSessionEvents(endpoint, session.id);
  // Recomputed only when the log or the comparison moves, not on every
  // keystroke in the composer — this sits above a list that can run to
  // thousands of events.
  const phases = useMemo(
    () => missionPhases(events, comparison.comparison),
    [events, comparison.comparison],
  );
  /**
   * What the evidence panel can honestly claim, from the comparison.
   *
   * Null until there is something to say — a session that has run nothing has
   * no verification state, and drawing an empty block for it is the
   * placeholder row this app has already been told to stop showing.
   */
  /**
   * Opens the Decision Room when a decision is what the mission is waiting on.
   *
   * The rules — once per arrival, browse is never interrupted, a later
   * decision opens it again — live in `decision-room.ts` as pure functions,
   * with the tests that hold them. This is only the wiring: read the state,
   * remember what it answered, move the view.
   */
  const answeredDecision = useRef<string | null>(null);
  const decisionPhase = phases.find((phase) => phase.key === "decision");
  const needsDecision = decisionPhase?.status === "needs-attention";

  useEffect(() => {
    const outcome = decideDecisionRoom({
      needsDecision,
      approaches: approachKey(comparison.comparison?.attempts ?? []),
      answered: answeredDecision.current,
    });

    // Written outside the state updater below, which React may call twice.
    answeredDecision.current = outcome.answered;

    if (outcome.open) {
      setMode(openDecisionRoom);
    }
  }, [needsDecision, comparison.comparison]);

  const evidenceVerdict = useMemo(() => {
    const attempts = comparison.comparison?.attempts ?? [];

    if (attempts.length === 0) {
      return null;
    }

    const testsRun = attempts.reduce((total, attempt) => total + attempt.testsRun, 0);
    const testsPassed = attempts.reduce(
      (total, attempt) => total + attempt.testsPassed,
      0,
    );

    return {
      // Null when nothing ran anywhere. Not false, which would read as
      // failing, and emphatically not true.
      tests: testsRun === 0 ? null : testsPassed === testsRun,
      testsRun,
      testsPassed,
      approaches: attempts.length,
      contested: comparison.comparison?.contestedPaths ?? [],
    };
  }, [comparison.comparison]);
  const fileTree = useFileTree(mode === "browse" ? session.repositoryPath : null);
  const turnModel = useTurnModel();
  const [filter, setFilter] = useState<Filter>("all");
  const [raw, setRaw] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [highlighted, setHighlighted] = useState<number | null>(null);
  // Which tool groups a person has explicitly opened or closed, keyed by the
  // group's first event's sequence — see timeline-view.tsx for why a group
  // needs this rather than owning its own open/closed state locally.
  const [groupOverrides, setGroupOverrides] = useState<Map<number, boolean>>(new Map());

  // Refetched only when another patch actually applied — not polled blind.
  const appliedPatchCount = useMemo(
    () => events.filter(isAppliedPatchEvent).length,
    [events],
  );
  // Paired from the timeline this tab already holds, so opening a diff in
  // the panel costs no request. Keyed on the applied-patch count rather
  // than on every event, so an unrelated progress line does not re-pair.
  const appliedDiffs = useMemo(
    () => appliedDiffsByPath(events),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [appliedPatchCount, events.length],
  );

  const fileChanges = useFileChanges(endpoint, session.id, appliedPatchCount);
  // A receipt is the only event that can change what this session has spent,
  // so counting them is the whole refetch trigger — no timer, same rule the
  // changed-files panel follows with applied patches.
  const receiptCount = events.filter(
    (event) => event.type === "receipt.created",
  ).length;
  const usage = useSessionUsage(endpoint, session.id, receiptCount);

  const run = events.find((event) => event.type === "run.started");
  /** What this mission is about — the first run's goal, and the header's title. */
  const missionGoal =
    run?.type === "run.started" ? run.payload.run.goal : null;
  const completed = events.findLast((event) => event.type === "run.completed");
  const failed = events.findLast((event) => event.type === "run.failed");
  const cancelled = events.findLast((event) => event.type === "run.cancelled");

  const toolCalls = useMemo(
    () => events.filter((event) => event.type === "tool.requested"),
    [events],
  );
  const patches = useMemo(() => events.filter(isPatchEvent), [events]);

  const visible = useMemo(() => {
    if (filter === "tools") {
      return events.filter(
        (event) =>
          event.type === "tool.requested" || event.type === "tool.completed",
      );
    }

    if (filter === "patches") {
      return events.filter(isPatchEvent);
    }

    return events;
  }, [events, filter]);

  // True only for the moment nothing has actually happened yet — a fresh
  // session's log is never literally empty (session.created is appended the
  // instant it opens), so "no events at all" would never fire and the
  // timeline would show that one row forever: a lone sequence-0 session.created
  // card, which is exactly the bare "0 ◇" glyph this replaces with an actual
  // empty state. Once a run starts, session.created renders normally as part
  // of the real history.
  const trulyEmpty =
    filter === "all"
      ? events.length === 0 ||
        (events.length === 1 && events[0]?.type === "session.created")
      : visible.length === 0;

  const attempts = comparison.comparison?.attempts ?? [];
  // Which surfaces this view shows. Read from one function rather than from
  // three separate `mode === …` checks in the markup, so that the Decision
  // Room keeping the composer and the evidence panel is a rule with a test
  // rather than an accident of where the JSX brackets happen to sit.
  const layout = missionLayout(mode);

  const jumpTo = (sequence: number) => {
    setHighlighted(sequence);

    // Grouping is only ever rendered for the unfiltered timeline (see the
    // TimelineView call below), and only ever over `visible`, not the raw
    // event list — a key computed from `events` would be a key from a
    // grouping that was never actually rendered, and the override below
    // would set state for a group with no matching DOM node to expand.
    const key = filter === "all" ? groupKeyFor(visible, sequence) : null;

    if (key !== null) {
      setGroupOverrides((current) =>
        current.get(key) === true ? current : new Map(current).set(key, true),
      );
    }

    // Deferred one frame: if the target was inside a group that just opened
    // above, its row does not exist in the DOM until that render lands.
    requestAnimationFrame(() => {
      document
        .getElementById(`event-${sequence}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  const toggleGroup = (key: number, currentlyOpen: boolean) => {
    setGroupOverrides((current) => new Map(current).set(key, !currentlyOpen));
  };

  const commands: Command[] = [
    {
      id: "filter-all",
      label: "Show all events",
      hint: `${events.length}`,
      run: () => setFilter("all"),
    },
    {
      id: "filter-tools",
      label: "Show tool activity only",
      hint: `${toolCalls.length}`,
      run: () => setFilter("tools"),
    },
    {
      id: "filter-patches",
      label: "Show proposed patches only",
      hint: `${patches.length}`,
      run: () => setFilter("patches"),
    },
    {
      id: "attempts",
      label: "Compare approaches",
      hint: `${attempts.length}`,
      run: () => setMode("compare"),
    },
    // The utilities that used to sit in the session bar. Still here, still
    // one keystroke away — just not competing with the decision for space.
    ...(host
      ? [
          {
            id: "browse",
            label: "Browse the repository",
            run: () => setMode("browse"),
          },
          {
            id: "terminal",
            label: terminalOpen ? "Hide the terminal" : "Open a terminal",
            hint: "your shell, not the agent's",
            run: () => setTerminalOpen((value) => !value),
          },
        ]
      : []),
    {
      id: "invite",
      label: "Invite a teammate",
      run: () => setInviting(true),
    },
    {
      id: "raw",
      label: raw ? "Hide raw event payloads" : "Show raw event payloads",
      run: () => setRaw((value) => !value),
    },
    {
      id: "reconnect",
      label: "Reconnect event stream",
      hint: sentenceCase(status),
      run: reconnect,
    },
  ];

  const latestPatch = patches.at(-1);

  if (latestPatch) {
    const { output } = latestPatch.payload.result as Extract<
      SessionEvent,
      { type: "tool.completed" }
    >["payload"]["result"] & { name: "propose_patch" };

    commands.push(
      {
        id: "jump-patch",
        label: `Jump to latest patch · ${output.path}`,
        run: () => jumpTo(latestPatch.sequence),
      },
      {
        id: "copy-patch",
        label: "Copy latest patch diff",
        run: () => {
          void navigator.clipboard.writeText(output.diff);
        },
      },
    );
  }

  // The "/" shortcut only ever belongs to the tab you are looking at — a
  // background tab must not steal it, or intercept it a second time once two
  // tabs are both listening.
  useEffect(() => {
    if (!active) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA";

      if (event.key === "/" && !typing) {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };

    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [active]);

  // A run is in flight when the newest run.started has no matching terminator.
  const lastStarted = events.findLast((event) => event.type === "run.started");
  const lastEnded = events.findLast(
    (event) =>
      event.type === "run.completed" ||
      event.type === "run.failed" ||
      event.type === "run.cancelled",
  );
  const busy = Boolean(
    lastStarted && (!lastEnded || lastEnded.sequence < lastStarted.sequence),
  );
  // A cancel that was requested but has not yet stopped the run still reads
  // as busy — the host asked, the run has not reached its next turn boundary
  // to honour it yet.
  const cancelling =
    busy &&
    events
      .filter((event) => event.type === "run.cancel_requested")
      .some(
        (event) =>
          lastStarted && event.sequence > lastStarted.sequence,
      );
  // Only the most recent of the three pause-related events for this run
  // decides — a run can be paused and resumed more than once, so "some event
  // exists" is not enough, the same rule AgentRunner.pauseRequested applies.
  const latestPauseEvent = events
    .filter(
      (event) =>
        (event.type === "run.pause_requested" ||
          event.type === "run.paused" ||
          event.type === "run.resumed") &&
        lastStarted &&
        event.sequence > lastStarted.sequence,
    )
    .at(-1);
  const pausing = busy && latestPauseEvent?.type === "run.pause_requested";
  const paused = busy && latestPauseEvent?.type === "run.paused";
  const runStatus = cancelling
    ? "cancelling"
    : pausing
      ? "pausing"
      : paused
        ? "paused"
        : busy
          ? "working"
          : cancelled
            ? "cancelled"
            : failed
              ? "failed"
              : completed
                // STEERING is explicit that "Idle" is not a product state: it
                // describes a process and answers none of the three questions
                // a state has to — what is happening, does anyone need to act,
                // what is next. A finished run is waiting on a person, and the
                // decision spine beside this says which person and for what.
                ? "waiting on you"
                : run
                  ? "running"
                  : "ready";

  // Reports up to the tab strip. Deliberately keyed on the computed values,
  // not on `onStatus`'s identity — that is a fresh closure every render of
  // `App`'s tab map, and depending on it would refire this for every tab on
  // every keystroke anywhere in the app.
  useEffect(() => {
    onStatus({
      runStatus,
      additions: fileChanges.additions,
      deletions: fileChanges.deletions,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runStatus, fileChanges.additions, fileChanges.deletions]);

  const startTerminalResize = (event: React.MouseEvent) => {
    event.preventDefault();

    const startY = event.clientY;
    const startHeight = terminalHeight;

    const onMove = (moveEvent: MouseEvent) => {
      const delta = startY - moveEvent.clientY;

      setTerminalHeight(
        Math.min(MAX_TERMINAL_HEIGHT, Math.max(MIN_TERMINAL_HEIGHT, startHeight + delta)),
      );
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const viewOption = (target: ViewMode, label: string, count?: number) => (
    <button
      className={`viewswitch__option${mode === target ? " viewswitch__option--active" : ""}`}
      type="button"
      aria-pressed={mode === target}
      onClick={() => setMode(target)}
    >
      {label}
      {count !== undefined && count > 0 ? (
        <span className="viewswitch__count">{count}</span>
      ) : null}
    </button>
  );

  return (
    <div className="tab-content" style={{ display: active ? "grid" : "none" }}>
      <div className="session-bar">
        {/*
          The mission leads. This bar used to open with a filesystem path and
          three permission chips, so the strongest thing on screen was where
          the work lives rather than what it is — and five missions in one
          repository opened identically.
        */}
        <div className="session-bar__identity">
          <span className="mission-title" title={missionGoal ?? undefined}>
            {missionGoal ?? "Nothing asked yet"}
          </span>
          <button
            className="session-bar__repo"
            type="button"
            onClick={onCloseTab}
            title={`${session.repositoryPath} — click to close this tab`}
          >
            <span className="session-bar__repo-name">
              {basename(session.repositoryPath)}
            </span>
          </button>
          {session.repositoryState !== "ready" ? (
            // Said at the top of the window, while there is still time to act
            // on it. This used to surface as a failure when you pressed Fork,
            // which is after the work rather than before it.
            <span
              className="chip chip--warn"
              title="Forking and diffs need a commit to work from"
            >
              {session.repositoryState === "absent"
                ? "Not a Git repo"
                : "No commits yet"}
            </span>
          ) : null}
        </div>

        <span className="titlebar__spacer" />

        <div className="session-bar__state">
          <span
            className={`status status--${status === "live" ? "live" : status === "error" ? "error" : "idle"}`}
            title={`Event stream: ${status}`}
          >
            <span className="status__dot" />
            {sentenceCase(runStatus)}
          </span>
          {run?.type === "run.started" ? (
            <span className="session-bar__model">
              {run.payload.run.model.model}
            </span>
          ) : null}
          {/* One component. Control identity used to appear twice here — a
              pill saying who held it and a separate row of faces that did
              not say which face that was. */}
          <MissionAuthority
            authority={authority}
            participants={presence.participants}
          />
        </div>

        <div className="session-bar__actions">
          <div className="viewswitch" role="group" aria-label="View">
            {/* Decision first: it is the product, and it is what the mission is
                usually waiting on. Activity is the record you consult. */}
            {viewOption("compare", "Approaches", attempts.length)}
            {viewOption("timeline", "Activity")}
          </div>
          {/*
            Terminal and Invite moved into the command palette. Neither is part
            of deciding, and a bar that offers five ways to leave the decision
            and two ways to use it is not a decision surface. They are one
            keystroke away and nothing was removed.
          */}
          <span className="kbd-hint">
            <kbd>/</kbd> Commands
          </span>
        </div>
      </div>

      <div
        // Compare no longer needs a grid of its own: it is a canvas inside the
        // same three columns as everything else.
        className={layout.tree ? "body body--browse" : "body"}
      >
        <aside className="rail">
          <div className="rail__scroll">
          {/*
            Where the mission stands, before anything that counts what has
            happened. The rail led with a goal and then a pile of totals, which
            answers "what has this done" and never "where is this and what is
            it waiting for" — and the second is the question somebody opening a
            tab actually has.
          */}
          <div className="rail__section">
            <div className="eyebrow">Mission</div>
            <DecisionSpine
              phases={phases}
              onOpenApproaches={() => setMode("compare")}
            />
          </div>

          {busy && lastStarted?.type === "run.started" ? (
            <div className="rail__section rail__section--live">
              <div className="eyebrow">Run control</div>
                <div className="rail__buttons">
                <button
                  className="button"
                  type="button"
                  disabled={pausing}
                  onClick={() => {
                    if (lastStarted.type === "run.started") {
                      if (paused) {
                        void resume(lastStarted.payload.run.id);
                      } else {
                        void pause(lastStarted.payload.run.id);
                      }
                    }
                  }}
                  title={
                    paused
                      ? "Continue this run where it left off"
                      : "Suspend this run at its next safe boundary, to resume later"
                  }
                >
                  {pausing ? "Pausing…" : paused ? "Resume" : "Pause"}
                </button>
                <button
                  className="button"
                  type="button"
                  disabled={cancelling}
                  onClick={() => {
                    if (lastStarted.type === "run.started") {
                      void cancel(lastStarted.payload.run.id);
                    }
                  }}
                  title="Stop this run at its next safe boundary"
                >
                  {cancelling ? "Stopping…" : "Cancel"}
                </button>
              </div>
            </div>
          ) : null}

          {/*
            Approaches, permanently. Branching a mission, running competing
            approaches and choosing between them on evidence is the product
            thesis, and it used to be one word in the corner of this bar.
            Drawn from the /compare data useComparison already fetches for
            every tab, so this costs no extra request.
          */}
          <div className="rail__section rail__section--flush">
            <div className="eyebrow">Approaches</div>
            {attempts.length === 0 ? (
              <div className="rail__empty rail__empty--inset">
                One approach so far. A second one starts from the same recorded
                checkpoint, so the two can be compared on evidence rather than
                on which ran last.
              </div>
            ) : (
              attempts.map((attempt) => (
                <AttemptRow
                  key={attempt.runId}
                  attempt={attempt}
                  chosen={comparison.decision?.runId === attempt.runId}
                  onOpen={() => setMode("compare")}
                />
              ))
            )}
            {/*
              One primary action, on the Approaches screen where the form and
              the evidence are. The rail used to carry its own "Fork an
              attempt" button *and* a "Compare attempts" button, so the same
              intention had two entry points that led to the same place and
              read as two different features.
            */}
            {/* Hidden while that screen is already open: on the decision room
                it was a third route to the view you are looking at, competing
                with the one action the screen is asking for. */}
            {mode === "compare" ? null : (
              <button
                className="button attempt__cta"
                type="button"
                onClick={() => setMode("compare")}
              >
                {attempts.length === 0 ? "Try another approach" : "Compare approaches"}
              </button>
            )}
          </div>

          {/*
            Authority, above the roster, because "who may act" is the thing a
            person needs before "who is here". Every affordance in it is
            rendered only for the participant who may take it — see the note in
            control-panel.tsx on why that is not the same as disabling one.
          */}
          <ControlPanel
            authority={authority}
            participants={presence.participants}
            onOffer={(participantId) => {
              void handoff(participantId).then(authority.refresh);
            }}
            onRequest={(reason) => {
              void requestControl(reason).then(authority.refresh);
            }}
            onAnswer={(offerEventId, answer) => {
              void answerHandoff(offerEventId, answer).then(authority.refresh);
            }}
          />

          <PendingDirection pending={authority.pendingDirection} />

          {/*
            Who is here and what they may do. Was a row of 5px dots in the
            session bar; roles are multiplayer state and belong somewhere
            legible. The handoff action used to live on these rows and has
            moved up into Control — a roster answers "who is here", and mixing
            the one irreversible action in the rail into it put "Hand off"
            beside every name whether or not the person reading held anything
            to hand.
          */}
          {/*
            Hidden while you are the only one here. A section headed
            Participants listing one person, with a badge saying that person
            holds control, is a whole region of the rail spent telling you
            something you knew before you opened the app — and it appears on
            every mission, because most missions have one person in them.
            Invite is in the command palette when there is somebody to invite.
          */}
          {presence.participants.length < 2 ? null : (
          <div className="rail__section">
            <div className="eyebrow">Participants</div>
            {presence.participants.length === 0 ? (
              <div className="rail__empty">
                Just you. Invite a teammate to watch this run live.
              </div>
            ) : (
              <div className="party">
                {presence.participants.map((participant) => (
                  <div
                    key={participant.id}
                    className={`party__row${participant.connected ? " party__row--live" : ""}`}
                  >
                    <span className="party__dot" />
                    <span className="party__who">
                      <span className="party__name">{participant.name}</span>
                      <span className="party__role">
                        {sentenceCase(participant.role)}
                        {participant.connected ? "" : " · Not connected"}
                      </span>
                    </span>
                    {authority.controlHeldBy === participant.id ? (
                      <span
                        className="party__baton"
                        title="Holds execution authority for this session"
                      >
                        Control
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
          )}

          </div>

          {/*
            Pinned to the foot of the rail rather than stacked in it.

            These are telemetry: you read them, you never act on them, and
            they were sitting in the column the eye returns to most while
            the things you *do* act on — attempts, participants — got pushed
            below the fold. Kept, because a run's size and elapsed time are
            worth a glance; demoted, because glancing is all anyone does.
          */}
          <div className="rail__meter">
            <span className="rail__meter-item" title="Events in this session's log">
              {events.length} ev
            </span>
            <span className="rail__meter-item" title="Tool calls the agent has made">
              {toolCalls.length} tools
            </span>
            <span className="rail__meter-item" title="Patches proposed">
              {patches.length} patches
            </span>
            <span className="rail__meter-item">
              <span className="stat__add">+{fileChanges.additions}</span>{" "}
              <span className="stat__del">−{fileChanges.deletions}</span>
            </span>
            <span className="rail__meter-item">{formatElapsed(events)}</span>
            {/*
              What the session has cost. It was computed on every model call,
              stored on every receipt, and shown nowhere — so the person whose
              money it is had to read a log line to find out. Drawn from the
              worker's projection over the log rather than from a counter, so
              a resumed session shows what it has actually spent instead of
              starting again at zero.
            */}
            <span
              className="rail__meter-item"
              title={
                usage.session.costUsd === null
                  ? `No model in this session has a configured price, so spend is not being counted. ${usage.session.runs} run(s) finished.`
                  : `${usage.session.modelCalls} model call(s) across ${usage.session.runs} finished run(s)${
                      usage.session.costIsFloor
                        ? " — at least this much: a run is still going, or some of it could not be priced"
                        : ""
                    }`
              }
            >
              {usage.session.costUsd === null
                ? usage.session.runs === 0
                  ? "$—"
                  : "Not counted"
                : formatSpend(usage.session.costUsd, usage.session.costIsFloor ? 1 : 0)}
            </span>
          </div>

        </aside>

        {layout.tree ? (
          <>
            <FileTree state={fileTree} />
            <FileViewer state={fileTree} />
          </>
        ) : (
          <>
            {/*
              One canvas, two contents. The Decision Room used to replace the
              whole body — composer and evidence inspector included — which
              meant reaching a decision cost you the ability to say anything
              and the panel showing what was verified. Swapping only the
              middle keeps direction always available and the evidence beside
              the thing it is evidence for.
            */}
            <main className="canvas">
              <div className="canvas__view">
                {layout.canvas === "decision-room" ? (
                  <CompareScreen
                    state={comparison}
                    repositoryState={session.repositoryState}
                    endpoint={endpoint}
                    sessionId={session.id}
                    onClose={() => setMode("timeline")}
                  />
                ) : (
              <div className="timeline">
                {trulyEmpty ? (
                  <div className="empty empty--page">
                    {status === "error" ? (
                      <>
                        <p className="empty__title">No connection</p>
                        <p className="empty__hint">
                          The worker at {endpoint} is not answering. Reconnect
                          from the command palette, or check that it is running.
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="empty__title">Nothing has run yet</p>
                        <p className="empty__hint">
                          Ask the agent to do something and every command,
                          patch and test it runs will appear here as it
                          happens.
                        </p>
                        <div className="empty__facts">
                          <span className="chip">
                            {basename(session.repositoryPath)}
                          </span>
                          <span
                            className={
                              session.allowWrites ? "chip chip--allow" : "chip"
                            }
                          >
                            {session.allowWrites
                              ? "Writes allowed"
                              : "Read-only"}
                          </span>
                          <span
                            className={
                              session.allowCommands ? "chip chip--allow" : "chip"
                            }
                          >
                            {session.allowCommands
                              ? "Commands allowed"
                              : "No commands"}
                          </span>
                        </div>
                      </>
                    )}
                  </div>
                ) : (
                  <TimelineView
                    events={visible}
                    busy={busy}
                    raw={raw}
                    highlighted={highlighted}
                    groupOverrides={groupOverrides}
                    onToggleGroup={toggleGroup}
                    group={filter === "all"}
                  />
                )}
              </div>
                )}
              </div>
              {layout.composer ? (
                <Composer
                  busy={busy}
                  model={turnModel}
                  onAsk={(goal, modelId) => void ask(goal, modelId)}
                  onDirect={(goal) => void direct(goal)}
                />
              ) : null}
            </main>
            {layout.evidence ? (
              <FileChangesPanel
                state={fileChanges}
                diffs={appliedDiffs}
                verdict={evidenceVerdict}
                github={github}
              />
            ) : null}
          </>
        )}
      </div>

      {actionError ? <div className="session-bar__error">{actionError}</div> : null}

      {terminalOpen ? (
        <div className="terminal-dock" style={{ height: terminalHeight }}>
          <div
            className="terminal-dock__resize"
            onMouseDown={startTerminalResize}
            title="Drag to resize"
          />
          <div className="terminal-dock__head">
            <span className="terminal-dock__prompt" aria-hidden="true">
              ❯
            </span>
            <span className="terminal-dock__title">Terminal</span>
            <span className="terminal-dock__path">{session.repositoryPath}</span>
            <button
              className="icon-button"
              type="button"
              onClick={() => setTerminalOpen(false)}
              title="Close this shell"
            >
              Close
            </button>
          </div>
          <TerminalPanel cwd={session.repositoryPath} theme={theme} />
        </div>
      ) : null}

      {paletteOpen ? (
        <CommandOverlay
          commands={commands}
          onAsk={(goal) => {
            if (busy) {
              void direct(goal);
            } else {
              void ask(goal);
            }
          }}
          onClose={() => setPaletteOpen(false)}
        />
      ) : null}

      {inviting ? (
        <InvitePanel onInvite={invite} onClose={() => setInviting(false)} />
      ) : null}
    </div>
  );
};
