import { useMemo, useState } from "react";

import type {
  HostCapabilities,
  MissionAttention,
  RememberedSession,
} from "@novus/contracts/protocol";

import { groupMissions, resumeRequest } from "./mission-inbox.tsx";
import type { ResumeRequest } from "./mission-inbox.tsx";

const basename = (path: string): string =>
  path.split("/").filter(Boolean).at(-1) ?? path;

/**
 * The attentions that are asking *this person* for something.
 *
 * `running` is moving on its own and `waiting-on-someone` is blocked on
 * another participant — counting either as "needs you" would put a number in
 * front of somebody that no action of theirs can bring down, which is how a
 * badge stops being read at all.
 */
const NEEDS_A_PERSON: readonly MissionAttention[] = [
  "needs-decision",
  "needs-approval",
  "needs-direction",
];

export type Project = {
  /** The repository path, which is also this project's identity. */
  path: string;
  name: string;
  missions: number;
  /** How many of those missions are asking the reader for something. */
  needsYou: number;
};

/**
 * The repositories behind the missions, most demanding first.
 *
 * Projects are derived from the missions rather than tracked separately: a
 * repository with nothing in it is not a project anybody needs to see here,
 * and deriving means the two views can never disagree about what exists.
 *
 * The order is by what is being asked of somebody, then by size, then by
 * name. Alphabetical alone reads as a file listing — it puts a repository
 * with three outstanding decisions below one that was opened and forgotten,
 * purely because of its initial.
 */
export const groupProjects = (
  remembered: readonly RememberedSession[],
): Project[] => {
  const byPath = new Map<string, Project>();

  for (const mission of remembered) {
    const existing = byPath.get(mission.repositoryPath) ?? {
      path: mission.repositoryPath,
      name: basename(mission.repositoryPath),
      missions: 0,
      needsYou: 0,
    };

    byPath.set(mission.repositoryPath, {
      ...existing,
      missions: existing.missions + 1,
      needsYou:
        existing.needsYou + (NEEDS_A_PERSON.includes(mission.attention) ? 1 : 0),
    });
  }

  return [...byPath.values()].sort(
    (a, b) =>
      b.needsYou - a.needsYou ||
      b.missions - a.missions ||
      a.name.localeCompare(b.name),
  );
};

const evidenceLabel = (evidence: RememberedSession["evidence"]): string =>
  evidence === "verified"
    ? "Verified"
    : evidence === "failing"
      ? "Tests failing"
      : "Unverified";

/**
 * Whether there is anything here to have an opinion about.
 *
 * A repository somebody opened and never asked anything of has no runs and
 * nothing that could have been checked, so "Unverified" beside it is a
 * verdict on work that does not exist. `goal` is null exactly when no run
 * ever started.
 */
const hasRun = (mission: RememberedSession): boolean => mission.goal !== null;

const countLabel = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

const ProjectCard = ({
  project,
  selected,
  onSelect,
}: {
  project: Project;
  selected: boolean;
  onSelect: () => void;
}) => (
  <button
    className={`missions__project${selected ? " missions__project--selected" : ""}`}
    type="button"
    aria-pressed={selected}
    onClick={onSelect}
    title={project.path}
  >
    <span className="missions__project-name">{project.name}</span>
    {/* The full path is a literal, so it is mono — and it is the second line
        because the folder name is what a person recognises. */}
    <span className="missions__project-path">{project.path}</span>
    <span className="missions__project-counts">
      <span>{countLabel(project.missions, "mission")}</span>
      {project.needsYou > 0 ? (
        // Amber, never green: this is the count of things that cannot move
        // without a person, which is the one number worth colouring here.
        <span className="missions__project-attention">
          {project.needsYou} need{project.needsYou === 1 ? "s" : ""} you
        </span>
      ) : null}
    </span>
  </button>
);

/**
 * A remembered mission, as a row you can resume.
 *
 * Restated here rather than imported from the inbox modal because this page's
 * row is not the same row: filtered to one project, every repository label
 * would repeat the heading directly above it, so the repository drops out.
 */
