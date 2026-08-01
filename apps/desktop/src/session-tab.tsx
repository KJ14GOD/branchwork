import { useEffect, useMemo, useState } from "react";

import type { HarnessKind, SessionEvent } from "@novus/contracts";
import type { SessionSummary } from "@novus/contracts/protocol";
import { formatSpend } from "@novus/ui";

import { bridge } from "./bridge.ts";
import { CommandOverlay, type Command } from "./components/command-overlay.tsx";
import { CompareScreen } from "./components/compare-screen.tsx";
import { FileChangesPanel } from "./components/file-changes-panel.tsx";
import { appliedDiffsByPath } from "./applied-diffs.ts";
import { InvitePanel } from "./components/invite-panel.tsx";
import { TerminalPanel } from "./components/terminal-panel.tsx";
import { groupKeyFor } from "./components/timeline-view.tsx";
import { harnessChoices } from "./components/harness-picker.tsx";
import { useProviders } from "./use-providers.ts";
import { EmptyMission } from "./components/workroom/empty-mission.tsx";
import {
  EventLogPane,
  RepositoryPane,
} from "./components/workroom/focus-panes.tsx";
import { Workroom, type Focus } from "./components/workroom/workroom.tsx";
import { readMilestones } from "./components/workroom/activity-feed.tsx";
import { composeMission, dominantAction, missionState } from "./mission-state.ts";
import { readCompletion } from "./mission-completion.ts";
import { readVerification } from "./verification.ts";
import { readPeople, readWorkstreams } from "./workstreams.ts";
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

/**
 * Which deliberately-opened surface is over the work, if any.
 *
 * `null` is the Workroom itself and is the only state anything can arrive at
 * without a person asking. There is no code path that sets any of the others
 * on its own — that is the point of this slice. A mission reaching a decision
 * used to route the host into a different shell entirely, which is how
 * complementary workstreams came to be presented as competing approaches.
 */
type FocusMode = "approaches" | "changes" | "browse" | "log" | null;

const MIN_TERMINAL_HEIGHT = 140;
const MAX_TERMINAL_HEIGHT = 640;
const DEFAULT_TERMINAL_HEIGHT = 280;

