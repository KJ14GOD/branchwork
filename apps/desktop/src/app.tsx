import { useEffect, useRef, useState } from "react";
import type { IpcAuthStatus } from "@novus/contracts";
import { novus } from "./bridge";
import { seedFace } from "./components/identity";
import { SetupSurface } from "./screens/setup";
import { ProjectShell } from "./screens/project-shell";

export function App() {
  const [auth, setAuth] = useState<IpcAuthStatus | null>(null);
  // Setup shows on first run and persists through the connect flow; a
  // relaunch with a restored session goes straight to Missions.
  const [inSetup, setInSetup] = useState<boolean | null>(null);
  const decided = useRef(false);

  // The status carries the signed-in person's picture (D-105); it lands in the
  // identity cache before anything renders it, so no mark starts as initials
  // and turns into a face.
  const take = (status: IpcAuthStatus) => {
    if (status.state === "signed_in") seedFace(status.user.login, status.avatar);
    setAuth(status);
  };

  useEffect(() => {
    novus().auth.status().then(take);
    return novus().auth.onChanged(take);
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
        <ProjectShell user={auth.user} org={auth.org} />
      ) : (
        <SetupSurface auth={auth} onFinished={() => setInSetup(false)} />
      )}
    </div>
  );
}
