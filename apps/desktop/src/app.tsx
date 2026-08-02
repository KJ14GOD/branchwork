import { useEffect, useRef, useState } from "react";
import type { IpcAuthStatus } from "@novus/contracts";
import { novus } from "./bridge";
import { SetupSurface } from "./screens/setup";
import { MissionsSurface } from "./screens/missions";

export function App() {
  const [auth, setAuth] = useState<IpcAuthStatus | null>(null);
  // Setup shows on first run and persists through the connect flow; a
  // relaunch with a restored session goes straight to Missions.
  const [inSetup, setInSetup] = useState<boolean | null>(null);
  const decided = useRef(false);

  useEffect(() => {
    novus().auth.status().then(setAuth);
    return novus().auth.onChanged(setAuth);
  }, []);

  useEffect(() => {
    if (auth && !decided.current) {
      decided.current = true;
      setInSetup(auth.state !== "signed_in");
    }
    if (auth && auth.state !== "signed_in" && decided.current) setInSetup(true);
  }, [auth]);

  if (!auth || inSetup === null) {
    return <div className="shell" data-testid="booting" />;
  }

  return (
    <div className="shell">
      {auth.state === "signed_in" && !inSetup ? (
        <MissionsSurface user={auth.user} org={auth.org} />
      ) : (
        <SetupSurface auth={auth} onFinished={() => setInSetup(false)} />
      )}
    </div>
  );
}
