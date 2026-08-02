import { useCallback, useEffect, useState } from "react";
import type { Mission, MissionDetailResponse, Organization, User } from "@novus/contracts";
import { novus } from "../bridge";
import { CreateMissionDialog } from "./create-mission";
import { MissionView } from "./mission-view";

type LoadState =
  | { kind: "loading" }
  | { kind: "offline"; stale: Mission[] } // last-known rows stay readable (DESIGN offline rule)
  | { kind: "loaded"; missions: Mission[] };

function relativeTime(iso: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

const STATE_LABELS: Record<Mission["primaryState"], string> = {
  new_mission: "New mission"
};

export function MissionsSurface({ user, org }: { user: User; org: Organization }) {
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<MissionDetailResponse | null>(null);

  const refresh = useCallback(async () => {
    const result = await novus().missions.list();
    if (result.ok) setLoad({ kind: "loaded", missions: result.value });
    else if (result.code === "offline") {
      setLoad((prev) => ({
        kind: "offline",
        stale: prev.kind === "loaded" ? prev.missions : prev.kind === "offline" ? prev.stale : []
      }));
    }
    else setLoad({ kind: "loaded", missions: [] });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (load.kind !== "offline") return;
    const timer = setInterval(refresh, 4000);
    return () => clearInterval(timer);
  }, [load.kind, refresh]);

  const openMission = async (missionId: string) => {
    const result = await novus().missions.get(missionId);
    if (result.ok) setOpen(result.value);
  };

  if (open) {
    return <MissionView detail={open} onBack={() => { setOpen(null); refresh(); }} />;
  }

  return (
    <>
      <header className="topbar">
        <span className="brand">Novus</span>
        <span className="spacer" />
        <span className="identity-mark" title={`${user.login} · ${org.name}`}>
          {user.login.slice(0, 2)}
        </span>
        <button className="btn btn-text" onClick={() => novus().auth.signOut()}>
          Sign out
        </button>
      </header>
      <main className="content">
        {load.kind === "offline" && (
          <div className="notice-bar" data-testid="offline" aria-live="polite">
            <span className="status-dot warn" />
            Can&apos;t reach Novus — retrying.
          </div>
        )}
        <div className="missions" data-testid="missions">
          <div className="missions-head">
            <h1>Missions</h1>
            <span className="spacer" />
            {load.kind === "loaded" && load.missions.length > 0 && (
              <button className="btn btn-primary" onClick={() => setCreating(true)} data-testid="new-mission">
                New mission
              </button>
            )}
          </div>

          {load.kind === "loading" && (
            <div data-testid="loading">
              <div className="placeholder-block" />
              <div className="placeholder-block" />
              <div className="placeholder-block" />
            </div>
          )}

          {load.kind === "loaded" && load.missions.length === 0 && (
            <div className="empty" data-testid="empty">
              <p>No missions yet. Start one when you have work worth doing together.</p>
              <button className="btn btn-primary" onClick={() => setCreating(true)} data-testid="new-mission">
                New mission
              </button>
            </div>
          )}

          {(load.kind === "loaded" ? load.missions : load.kind === "offline" ? load.stale : []).length > 0 && (
            <div className="scroll">
              <div className="group-label">Waiting</div>
              {(load.kind === "loaded" ? load.missions : load.kind === "offline" ? load.stale : []).map(
                (mission) => (
                  <button
                    key={mission.missionId}
                    className="row"
                    onClick={() => openMission(mission.missionId)}
                    disabled={load.kind === "offline"}
                    data-testid="mission-row"
                  >
                    <span className="status-dot neutral" />
                    <span>{mission.goal}</span>
                    {mission.repository && (
                      <span className="row-repo" data-testid="row-repo">{mission.repository.name}</span>
                    )}
                    <span className="row-meta">{STATE_LABELS[mission.primaryState]}</span>
                    <span className="spacer" style={{ flex: 1 }} />
                    <span className="row-meta">{relativeTime(mission.createdAt)}</span>
                  </button>
                )
              )}
            </div>
          )}
        </div>
      </main>
      {creating && (
        <CreateMissionDialog
          onClose={() => setCreating(false)}
          onCreated={(mission) => {
            setCreating(false);
            refresh();
            openMission(mission.missionId);
          }}
        />
      )}
    </>
  );
}
