import { createServer } from "node:net";

/**
 * What this launch of the desktop app is for, decided before any window
 * exists and testable without Electron.
 *
 * Hosting is the default and is exactly what the app always did: spawn the
 * worker, wait for it, own a repository. Joining is the other thing a Novus
 * window can now be — a teammate's window onto someone else's session — and
 * a joining launch must not start a worker: it has no repository for one,
 * and a second worker on the standard port is the collision that already
 * bites anyone running two copies on one machine.
 *
 * The mode is carried by the launch itself (`--join` or NOVUS_JOIN) rather
 * than asked in the UI, so a single-player start never sees a mode picker.
 * A normally-launched (hosting) window can still *open* an invite — joining
 * a session from there uses the invite's transport and never touches the
 * local worker — but only a join launch skips the worker entirely.
 */
export type LaunchPlan =
  | { mode: "host"; spawnWorker: true }
  | { mode: "join"; spawnWorker: false; invite: string | null };

const JOIN_FLAG = "--join";

export const launchPlan = (
  argv: readonly string[],
  env: Record<string, string | undefined>,
): LaunchPlan => {
  for (const argument of argv) {
    if (argument === JOIN_FLAG) {
      return { mode: "join", spawnWorker: false, invite: null };
    }

    if (argument.startsWith(`${JOIN_FLAG}=`)) {
      const invite = argument.slice(JOIN_FLAG.length + 1).trim();

      return { mode: "join", spawnWorker: false, invite: invite || null };
    }
  }

  const joinEnv = env.NOVUS_JOIN?.trim();

  if (joinEnv) {
    // "1" (or any bare switch value) means join with nothing prefilled;
    // anything longer is treated as the invite link itself, so
    // NOVUS_JOIN="http://…?session=…&token=…" is a one-variable join.
    return {
      mode: "join",
      spawnWorker: false,
      invite: joinEnv === "1" || joinEnv.toLowerCase() === "true" ? null : joinEnv,
    };
  }

  return { mode: "host", spawnWorker: true };
};

export type PortChoice =
  | { kind: "ok"; port: number; fallback: boolean }
  /** Nothing was started. `reason` is written for an error dialog. */
  | { kind: "refused"; reason: string };

/**
 * Binds to the port briefly to learn whether the worker could. Returns the
 * bound port (which matters when asked for port 0) or null when it cannot
 * be taken. Injected in tests.
 */
export const probePort = (port: number): Promise<number | null> =>
  new Promise((settle) => {
    const server = createServer();

    server.once("error", () => settle(null));
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const bound =
        address !== null && typeof address === "object" ? address.port : null;

      server.close(() => settle(bound));
    });
  });

/**
 * The port the worker should be started on.
 *
 * The standard port being taken almost always means another Novus is already
 * running on this machine — which is exactly the situation a second person
 * joining a session on one machine creates. Before this, the second app
 * spawned its worker into EADDRINUSE, then health-checked the *first* app's
 * worker (which answered), and the renderer spent the session collecting
 * 401s for a token that belonged to nobody there. So: an explicitly pinned
 * port that is taken refuses loudly, and the default port being taken falls
 * back to a free one — the renderer learns the real URL over IPC and never
 * cared which port it was.
 *
 * The probe closes before the worker binds, so another process can win the
 * port in between. That race loses nothing that was working: the worker
 * then fails with its own EADDRINUSE message, same as before this existed.
 */
export const choosePort = async (
  preferred: number,
  pinned: boolean,
  probe: (port: number) => Promise<number | null> = probePort,
): Promise<PortChoice> => {
  if ((await probe(preferred)) !== null) {
    return { kind: "ok", port: preferred, fallback: false };
  }

  if (pinned) {
    return {
      kind: "refused",
      reason: `Port ${preferred} is already in use and NOVUS_PORT pins the worker to it. Stop whatever is listening there, or unset NOVUS_PORT to let Novus pick a free port.`,
    };
  }

  const fallback = await probe(0);

  if (fallback === null) {
    return {
      kind: "refused",
      reason: `Port ${preferred} is already in use and no free port could be found.`,
    };
  }

  return { kind: "ok", port: fallback, fallback: true };
};
