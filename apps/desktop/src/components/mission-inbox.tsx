import type {
  HostCapabilities,
  MissionAttention,
  RememberedSession,
} from "@novus/contracts/protocol";

import { Modal } from "./modal.tsx";

const basename = (path: string): string =>
  path.split("/").filter(Boolean).at(-1) ?? path;

/**
 * The inbox's headings, most urgent first.
 *
 * Worded as what is being asked of the reader rather than as a status. "Needs
 * your decision" is a request; "awaiting decision" is a description of a
 * record, and a person scanning for what to do next reads straight past it.
 * The worker sorts by this same order, so a group is always contiguous.
 */
export const ATTENTION_GROUPS: { attention: MissionAttention; label: string }[] =
  [
    { attention: "needs-decision", label: "Needs your decision" },
    { attention: "needs-approval", label: "Needs your approval" },
    { attention: "waiting-on-someone", label: "Waiting on someone" },
    { attention: "running", label: "Running" },
    { attention: "needs-direction", label: "Needs your direction" },
    { attention: "settled", label: "Recently decided" },
  ];

export type MissionGroup = {
  attention: MissionAttention;
  label: string;
  missions: RememberedSession[];
};

/**
 * Missions grouped by what each is asking for, in urgency order.
 *
 * Not by repository and emphatically not by recency: a mission waiting on a
 * decision has by definition stopped moving, so sorting by last activity
 * buried exactly the rows that needed somebody.
 *
 * A group with nothing in it is dropped rather than rendered empty — a
 * column of zeroes is the thing this screen was already criticised for. It
 * is also why this is a function and not a `.map()` in the markup: "no empty
 * headings" is a rule worth a test, and markup is not testable here.
 */
export const groupMissions = (
  remembered: readonly RememberedSession[],
): MissionGroup[] =>
  ATTENTION_GROUPS.flatMap(({ attention, label }) => {
    const missions = remembered.filter((entry) => entry.attention === attention);

    return missions.length === 0 ? [] : [{ attention, label, missions }];
  });

/**
 * What resuming a remembered mission asks the worker for.
 *
 * Two rules live in these four fields. The id is the mission's own, which is
 * what brings its timeline back — opening the repository afresh would start
 * an empty stream beside a history nobody could reach. The permissions are
 * the *host's current* ones, never anything the mission had before: a
 * session recorded with writes allowed does not silently regain them, and
 * nothing on `RememberedSession` is even consulted for them.
 */
export type ResumeRequest = {
  repositoryPath: string;
  allowWrites: boolean;
  allowCommands: boolean;
  /** The mission's own id — resuming it is what brings its timeline back. */
  resume: string;
};

export const resumeRequest = (
  mission: RememberedSession,
  capabilities: HostCapabilities | null,
): ResumeRequest => ({
  repositoryPath: mission.repositoryPath,
  allowWrites: capabilities?.allowWrites ?? false,
  allowCommands: capabilities?.allowCommands ?? false,
  resume: mission.id,
});

const evidenceLabel = (evidence: RememberedSession["evidence"]): string =>
  evidence === "verified"
    ? "Verified"
    : evidence === "failing"
      ? "Tests failing"
      : "Unverified";

/**
 * Whether there is anything here to have an opinion about.
 *
 * A repository somebody opened and never asked anything of has no runs, no
 * changes, and nothing that could have been checked — so "Unverified" beside
 * it is a verdict on work that does not exist, and it read as though a
 * mission had been run and found wanting. `goal` is null exactly when no run
 * ever started, which is the same fact the row already uses to say "Opened,
 * nothing run yet".
 */
const hasRun = (mission: RememberedSession): boolean => mission.goal !== null;

