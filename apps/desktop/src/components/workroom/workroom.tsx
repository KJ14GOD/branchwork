import type { GithubStatus } from "@novus/contracts/protocol";

import type { MissionComposition } from "../../mission-state.ts";
import type { Person, Workstream } from "../../workstreams.ts";
import { ActivityFeed, type Milestone } from "./activity-feed.tsx";
import { ComposerDock } from "./composer-dock.tsx";
import { EvidenceInspector, type EvidenceFacts } from "./evidence-inspector.tsx";
import { MissionHeader } from "./mission-header.tsx";
import { WorkstreamRail } from "./workstream-rail.tsx";

/**
 * A mission with work in it.
 *
 * Composition follows the mission's state rather than being fixed: the rail
 * exists once there is somebody to attribute work to, the inspector exists once
 * there is evidence, and the centre takes back whatever they do not use. The
 * previous shell drew all three on every mission, so the screen a person met
 * after asking for something looked identical to the one they met before.
 */

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
  action?: { label: string; onClick: () => void } | undefined;
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
        />
      ) : null}

      <main className="workroom__work">
        <StateBanner composition={composition} />

        {composition.showRecovery && failureReason ? (
          <RecoveryState reason={failureReason} onRetry={onRetry} />
        ) : (
          <ActivityFeed milestones={milestones} />
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
        onSend={onSend}
      />
    </div>
  );
};
