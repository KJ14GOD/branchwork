import type { SessionSummary } from "@novus/contracts/protocol";

import type { TabStatus } from "../session-tab.tsx";

/**
 * The frame: who you are, what you can do, and every mission you have open.
 *
 * This replaces a tab strip. A strip could hold about five things before names
 * started truncating, it said nothing about which repository a mission
 * belonged to, and it put the newest thing furthest from where the eye
 * starts — so a person with two repositories open had to read filenames to
 * tell them apart.
 *
 * Missions group under the repository they belong to. That grouping is derived
 * from `repositoryPath`, not stored: a project is not a thing anybody creates
 * in Novus, it is the answer to "which repository is this mission in", and
 * inventing a record for it would be a second place for that fact to live.
 */

const basename = (path: string): string =>
  path.split("/").filter(Boolean).at(-1) ?? path;

/** The dot beside a mission: what it is doing, or what it wants. */
const stateOf = (
  status: TabStatus | undefined,
): { word: string; tone: string } => {
  switch (status?.runStatus) {
    case "working":
    case "running":
      return { word: "Live", tone: "live" };
    case "waiting on you":
      return { word: "You", tone: "needs-you" };
    case "failed":
      return { word: "Failed", tone: "failed" };
    case "paused":
    case "pausing":
      return { word: "Paused", tone: "needs-you" };
    default:
      return { word: "", tone: "idle" };
  }
};

export type SidebarProject = {
  path: string;
  name: string;
  sessions: SessionSummary[];
};

/**
 * Missions grouped by their repository, newest project first.
 *
 * Exported for its test: the grouping is the one piece of logic in this file,
 * and a sidebar that put two missions from one repository under two headings
 * would be worse than the strip it replaces.
 */
export const groupByProject = (
  sessions: readonly SessionSummary[],
): SidebarProject[] => {
  const projects = new Map<string, SidebarProject>();

  for (const session of sessions) {
    const existing = projects.get(session.repositoryPath);

    if (existing) {
      existing.sessions.push(session);
    } else {
      projects.set(session.repositoryPath, {
        path: session.repositoryPath,
        name: basename(session.repositoryPath),
        sessions: [session],
      });
    }
  }

  return [...projects.values()];
};

export const Sidebar = ({
  name,
  sessions,
  joined,
  activeId,
  statuses,
  onSelect,
  onCreate,
  onMissions,
  onSettings,
}: {
  name: string;
  sessions: readonly SessionSummary[];
  joined: readonly { key: string; label: string }[];
  activeId: string | null;
  statuses: Record<string, TabStatus>;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onMissions: () => void;
  onSettings: () => void;
}) => {
  const projects = groupByProject(sessions);

  return (
    <aside className="side">
      <div className="side__user">
        <span className="side__avatar" aria-hidden="true" />
        <span className="side__name">{name}</span>
      </div>

      <div className="side__scroll">
        <nav className="side__nav">
          <button className="side__item" type="button" onClick={onMissions}>
            <span className="side__icon" aria-hidden="true">
              ⌂
            </span>
            Missions
          </button>
          <button className="side__item" type="button" onClick={onCreate}>
            <span className="side__icon" aria-hidden="true">
              +
            </span>
            New mission
          </button>
        </nav>

        {projects.length > 0 ? (
          <>
            <div className="side__section">
              <span className="side__section-title">Projects</span>
              <span className="side__section-actions">
                <button type="button" onClick={onCreate} title="New mission">
                  +
                </button>
              </span>
            </div>

            {projects.map((project) => (
              <div className="side__group" key={project.path}>
                <div className="side__project" title={project.path}>
                  {project.name}
                </div>

                {project.sessions.map((session, index) => {
                  const state = stateOf(statuses[session.id]);

                  return (
                    <button
                      className={
                        session.id === activeId
                          ? "side__workspace side__workspace--active"
                          : "side__workspace"
                      }
                      key={session.id}
                      type="button"
                      // Identity colour by position, so two missions in one
                      // project are told apart the same way two workstreams
                      // are. Provenance only — never a ranking.
                      style={{
                        ["--ws-accent" as string]: `var(--ws-${(index % 4) + 1})`,
                      }}
                      onClick={() => onSelect(session.id)}
                    >
                      <span className="side__workspace-name">
                        {statuses[session.id]?.goal ?? "Untitled mission"}
                      </span>
                      {state.word ? (
                        <span
                          className="side__workspace-meta"
                          data-state={state.tone}
                        >
                          {state.word}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))}
          </>
        ) : null}

        {joined.length > 0 ? (
          <>
            <div className="side__section">
              {/*
                Joined missions are somebody else's, reached through an invite.
                Kept in their own group because the difference matters: they
                are not persisted, and closing the window loses them.
              */}
              <span className="side__section-title">Joined</span>
            </div>
            {joined.map((entry) => (
              <button
                className={
                  entry.key === activeId
                    ? "side__workspace side__workspace--active"
                    : "side__workspace"
                }
                key={entry.key}
                type="button"
                onClick={() => onSelect(entry.key)}
              >
                <span className="side__workspace-name">{entry.label}</span>
              </button>
            ))}
          </>
        ) : null}
      </div>

      <div className="side__foot">
        <span className="side__badge">Local</span>
        <button type="button" onClick={onSettings} title="Setup and providers">
          ⚙
        </button>
      </div>
    </aside>
  );
};