const MissionRow = ({
  mission,
  showRepository,
  disabled,
  onResume,
}: {
  mission: RememberedSession;
  showRepository: boolean;
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
      {showRepository ? (
        <span className="inbox__repo">{basename(mission.repositoryPath)}</span>
      ) : null}
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

/**
 * The Missions screen: everything this machine remembers, on one page.
 *
 * It was a modal over a dimmed app, which was backwards — coming back to work
 * already in flight is the ordinary way into Novus, not an interruption of
 * something else. A modal also capped it: projects and missions together do
 * not fit a sheet, and the sheet's own body scrolling meant the page under it
 * was dead space.
 *
 * Projects lead because "which repository" is the first cut a person makes,
 * and a project is a filter rather than a destination — clicking one narrows
 * the missions below instead of pushing a second screen, so the list you were
 * reading stays where it was.
 */
export const MissionsPage = ({
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
  /**
   * Leave the page without resuming anything.
   *
   * Optional because the first screen a host sees IS this page — there is
   * nothing behind it to go back to, and a Close there would be a button that
   * empties the window.
   */
  onClose?: (() => void) | undefined;
}) => {
  const [selected, setSelected] = useState<string | null>(null);

  const projects = useMemo(() => groupProjects(missions), [missions]);

  // A project that no longer has missions cannot stay selected, or the page
  // filters to nothing and offers no way back that is visible on screen.
  const active =
    selected !== null && projects.some((project) => project.path === selected)
      ? selected
      : null;

  const visible = useMemo(
    () =>
      active === null
        ? missions
        : missions.filter((mission) => mission.repositoryPath === active),
    [missions, active],
  );

  const groups = groupMissions(visible);

  const activeProject = projects.find((project) => project.path === active);

  if (missions.length === 0) {
    return (
      <div className="missions">
        <div className="missions__inner">
          <header className="missions__head">
            <h1 className="missions__title">Missions</h1>
          </header>
          {/* An invitation, not a report. There is no count to give and no
              list to describe, so the screen says what to do next and the one
              primary action sits inside it rather than orphaned in the
              header. */}
          <div className="missions__empty">
            <p className="missions__empty-title">Start something</p>
            <p className="missions__empty-hint">
              Point Novus at a repository and give it a goal. Every mission you
              run appears here — with its project, what it changed, and whether
              anyone has checked it.
            </p>
            {error ? <div className="open__error">{error}</div> : null}
            <button
              className="button button--primary button--large"
              type="button"
              disabled={opening}
              onClick={onOpenRepository}
            >
              Open a repository
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    // The page is the scroller. Nothing inside it takes its own scrollbar —
    // a list of missions inside a box inside a page is two things to lose
    // your place in.
    <div className="missions">
      <div className="missions__inner">
        <header className="missions__head">
          <div className="missions__headings">
            <h1 className="missions__title">Missions</h1>
            <p className="missions__subtitle">
              {countLabel(missions.length, "mission")} across{" "}
              {countLabel(projects.length, "project")}, grouped by what each is
              waiting on.
            </p>
          </div>
          <button
            className="button button--primary button--large"
            type="button"
            disabled={opening}
            onClick={onOpenRepository}
          >
            Open a repository
          </button>
        </header>

        {error ? <div className="open__error">{error}</div> : null}

        <section className="missions__section">
          <span className="eyebrow">Projects</span>
          <div className="missions__projects">
            {projects.map((project) => (
              <ProjectCard
                key={project.path}
                project={project}
                selected={project.path === active}
                onSelect={() =>
                  // Clicking the selected project again clears the filter, so
                  // the way out is the same gesture as the way in.
                  setSelected(project.path === active ? null : project.path)
                }
              />
            ))}
          </div>
        </section>

        <section className="missions__section">
          <div className="missions__section-head">
            <span className="eyebrow">
              {activeProject ? `Missions in ${activeProject.name}` : "Missions"}
            </span>
            {activeProject ? (
              <button
                className="button button--quiet"
                type="button"
                onClick={() => setSelected(null)}
              >
                Show all
              </button>
            ) : null}
          </div>
          <div className="missions__list">
            {groups.map((group) => (
              <div className="inbox__group" key={group.attention}>
                <span className="eyebrow">{group.label}</span>
                {group.missions.map((mission) => (
                  <MissionRow
                    key={mission.id}
                    mission={mission}
                    // Under a project heading the repository is already known.
                    showRepository={active === null}
                    disabled={opening}
                    onResume={() => onResume(resumeRequest(mission, capabilities))}
                  />
                ))}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};