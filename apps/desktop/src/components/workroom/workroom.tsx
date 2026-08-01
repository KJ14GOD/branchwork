import type { ReactNode } from "react";

import type { GithubStatus } from "@novus/contracts/protocol";

import type { ControlProps } from "../control-panel.tsx";
import type { MissionCompletion } from "../../mission-completion.ts";
import type { MissionComposition } from "../../mission-state.ts";
import type { Person, Workstream } from "../../workstreams.ts";
import { ActivityFeed, type Milestone } from "./activity-feed.tsx";
import { CompletionState } from "./completion-state.tsx";
import { ComposerDock } from "./composer-dock.tsx";
import { EvidenceInspector, type EvidenceFacts } from "./evidence-inspector.tsx";
import { MissionHeader } from "./mission-header.tsx";
import {
  WorkstreamRail,
  type RailMeter,
  type RunControl,
} from "./workstream-rail.tsx";

/**
 * A mission with work in it. **The only host mission screen there is.**
 *
 * Composition follows the mission's state rather than being fixed: the rail
 * exists once there is somebody to attribute work to, the inspector exists once
 * there is evidence, and the centre takes back whatever they do not use. The
 * previous shell drew all three on every mission, so the screen a person met
 * after asking for something looked identical to the one they met before.
 *
 * It used to be one of *two* complete mission shells in this app, chosen by a
 * `mode` that a `useEffect` could change on its own — so a mission that reached
 * a decision teleported the host into a three-column shell they had not asked
 * for, and the only surface carrying the control lifecycle was the one they
 * were not looking at. Both shells are now this one. Approaches, the repository
 * browser and the raw event log are `focus` panes over the same screen, opened
 * only by somebody asking for them, and every one of them keeps the header, the
 * room, and the composer.
 */

/**
 * A surface a person deliberately opened over the work.
 *
 * The rule this encodes is the one the auto-route broke: complementary work is
 * never presented as competing approaches, so nothing here opens itself. The
 * bar names what is showing and offers the way back, which is also why all
 * three panes can share one mechanism instead of being three shells again.
 */
export type Focus = {
  label: string;
  onClose: () => void;
  node: ReactNode;
};

export const FocusPane = ({ focus }: { focus: Focus }) => (
  <div className="focus">
    <div className="focus__bar">
      <span className="focus__label">{focus.label}</span>
      <button className="button button--quiet" type="button" onClick={focus.onClose}>
        Back to activity
      </button>
    </div>
    <div className="focus__body">{focus.node}</div>
  </div>
);

/**
 * The failure state, which is a recovery affordance and not a decision surface.
 *
 * A run that stopped before changing anything has nothing to compare, nothing
 * to verify, and nothing to record — offering a decision spine and an evidence
 * inspector for it is the app asking somebody to judge an empty set. What it
 * needs is the reason, in full, and a way back in.
 */
export const RecoveryState = ({
  reason,
  onRetry,
}: {
  reason: string;
  onRetry: () => void;
}) => (
  <div className="recovery">
    <h2 className="recovery__title">Stopped before it changed anything</h2>
    <p className="recovery__lede">
      No files were touched and nothing was verified. Nothing in the repository
      moved.
    </p>
    <pre className="recovery__reason">{reason}</pre>
    {/*
      Deliberately not a primary button. The dominant action on every Workroom
      screen is Send, in the dock, and a filled button here would be the second
      one — the "several equal buttons" the whole pass is removing. It is also
      not a re-run: it puts the cursor in the composer, which is where the
      person has to say what to try instead, so it is labelled as that rather
      than as something that would act on its own.
    */}
    <button className="button" type="button" onClick={onRetry}>
      Give it more to go on
    </button>
  </div>
);

/**
 * One line of mission state, above the work, when the state is worth stating.
 *
 * Not a banner on every screen — a permanent banner is chrome. It appears for
 * the two states a person can misread: changed-but-unverified, which looks like
 * success, and waiting-on-you, which looks like progress.
 */