/** What the tab strip in `App` needs to know about a tab it is not rendering. */
export type TabStatus = {
  runStatus: string;
  additions: number;
  deletions: number;
  /**
   * What this mission is about, for the sidebar to name it by.
   *
   * Reported up rather than read from `SessionSummary`, which does not carry
   * it: a session is a repository somebody opened, and the goal arrives with
   * the first run. Null until then, and the sidebar says "Untitled mission"
   * rather than inventing one.
   */
  goal: string | null;
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

/**
 * One open session, rendered in full.
 *
 * Instantiated once per open tab — every tab mounts one of these and keeps it
 * mounted (hidden with `display: none`, never unmounted) while another tab is
 * active, so a background tab's event stream, presence poll, and terminal keep
 * running rather than being torn down and rebuilt on every switch. `session`
 * is fixed for the component's whole life: it is the summary the tab was
 * opened with, not state this component manages.
 *
 * This file used to hold *two* complete mission shells — the Workroom, and a
 * three-column shell with its own session bar, spine, attempt list, control
 * panel, roster, telemetry meter, composer and timeline — with a `mode` value
 * deciding which one a person got, and a `useEffect` that could change `mode`
 * without anybody acting. That is gone. What is left is a container: it derives
 * the mission's state and renders one screen, plus the surfaces a person can
 * deliberately open over it.
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
  const [focusMode, setFocusMode] = useState<FocusMode>(null);
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
  const decisionPhase = phases.find((phase) => phase.key === "decision");
  /**
   * Alternatives have all stopped and nothing has been recorded about them.
   *
   * Used to *offer* the Decision Room, never to open it. The effect that used
   * to sit here called `setMode("compare")` the moment this went true, so a
   * host watching two agents work complementary parts of one change was moved,
   * without acting, onto a screen framing those two agents as rivals. Nothing
   * moves the view now; this only decides which action the header carries.
   */
  const decisionWaiting = decisionPhase?.status === "needs-attention";

  /**
   * What the evidence panel can honestly claim — from the log, not only from
   * the comparison. See verification.ts for why that distinction is the
   * difference between a true and a false verdict on most missions.
   */
  const verification = useMemo(
    () => readVerification(events, comparison.comparison),
    [events, comparison.comparison],
  );
  const completion = useMemo(() => readCompletion(events), [events]);
  const fileTree = useFileTree(
    focusMode === "browse" ? session.repositoryPath : null,
  );
  const turnModel = useTurnModel();
  /**
   * Which agent this mission runs on.
   *
   * Held per tab and only until the first turn: after that the mission's runs
   * carry their own harness on the log, and a picker that could retroactively
   * change what already ran would be lying about history.
   */
  const providers = useProviders(endpoint, true);
  const harnesses = harnessChoices(providers.providers);
  const [harness, setHarness] = useState<HarnessKind | null>(null);
  const chosenHarness =
    harness ?? harnesses.find((choice) => choice.available)?.kind ?? null;
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

  const jumpTo = (sequence: number) => {
    setFocusMode("log");
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

  /**
   * Everything that is not the mission itself.
   *
   * The escape hatches live here and only here. Each of them was, at some
   * point, a permanent region of a shell that drew every region on every
   * screen; each is genuinely useful and none of them is what a person opened
   * the app to look at.
   */
  const commands: Command[] = [
    {
      id: "approaches",
      label: "Compare approaches",
      hint: `${attempts.length}`,
      run: () => setFocusMode("approaches"),
    },
    {
      id: "changes",
      label: "Review changes and diffs",
      hint: `${fileChanges.files.length}`,
      run: () => setFocusMode("changes"),
    },
    {
      id: "log",
      label: "Open the raw event log",
      hint: `${events.length}`,
      run: () => {
        setFilter("all");
        setFocusMode("log");
      },
    },
    {
      id: "filter-tools",
      label: "Raw log — tool activity only",
      hint: `${toolCalls.length}`,
      run: () => {
        setFilter("tools");
        setFocusMode("log");
      },
    },
    {
      id: "filter-patches",
      label: "Raw log — proposed patches only",
      hint: `${patches.length}`,
      run: () => {
        setFilter("patches");
        setFocusMode("log");
      },
    },
    ...(host
      ? [
          {
            id: "browse",
            label: "Browse the repository",
            run: () => setFocusMode("browse"),
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
    {
      id: "close-tab",
      label: "Close this mission tab",
      hint: "the mission is kept",
      run: onCloseTab,
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
                // Workroom's own headline beside this says which person and
                // for what.
                ? "waiting on you"
                : run
                  ? "running"
                  : "ready";

  /**
   * The Workroom's own derivation: what state this mission is in, who is in it,
   * and what has happened — each from a module with its own tests.
   *
   * This component composes those; it does not compute them. That split is the
   * point: the surfaces below read one `composition` object rather than each
   * re-deciding from `busy && attempts.length && …` in the markup, which is how
   * the old shell ended up rendering every region on every state.
   */
  const awaitingPerson = Boolean(
    authority.controlOffer || authority.controlRequests.length > 0 || paused,
  );
  const mission = useMemo(
    () =>
      missionState({
        events,
        comparison: comparison.comparison,
        filesChanged: fileChanges.files.length,
        busy,
        awaitingPerson,
      }),
    [events, comparison.comparison, fileChanges.files.length, busy, awaitingPerson],
  );
  const workstreams = useMemo(
    () => readWorkstreams(events, comparison.comparison),
    [events, comparison.comparison],
  );
  const people = useMemo(
    () => readPeople(presence.participants, authority.controlHeldBy),
    [presence.participants, authority.controlHeldBy],
  );
  const milestones = useMemo(
    () => readMilestones(events, workstreams),
    [events, workstreams],
  );
  const composition = composeMission(mission, {
    agents: workstreams.length,
    changed: fileChanges.files.length,
    verified: mission === "verified",
    completion,
  });
  // Which workstream the composer is addressing. Defaults to the first, and
  // follows the rail's selection — a room with two agents must never leave
  // "who receives this" unanswered.
  const [addressed, setAddressed] = useState<string | null>(null);
  const target = addressed ?? workstreams.at(0)?.runId ?? null;

  // Reports up to the tab strip. Deliberately keyed on the computed values,
  // not on `onStatus`'s identity — that is a fresh closure every render of
  // `App`'s tab map, and depending on it would refire this for every tab on
  // every keystroke anywhere in the app.
  useEffect(() => {
    onStatus({
      runStatus,
      additions: fileChanges.additions,
      deletions: fileChanges.deletions,
      goal: missionGoal,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runStatus, fileChanges.additions, fileChanges.deletions, missionGoal]);

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

  const terminalDock = terminalOpen ? (
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
  ) : null;

  const overlays = (
    <>
      {actionError ? <div className="session-bar__error">{actionError}</div> : null}

      {paletteOpen ? (
        <CommandOverlay
          commands={commands}
          onAsk={(goal) => {
            if (busy) {
              void direct(goal);
            } else {
              void ask(goal, turnModel.option);
            }
          }}
          onClose={() => setPaletteOpen(false)}
        />
      ) : null}

      {inviting ? (
        <InvitePanel onInvite={invite} onClose={() => setInviting(false)} />
      ) : null}
    </>
  );

  /**
   * A repository is open and nobody has asked for anything.
   *
   * Returned early and whole, because this state is a genuinely different
   * screen and not the working shell with empty panels in it. Everything the
   * Workroom draws — the room, evidence, the mission header's state line —
   * describes work that does not exist yet.
   */
  if (mission === "empty" && focusMode === null) {
    return (
      <div
        className="tab-content tab-content--start"
        style={{ display: active ? "grid" : "none" }}
      >
        <div className="startbar">
          {/*
            Presence and Invite only. The utilities are all still one keystroke
            away in the palette; none of them is what somebody opening a
            repository is here to do.
          */}
          <span className="titlebar__spacer" />
          <span className="kbd-hint">
            <kbd>/</kbd> Commands
          </span>
          <button
            className="button button--quiet"
            type="button"
            onClick={() => setInviting(true)}
          >
            Invite
          </button>
        </div>

        <EmptyMission
          repository={basename(session.repositoryPath)}
          branch={null}
          repositoryState={session.repositoryState}
          allowWrites={session.allowWrites}
          harnesses={harnesses}
          harness={chosenHarness}
          onHarness={setHarness}
          busy={busy}
          error={actionError}
          onStart={(goal) =>
            void ask(goal, turnModel.option, chosenHarness ?? undefined)
          }
          onInvite={() => setInviting(true)}
        />

        {overlays}
      </div>
    );
  }

  /**
   * Which single control on this screen is the dominant one.
   *
   * `.button--primary` is the app's only inversion, so two of them destroy the
   * mechanism that makes either mean anything. Three surfaces can each claim
   * it — the handoff offer, the header's decision action, and the composer's
   * Send — so the claim is settled once, here, from the mission's state rather
   * than by whichever component happens to render first.
   */
  const dominant = dominantAction({
    offeredToYou:
      authority.controlOffer?.toParticipantId === authority.you &&
      authority.controlOffer?.state === "offered",
    decisionWaiting,
    focused: focusMode !== null,
  });

  /**
   * The way into the Decision Room, offered and never taken on a person's
   * behalf. Present once there is genuinely more than one approach — a single
   * baseline is not a comparison — and primary only when the approaches have
   * stopped and are actually waiting on a decision.
   */
  const approachAction =
    attempts.length > 1
      ? {
          label: decisionWaiting ? "Review approaches" : "Compare approaches",
          onClick: () => setFocusMode("approaches"),
          primary: dominant === "decision",
        }
      : undefined;

  const focus: Focus | undefined =
    focusMode === "approaches"
      ? {
          label: "Approaches",
          onClose: () => setFocusMode(null),
          node: (
            <CompareScreen
              state={comparison}
              repositoryState={session.repositoryState}
              endpoint={endpoint}
              sessionId={session.id}
              onClose={() => setFocusMode(null)}
            />
          ),
        }
      : focusMode === "changes"
        ? {
            label: "Changes",
            onClose: () => setFocusMode(null),
            node: (
              <FileChangesPanel
                state={fileChanges}
                diffs={appliedDiffs}
                verdict={{
                  tests: verification.verified,
                  reason: verification.reason,
                  checksRun: verification.checksRun,
                  checksPassed: verification.checksPassed,
                  approaches: Math.max(attempts.length, workstreams.length),
                  contested: verification.contested,
                }}
                github={github}
              />
            ),
          }
        : focusMode === "browse"
          ? {
              label: "Repository",
              onClose: () => setFocusMode(null),
              node: <RepositoryPane state={fileTree} />,
            }
          : focusMode === "log"
            ? {
                label:
                  filter === "tools"
                    ? "Event log · tool activity"
                    : filter === "patches"
                      ? "Event log · proposed patches"
                      : "Event log",
                onClose: () => setFocusMode(null),
                node: (
                  <EventLogPane
                    events={visible}
                    empty={trulyEmpty}
                    disconnected={status === "error"}
                    endpoint={endpoint}
                    busy={busy}
                    raw={raw}
                    grouped={filter === "all"}
                    highlighted={highlighted}
                    groupOverrides={groupOverrides}
                    onToggleGroup={toggleGroup}
                  />
                ),
              }
            : undefined;

  return (
    <div
      className="tab-content tab-content--workroom"
      style={{ display: active ? "grid" : "none" }}
    >
      <Workroom
        composition={composition}
        goal={missionGoal ?? basename(session.repositoryPath)}
        // The composition's own headline, not `runStatus`. Two derivations
        // of "where is this mission" put "Failed" in the header directly
        // above a banner reading "Changed, not verified" — the same screen
        // asserting two different things about the same run.
        state={composition.headline}
        repository={basename(session.repositoryPath)}
        branch={null}
        workstreams={workstreams}
        people={people}
        selected={target}
        onSelect={setAddressed}
        onAdd={() => setFocusMode("approaches")}
        onInvite={() => setInviting(true)}
        milestones={milestones}
        evidence={{
          verified: verification.verified,
          reason: verification.reason,
          checksRun: verification.checksRun,
          checksPassed: verification.checksPassed,
          files: fileChanges.files,
          contested: verification.contested,
          risks: [],
        }}
        github={github}
        failureReason={
          failed?.type === "run.failed" ? failed.payload.reason : null
        }
        onRetry={() => {
          document.querySelector<HTMLTextAreaElement>(".dock__input")?.focus();
        }}
        target={target}
        onTarget={setAddressed}
        busy={busy}
        onSend={(text) => {
          if (busy) {
            void direct(text);
          } else {
            void ask(text, turnModel.option);
          }
        }}
        control={{
          authority,
          participants: presence.participants,
          onOffer: (participantId) => {
            void handoff(participantId).then(authority.refresh);
          },
          onRequest: (reason) => {
            void requestControl(reason).then(authority.refresh);
          },
          onAnswer: (offerEventId, answer) => {
            void answerHandoff(offerEventId, answer).then(authority.refresh);
          },
        }}
        runControl={
          busy && lastStarted?.type === "run.started"
            ? {
                paused,
                pausing,
                cancelling,
                onPause: () => {
                  if (lastStarted.type === "run.started") {
                    if (paused) {
                      void resume(lastStarted.payload.run.id);
                    } else {
                      void pause(lastStarted.payload.run.id);
                    }
                  }
                },
                onCancel: () => {
                  if (lastStarted.type === "run.started") {
                    void cancel(lastStarted.payload.run.id);
                  }
                },
              }
            : undefined
        }
        meter={{
          elapsed: formatElapsed(events),
          spend:
            usage.session.costUsd === null
              ? usage.session.runs === 0
                ? "$—"
                : "Not counted"
              : formatSpend(
                  usage.session.costUsd,
                  usage.session.costIsFloor ? 1 : 0,
                ),
          spendTitle:
            usage.session.costUsd === null
              ? `No model in this session has a configured price, so spend is not being counted. ${usage.session.runs} run(s) finished.`
              : `${usage.session.modelCalls} model call(s) across ${usage.session.runs} finished run(s)${
                  usage.session.costIsFloor
                    ? " — at least this much: a run is still going, or some of it could not be priced"
                    : ""
                }`,
        }}
        completion={completion}
        completedBy={
          completion === null
            ? ""
            : (presence.participants.find(
                (participant) => participant.id === completion.completedBy,
              )?.name ?? "a participant")
        }
        // TODO(mission lifecycle): there is no route to reopen a mission yet.
        // `mission.reopened` exists in the contract and `projectSession` already
        // folds it, but nothing in `event-server.ts` appends one, so this is
        // deliberately inert rather than a button that fails. The slice that
        // adds POST /sessions/:id/reopen wires this to it; nothing else here
        // has to change.
        onReopen={() => undefined}
        focus={focus}
        dominant={dominant}
        {...(approachAction ? { action: approachAction } : {})}
      />

      {terminalDock}

      {overlays}
    </div>
  );
};
