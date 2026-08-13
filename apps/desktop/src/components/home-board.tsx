import type { Mission } from "@novus/contracts";
import { agoLabel } from "../format";
import { boardColumns, type BoardColumnId } from "./derive";

/**
 * The Home board (D-120): every active mission, grouped by what it needs —
 * Needs you first, because that is the reason a person opens Home — then
 * Running, Waiting, Decided. The columns are computed and only computed:
 * there is no drag, no rank, and no card action beyond opening the mission
 * at the thing that is asking. Cards carry facts the list already states —
 * the goal, the repository, when it last said anything, where the attention
 * or the work is, what the work has touched (churn, as text arithmetic, the
 * diff's own grammar), the checks at the current heads, and the baton where
 * it is one fact. Words, never dots; a column with nothing says so in one
 * quiet line.
 */

const ATTENTION_WORDS: Partial<Record<Mission["primaryState"], string>> = {
  needs_approval: "waiting for an approval",
  needs_direction: "waiting for direction",
  workspace_failed: "workspace failed",
  verification_failed: "checks failed",
  execution_interrupted: "interrupted"
};

const RUNNING_WORDS: Partial<Record<Mission["primaryState"], string>> = {
  provisioning_workspace: "setting up the workspace",
  agent_starting: "starting",
  agent_running: "working",
  agent_stopping: "stopping"
};

/** Where the state is, in words — the card's one colored line. */
export function boardCardLine(mission: Mission): { text: string; tone: "warn" | "quiet" } | null {
  const attention = ATTENTION_WORDS[mission.primaryState];
  if (attention) {
    return { text: withPlace(attention, mission.attention, mission.workstreamCount), tone: "warn" };
  }
  const running = RUNNING_WORDS[mission.primaryState];
  if (running) {
    return { text: withPlace(running, mission.working, mission.workstreamCount), tone: "quiet" };
  }
  if (mission.primaryState === "decision_recorded") {
    return { text: "decision recorded — not published yet", tone: "quiet" };
  }
  if (mission.primaryState === "pull_request_open") {
    return { text: "pull request open", tone: "quiet" };
  }
  return null;
}

function withPlace(
  words: string,
  place: Mission["attention"],
  workstreamCount: number
): string {
  if (!place) return words;
  const parts = [
    ...(workstreamCount > 1 ? [place.workstreamName] : []),
    ...(place.sessionTitle ? [`“${place.sessionTitle}”`] : [])
  ];
  return parts.length > 0 ? `${words} — ${parts.join(" · ")}` : words;
}

export function HomeBoard({
  missions,
  now,
  onOpen
}: {
  missions: Mission[];
  /** Passed in so the render is pure and the specs deterministic. */
  now: number;
  onOpen: (mission: Mission, column: BoardColumnId) => void;
}) {
  const columns = boardColumns(missions);
  return (
    <div className="home-board" data-testid="home-board">
      {columns.map((column) => (
        <section className="board-column" key={column.id} data-testid={`board-column-${column.id}`}>
          <h2 className="board-column-head">
            {column.label}
            <span className="board-column-count">{column.missions.length}</span>
          </h2>
          <div className="board-column-scroll">
            {column.missions.length === 0 && <p className="board-empty">{column.empty}</p>}
            {column.missions.map((mission) => {
              const line = boardCardLine(mission);
              const facts = [
                ...(mission.checks
                  ? [`${mission.checks.passed}/${mission.checks.total} checks passed`]
                  : []),
                ...(mission.workstreamCount > 1 ? [`${mission.workstreamCount} approaches`] : []),
                ...(mission.controllerLogin ? [`${mission.controllerLogin} has the baton`] : [])
              ];
              return (
                <button
                  className="board-card"
                  key={mission.missionId}
                  onClick={() => onOpen(mission, column.id)}
                  title={`Open ${mission.goal}`}
                  data-testid="board-card"
                  data-mission={mission.missionId}
                  data-column={column.id}
                >
                  <span className="board-card-goal">{mission.goal}</span>
                  <span className="board-card-meta">
                    <span className="board-card-repo">
                      {mission.repository?.name ?? "no repository"}
                    </span>
                    {mission.lastActivityAt && (
                      <span className="board-card-when">
                        {agoLabel(mission.lastActivityAt, now)}
                      </span>
                    )}
                  </span>
                  {line && (
                    <span
                      className={
                        line.tone === "warn" ? "board-card-line tone-warn" : "board-card-line"
                      }
                    >
                      {line.text}
                    </span>
                  )}
                  {mission.churn && (
                    <span className="board-card-churn mono">
                      {mission.churn.filesChanged}{" "}
                      {mission.churn.filesChanged === 1 ? "file" : "files"}{" "}
                      <span className="tone-ok">+{mission.churn.additions.toLocaleString()}</span>{" "}
                      <span className="tone-danger">
                        −{mission.churn.deletions.toLocaleString()}
                      </span>
                    </span>
                  )}
                  {facts.length > 0 && <span className="board-card-facts">{facts.join(" · ")}</span>}
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