export const StateBanner = ({
  composition,
}: {
  composition: MissionComposition;
}) => {
  if (
    composition.state !== "changed-unverified" &&
    composition.state !== "needs-direction" &&
    composition.state !== "verified"
  ) {
    return null;
  }

  const tone =
    composition.state === "verified"
      ? "banner banner--verified"
      : composition.state === "needs-direction"
        ? "banner banner--attention"
        : "banner";

  return (
    <div className={tone}>
      <span className="banner__headline">{composition.headline}</span>
      <span className="banner__detail">{composition.detail}</span>
    </div>
  );
};

export const Workroom = ({
  composition,
  goal,
  state,
  repository,
  branch,
  workstreams,
  people,
  selected,
  onSelect,
  onAdd,
  onInvite,
  milestones,
  evidence,
  github,
  failureReason,
  onRetry,
  target,
  onTarget,
  busy,
  onSend,
  action,
  control,
  runControl,
  meter,
  completion,
  completedBy,
  onReopen,
  focus,
  dominant = "direction",
}: {
  composition: MissionComposition;
  goal: string;
  state: string;
  repository: string;
  branch: string | null;
  workstreams: readonly Workstream[];
  people: readonly Person[];
  selected: string | null;
  onSelect: (runId: string) => void;
  onAdd: () => void;
  onInvite: () => void;
  milestones: readonly Milestone[];
  evidence: EvidenceFacts;
  github: GithubStatus | null;
  failureReason: string | null;
  /** Puts the person back in the composer with the failure still on screen. */
  onRetry: () => void;
  target: string | null;
  onTarget: (runId: string) => void;
  busy: boolean;
  onSend: (text: string) => void;
  action?:
    | { label: string; onClick: () => void; primary?: boolean }
    | undefined;
  /** Request control, offer, accept, decline, withdraw — see WorkstreamRail. */
  control: ControlProps;
  /** Pause, resume and cancel, while something is actually running. */
  runControl?: RunControl | undefined;
  /** What this mission has cost and how long it has been going. */
  meter: RailMeter;
  /** The frozen ending, when a person has declared this mission over. */
  completion: MissionCompletion | null;
  /** Who called it, named rather than left as a participant id. */
  completedBy: string;
  onReopen: () => void;
  /** Approaches, the repository, the raw log — never opened automatically. */
  focus?: Focus | undefined;
  /**
   * Which control on this screen is the one inverted one.
   *
   * Decided once by `dominantAction` rather than by each region claiming it —
   * see the note there. Everything not named here renders quiet.
   */
  dominant?: "handoff" | "decision" | "focus" | "direction";
}) => {
  const columns = !composition.showWorkstreams
    ? "workroom workroom--solo"
    : composition.showEvidence
      ? "workroom"
      : "workroom workroom--noevidence";

  return (
    <div className={columns}>
      <MissionHeader
        goal={goal}
        state={state}
        repository={repository}
        branch={branch}
        people={people}
        onInvite={onInvite}
        action={action}
      />

      {composition.showWorkstreams ? (
        <WorkstreamRail
          workstreams={workstreams}
          people={people}
          selected={selected}
          onSelect={onSelect}
          onAdd={onAdd}
          control={control}
          runControl={runControl}
          meter={meter}
        />
      ) : null}

      <main
        className={focus ? "workroom__work workroom__work--focus" : "workroom__work"}
      >
        {/*
          A focused surface takes the work column and nothing else. The banner
          belongs to the mission's own state and would be describing something
          other than what is on screen.
        */}
        {focus ? (
          <FocusPane focus={focus} />
        ) : (
          <>
            <StateBanner composition={composition} />

            {composition.showCompletion && completion ? (
              <CompletionState
                completion={completion}
                who={completedBy}
                onReopen={onReopen}
              />
            ) : composition.showRecovery && failureReason ? (
              <RecoveryState reason={failureReason} onRetry={onRetry} />
            ) : (
              <ActivityFeed milestones={milestones} />
            )}
          </>
        )}
      </main>

      {composition.showEvidence ? (
        <EvidenceInspector facts={evidence} github={github} />
      ) : null}

      <ComposerDock
        workstreams={workstreams}
        target={target}
        onTarget={onTarget}
        busy={busy}
        placeholder={
          composition.state === "failed"
            ? "Say what to try instead…"
            : "Direct the work…"
        }
        primary={dominant === "direction"}
        onSend={onSend}
      />
    </div>
  );
};
