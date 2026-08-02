import { useEffect, useState } from "react";
import type { IpcAuthStatus } from "@novus/contracts";
import { novus } from "./bridge";
import { SignIn } from "./screens/sign-in";
import { MissionsSurface } from "./screens/missions";

export function App() {
  const [auth, setAuth] = useState<IpcAuthStatus | null>(null);

  useEffect(() => {
    novus().auth.status().then(setAuth);
    return novus().auth.onChanged(setAuth);
  }, []);

  if (!auth) {
    return <div className="shell" data-testid="booting" />;
  }

  return (
    <div className="shell">
      {auth.state === "signed_in" ? (
        <MissionsSurface user={auth.user} org={auth.org} />
      ) : (
        <SignIn auth={auth} />
      )}
    </div>
  );
}