const MissionRow = ({
  mission,
  disabled,
  onResume,
}: {
  mission: RememberedSession;
  disabled: boolean;
  onResume: () => void;
}) => (
  <button
    className="inbox__row"
    type="button"
    disabled={disabled}
    onClick={onResume}
    title={`${mission.repositoryPath} · last active ${mission.lastActivityAt}`}
  >
    <span className="inbox__goal">
      {/* The goal leads. Five missions in one repository were five identical
          rows when the path did. */}
      {mission.goal ?? "Opened, nothing run yet"}
    </span>
    <span className="inbox__meta">
      <span className="inbox__repo">{basename(mission.repositoryPath)}</span>
      {mission.approaches > 1 ? (
        <span>{mission.approaches} approaches</span>
      ) : null}
      {hasRun(mission) ? (
        <span className={`inbox__evidence inbox__evidence--${mission.evidence}`}>
          {/* Never a tick for a mission that tested nothing. */}
          {evidenceLabel(mission.evidence)}
        </span>
      ) : null}
      {mission.controller ? <span>{mission.controller} in control</span> : null}
    </span>
  </button>
);

const SUBTITLE =
  "Every mission this machine remembers, grouped by what it is waiting on.";

/**
 * The Mission Inbox: where you come back to work already in flight.
 *
 * It used to be appended to the bottom of the open-a-repository form, which
 * made one surface do two unrelated jobs — starting something new and
 * navigating to something old — and made the form's height a function of how
 * many missions existed. Creation is now its own compact modal
 * (`open-repository.tsx`); this is navigation, and it owns the list.
 *
 * `onClose` decides which of the two contexts this is: given one it is the
 * mission switcher on the overlay, without one it is the window's first
 * screen. One component either way — the list, the grouping and the resume
 * rule must not diverge between "no tabs open yet" and "switch missions".
 */
export const MissionInbox = ({
  missions,
  capabilities,
  opening,
  error,
  onResume,
  onOpenRepository,
  onClose,
}: {
  missions: RememberedSession[];
  /** What the host permits now — what a resumed mission is opened with. */
  capabilities: HostCapabilities | null;
  opening: boolean;
  error: string | null;
  onResume: (request: ResumeRequest) => void;
  onOpenRepository: () => void;
  /** Present only when this is the overlay rather than the first screen. */
  onClose?: () => void;
}) => {
  const groups = groupMissions(missions);

  const list =
    groups.length === 0 ? (
      // Compact and left-aligned: an empty inbox is a normal first launch,
      // not an error, and it does not earn a full-height centred billboard.
      <div className="inbox__empty">
        <p className="inbox__empty-title">No missions yet</p>
        <p className="inbox__empty-hint">
          Open a repository and every mission you run in it appears here —
          grouped by whether it is running, waiting on you, or already decided.
        </p>
      </div>
    ) : (
      groups.map((group) => (
        <div className="inbox__group" key={group.attention}>
          <span className="eyebrow">{group.label}</span>
          {group.missions.map((mission) => (
            <MissionRow
              key={mission.id}
              mission={mission}
              disabled={opening}
              onResume={() => onResume(resumeRequest(mission, capabilities))}
            />
          ))}
        </div>
      ))
    );

  const foot = (
    <>
      {error ? <div className="open__error">{error}</div> : null}
      <span className="sheet__spacer" />
      <button
        className="button button--primary button--large"
        type="button"
        onClick={onOpenRepository}
      >
        Open a repository
      </button>
    </>
  );

  if (onClose) {
    return (
      <Modal
        title="Missions"
        subtitle={SUBTITLE}
        footer={foot}
        bodyClassName="sheet__body--well"
        onClose={onClose}
      >
        {list}
      </Modal>
    );
  }

  return (
    <div className="inbox">
      <div className="sheet inbox__panel">
        <header className="sheet__head">
          <h1 className="sheet__title">Missions</h1>
          <p className="sheet__subtitle">{SUBTITLE}</p>
        </header>
        <div className="sheet__body sheet__body--well">{list}</div>
        <div className="sheet__foot">{foot}</div>
      </div>
    </div>
  );
};
