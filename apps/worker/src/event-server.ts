import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import type { SessionEvent } from "@novus/contracts";
import {
  CreateSessionRequestSchema,
  DecisionRequestSchema,
  SubmitTurnRequestSchema,
} from "@novus/contracts/protocol";
import type { SessionEventStore } from "@novus/session-service";

import { isAllowedOrigin, offeredToken, tokensMatch } from "./access.ts";
import {
  HOST_SESSION,
  roleCan,
  type Capability,
  type Membership,
  type ParticipantRegistry,
} from "./participants.ts";
import { applyDecision } from "./apply-decision.ts";
import { compareAttempts } from "./compare.ts";
import { createRedactor, type Redactor } from "./redaction.ts";
import type { Session, SessionRegistry } from "./session-registry.ts";

const HEARTBEAT_MS = 15_000;

export type EventServerOptions = {
  port?: number;
  host?: string;
  /** Supplied when the server should also accept session and turn commands. */
  sessions?: SessionRegistry;
  /** Defaults to a redactor seeded from the worker's own environment. */
  redactor?: Redactor;
  /**
   * Required on every request except /health.
   *
   * Not optional, and `null` has to be written out. AGENTS.md states the
   * convention for the other boundary — a missing approval gate denies rather
   * than allows — and an `if (token)` check inverted it here: a caller who
   * simply forgot got no gate at all and no warning. The demo server was
   * already that caller.
   */
  token: string | null;
  /**
   * Who holds which token, when the session has more than one person in it.
   *
   * Supplied, every request is attributed to a participant and each route
   * checks a capability rather than mere possession of the host's token.
   * Omitted, the single `token` above is the whole of access control, which is
   * the right shape for a worker nobody has been invited to.
   */
  participants?: ParticipantRegistry;
};

const MAX_BODY_BYTES = 1_000_000;

const readJsonBody = (request: IncomingMessage): Promise<unknown> =>
  new Promise((resolveBody, rejectBody) => {
    let body = "";

    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");

      if (body.length > MAX_BODY_BYTES) {
        rejectBody(new Error("Request body is too large."));
        request.destroy();
      }
    });

    request.on("end", () => {
      try {
        resolveBody(JSON.parse(body || "{}"));
      } catch {
        rejectBody(new Error("Request body is not valid JSON."));
      }
    });

    request.on("error", rejectBody);
  });

const sendJson = (
  response: ServerResponse,
  status: number,
  payload: unknown,
): void => {
  response
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(payload));
};

export type EventServer = {
  url: string;
  close: () => Promise<void>;
};

/**
 * The outbound edge of the worker, and therefore where redaction happens.
 *
 * The store above holds the host's privileged log and keeps it complete. This
 * function writes the copy that reaches a client — today the desktop renderer,
 * next the session service and every guest behind it — so a secret that
 * survives this line has left the machine. Redaction belongs here rather than
 * at `store.append` precisely because the two copies are allowed to differ:
 * see the boundary note at the top of `redaction.ts`.
 */
const writeSse = (
  write: (chunk: string) => void,
  event: SessionEvent,
  redactor: Redactor,
): void => {
  const shareable = redactor.redactEvent(event);

  write(`id: ${event.sequence}\ndata: ${JSON.stringify(shareable)}\n\n`);
};

/**
 * Streams one session's ordered event log over SSE.
 *
 * A client resumes with `?since=<sequence>` and receives the backlog followed
 * by live events. Live events are buffered while the backlog is written so a
 * append landing mid-handshake is delivered in sequence rather than dropped.
 */
const streamSession = (
  store: SessionEventStore,
  sessionId: string,
  since: number,
  write: (chunk: string) => void,
  redactor: Redactor,
): (() => void) => {
  const pending: SessionEvent[] = [];
  let flushed = false;

  const unsubscribe = store.subscribe((event) => {
    if (event.sessionId !== sessionId || event.sequence < since) {
      return;
    }

    if (flushed) {
      writeSse(write, event, redactor);
      return;
    }

    pending.push(event);
  });

  // Deliberately the tolerant read. A single row this build cannot parse — a
  // log written before a contract change — must cost that row, not the worker
  // process, and this runs inside an HTTP handler where a throw is fatal.
  // `since` goes into the SQL rather than a filter here, so a reconnect reads
  // and validates only the rows it is about to send. `unreadable` therefore
  // counts damage at or after `since` — a row this client was never going to
  // receive is not a gap in what it receives.
  const { events: backlog, unreadable } = store.readable(sessionId, since);

  if (unreadable > 0) {
    // A comment line: every SSE client ignores it, and it is visible to anyone
    // reading the stream directly. Silently serving a short log would be worse.
    write(`: ${unreadable} unreadable event(s) skipped\n\n`);
    console.warn(
      `session ${sessionId}: ${unreadable} event(s) could not be parsed and were skipped`,
    );
  }

  for (const event of backlog) {
    writeSse(write, event, redactor);
  }

  let lastSequence = backlog.at(-1)?.sequence ?? since - 1;

  for (const event of pending) {
    if (event.sequence > lastSequence) {
      writeSse(write, event, redactor);
      lastSequence = event.sequence;
    }
  }

  flushed = true;
  pending.length = 0;

  return unsubscribe;
};

export const startEventServer = (
  store: SessionEventStore,
  options: EventServerOptions,
): Promise<EventServer> => {
  // Bound to the loopback interface: the host machine stays the execution
  // authority, and nothing on the network can read a session's event log.
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.NOVUS_PORT ?? 4319);

  const sessions = options.sessions;
  const participants = options.participants;
  const token = options.token;
  // Built once, at startup: the snapshot of secret-looking environment values
  // is taken before any run can add to the environment.
  const redactor = options.redactor ?? createRedactor();

  const describe = (session: Session) => ({
    id: session.id,
    repositoryPath: session.repositoryPath,
    repositoryState: session.repositoryState,
    allowWrites: session.allowWrites,
    allowCommands: session.allowCommands,
    createdAt: session.createdAt,
  });

  const handleCommand = async (
    caller: Membership | null,
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): Promise<boolean> => {
    if (!sessions) {
      return false;
    }

    if (pathname === "/sessions/history" && request.method === "GET") {
      // Everything the log remembers, including sessions this process never
      // opened. Durable history nothing can reach is not really durable.
      sendJson(response, 200, { sessions: sessions.remembered() });

      return true;
    }

    if (pathname === "/sessions" && request.method === "GET") {
      sendJson(response, 200, { sessions: sessions.list().map(describe) });
      return true;
    }

    if (pathname === "/sessions" && request.method === "POST") {
      const parsed = CreateSessionRequestSchema.safeParse(
        await readJsonBody(request),
      );

      if (!parsed.success) {
        sendJson(response, 400, { error: "repositoryPath is required." });
        return true;
      }

      try {
        const session = await sessions.create(parsed.data);
        sendJson(response, 201, describe(session));
      } catch (error) {
        sendJson(response, 400, { error: (error as Error).message });
      }

      return true;
    }

    const forkMatch = /^\/sessions\/([^/]+)\/fork$/.exec(pathname);

    if (forkMatch && request.method === "POST") {
      const session = sessions.get(decodeURIComponent(forkMatch[1]!));

      if (!session) {
        sendJson(response, 404, { error: "No such session." });
        return true;
      }

      const body = (await readJsonBody(request)) as {
        label?: unknown;
        goal?: unknown;
        parentRunId?: unknown;
      };
      const label = typeof body.label === "string" ? body.label.trim() : "";
      const goal = typeof body.goal === "string" ? body.goal.trim() : "";

      if (label === "" || goal === "") {
        sendJson(response, 400, {
          error: "A fork needs a label to tell it apart and a goal to pursue.",
        });
        return true;
      }

      const history = store.list(session.id);
      const parentRunId =
        typeof body.parentRunId === "string"
          ? body.parentRunId
          : history.findLast((event) => event.type === "run.started")?.type ===
              "run.started"
            ? (history.findLast((event) => event.type === "run.started") as
                { payload: { run: { id: string } } }).payload.run.id
            : null;

      if (parentRunId === null) {
        sendJson(response, 409, {
          error: "There is no run to fork from yet. Ask the agent something first.",
        });
        return true;
      }

      try {
        // Checkpoint first, and record it, because a fork is only meaningful
        // against a stated point in the parent's history — and that point has to
        // be in the log before anything is built from it.
        const checkpoint = await session.worktrees.createCheckpoint({
          sessionId: session.id,
          parentRunId,
          parentSequence: history.length - 1,
          agentState: `Forked at sequence ${history.length - 1}`,
          goal,
          model: session.runner.modelSelection(),
          toolPolicy: {
            allowWrites: session.allowWrites,
            allowCommands: session.allowCommands,
          },
        });

        store.append({
          sessionId: session.id,
          actorId: caller?.participant.id ?? "host",
          type: "checkpoint.created",
          payload: { checkpoint },
        });

        const handle = await session.worktrees.createFork(checkpoint, {
          runId: crypto.randomUUID(),
          label,
        });

        session.forks.set(handle.fork.runId, handle);

        store.append({
          sessionId: session.id,
          actorId: caller?.participant.id ?? "host",
          type: "fork.created",
          payload: { fork: handle.fork },
        });

        sendJson(response, 201, { fork: handle.fork });
      } catch (error) {
        // A fork that could not be built is a 409 rather than a 500: the usual
        // causes are a repository with nothing to check out or a name already
        // taken, and both are the caller's to resolve.
        sendJson(response, 409, { error: (error as Error).message });
      }

      return true;
    }

    const compareMatch = /^\/sessions\/([^/]+)\/compare$/.exec(pathname);

    if (compareMatch && request.method === "GET") {
      const session = sessions.get(decodeURIComponent(compareMatch[1]!));

      if (!session) {
        sendJson(response, 404, { error: "No such session." });
        return true;
      }

      const attempts = [...session.forks.values()].map((handle) => ({
        runId: handle.fork.runId,
        label: handle.fork.label,
      }));

      sendJson(response, 200, compareAttempts(session.id, store.list(session.id), attempts));
      return true;
    }

    const decisionMatch = /^\/sessions\/([^/]+)\/decision$/.exec(pathname);

    if (decisionMatch && request.method === "POST") {
      const session = sessions.get(decodeURIComponent(decisionMatch[1]!));

      if (!session) {
        sendJson(response, 404, { error: "No such session." });
        return true;
      }

      const parsed = DecisionRequestSchema.safeParse(await readJsonBody(request));

      if (!parsed.success) {
        sendJson(response, 400, { error: "A runId is required." });
        return true;
      }

      const handle = session.forks.get(parsed.data.runId);

      if (!handle) {
        sendJson(response, 404, {
          error: "That attempt is not a fork of this session, or it was already removed.",
        });
        return true;
      }

      // Recorded regardless of whether the apply below succeeds. V1 says the
      // merge is always a human decision — a host choosing an attempt whose
      // patch no longer applies cleanly still made that choice, and the log
      // should say so rather than staying silent because the mechanics failed.
      const outcome = !session.allowWrites
        ? {
            applied: false as const,
            reason:
              "Writes are not enabled for this session, so the chosen attempt was recorded but not applied.",
            conflicts: [],
          }
        : await applyDecision(session.repositoryPath, session.worktrees, parsed.data.runId).catch(
            (error: unknown) => ({
              applied: false as const,
              reason: (error as Error).message,
              conflicts: [],
            }),
          );

      const event = store.append({
        sessionId: session.id,
        actorId: caller?.participant.id ?? "host",
        type: "decision.recorded",
        payload: {
          runId: handle.fork.runId,
          checkpointId: handle.fork.checkpointId,
          outcome,
        },
      });

      sendJson(response, 201, { decision: event.payload, eventId: event.eventId });
      return true;
    }

    const directionMatch = /^\/sessions\/([^/]+)\/direction$/.exec(pathname);

    if (directionMatch && request.method === "POST") {
      const session = sessions.get(decodeURIComponent(directionMatch[1]!));

      if (!session) {
        sendJson(response, 404, { error: "No such session." });
        return true;
      }

      const parsed = SubmitTurnRequestSchema.safeParse(
        await readJsonBody(request),
      );

      if (!parsed.success) {
        sendJson(response, 400, { error: "A non-empty direction is required." });
        return true;
      }

      // Recorded, not applied. V1 is explicit that a human does not mutate a
      // prompt that is already executing: this enters the log now so everyone
      // sees it was received, and the runtime folds it into the next model turn
      // at a boundary of its own choosing.
      const event = store.append({
        sessionId: session.id,
        actorId: caller?.participant.id ?? "host",
        type: "direction.submitted",
        payload: { runId: session.id, direction: parsed.data.goal },
      });

      sendJson(response, 202, { accepted: true, eventId: event.eventId });
      return true;
    }

    const inviteMatch = /^\/sessions\/([^/]+)\/invite$/.exec(pathname);

    if (inviteMatch && request.method === "POST") {
      const session = sessions.get(decodeURIComponent(inviteMatch[1]!));

      if (!session || !participants) {
        sendJson(response, 404, { error: "No such session." });
        return true;
      }

      const body = (await readJsonBody(request)) as {
        name?: unknown;
        role?: unknown;
      };
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const role = body.role;

      if (name === "" || typeof role !== "string") {
        sendJson(response, 400, { error: "A name and a role are required." });
        return true;
      }

      if (!["editor", "reviewer", "viewer"].includes(role)) {
        // An owner cannot mint a second owner. Ownership moves by handoff,
        // which both parties see; minting one would make two people believe
        // they hold execution authority.
        sendJson(response, 400, {
          error:
            "Invite an editor, reviewer, or viewer. Ownership transfers by handoff, not by invitation.",
        });
        return true;
      }

      const membership = participants.add({
        sessionId: session.id,
        name,
        kind: "human",
        role: role as "editor" | "reviewer" | "viewer",
      });

      store.append({
        sessionId: session.id,
        actorId: caller?.participant.id ?? "host",
        type: "participant.joined",
        payload: { participant: membership.participant },
      });

      // The token is returned exactly once, here. Nothing stores it anywhere it
      // can be read back — a registry that could re-issue a credential would be
      // a way to impersonate whoever holds it.
      sendJson(response, 201, {
        participant: membership.participant,
        token: membership.token,
      });
      return true;
    }

    const turnMatch = /^\/sessions\/([^/]+)\/turns$/.exec(pathname);

    if (turnMatch && request.method === "POST") {
      const session = sessions.get(decodeURIComponent(turnMatch[1]!));

      if (!session) {
        sendJson(response, 404, { error: "No such session." });
        return true;
      }

      const parsed = SubmitTurnRequestSchema.safeParse(
        await readJsonBody(request),
      );

      if (!parsed.success) {
        sendJson(response, 400, { error: "A non-empty goal is required." });
        return true;
      }

      // Accepted, not completed: progress arrives on the event stream.
      void sessions.submitTurn(session, parsed.data.goal);
      sendJson(response, 202, { accepted: true });
      return true;
    }

    return false;
  };

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);

    const origin = request.headers.origin;

    if (!isAllowedOrigin(origin)) {
      // No CORS headers at all, so the browser refuses the response as well.
      response.writeHead(403).end();
      return;
    }

    // Reflected rather than `*`, which is what allows credentials and is only
    // safe because the origin was just checked.
    response.setHeader("Access-Control-Allow-Origin", origin ?? "*");
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }

    // /health is deliberately open: it is how a client discovers the worker is
    // up and what it permits, and it carries nothing about any session.
    let caller: Membership | null = null;

    if (token !== null && url.pathname !== "/health") {
      const offered = offeredToken(request.headers.authorization, url);

      if (!offered) {
        sendJson(response, 401, {
          error:
            "This worker requires an access token. The desktop app supplies it; a guest needs the token from the invite link.",
        });
        return;
      }

      caller = participants?.resolve(offered) ?? null;

      // Falling back to the bare token keeps a worker nobody was invited to
      // working exactly as before. Once there are participants, a token that
      // names one is the only way in — an invite that was revoked stops
      // working rather than degrading to host access.
      if (caller === null && !tokensMatch(token, offered)) {
        sendJson(response, 401, {
          error: "That token does not belong to anyone in this session.",
        });
        return;
      }
    }

    /**
     * Whether the caller may do this, and a 403 with the reason if not.
     *
     * A capability rather than a role name, because the routes should not have
     * opinions about which roles exist — that belongs in one table, so adding a
     * role later does not mean auditing every handler.
     */
    const refusedFor = (capability: Capability): boolean => {
      if (caller === null) {
        return false;
      }

      // An invite is for one session. Nothing checked that, so a viewer invited
      // to watch one repository could act on another simply by knowing its id —
      // the capability check passed because it only ever looked at the role. The
      // host's own participant is exempt: the worker outlives any one session
      // and its owner is the person running it, not a guest of a session.
      const scoped = /^\/sessions\/([^/]+)(?:\/|$)/.exec(url.pathname);
      const target = scoped?.[1] ? decodeURIComponent(scoped[1]) : null;

      if (
        target !== null &&
        caller.participant.sessionId !== HOST_SESSION &&
        caller.participant.sessionId !== target
      ) {
        sendJson(response, 403, {
          error: "That invite is for a different session.",
        });

        return true;
      }

      if (roleCan(caller.participant.role, capability)) {
        return false;
      }

      sendJson(response, 403, {
        error: `A ${caller.participant.role} cannot ${capability} in this session.`,
      });

      return true;
    };

    if (url.pathname === "/health") {
      // Carries the host's permission defaults so a client can seed its own
      // controls instead of guessing and contradicting the environment.
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          status: "ok",
          allowWrites: sessions?.hostDefaults().allowWrites ?? false,
          allowCommands: sessions?.hostDefaults().allowCommands ?? false,
        }),
      );
      return;
    }

    // What each route asks of a caller. Kept as a table beside the routing
    // rather than inside each handler, so the answer to "who can do what" is
    // one thing to read and one thing to change.
    const required: Capability =
      url.pathname === "/events" || request.method === "GET"
        ? "watch"
        : /^\/sessions\/[^/]+\/direction$/.test(url.pathname)
          ? "direct"
          : /^\/sessions\/[^/]+\/invite$/.test(url.pathname)
            ? "invite"
            : "steer";

    if (refusedFor(required)) {
      return;
    }

    if (url.pathname !== "/events") {
      void handleCommand(caller, request, response, url.pathname)
        .then((handled) => {
          if (!handled) {
            response.writeHead(404).end();
          }
        })
        .catch((error: unknown) => {
          sendJson(response, 400, { error: (error as Error).message });
        });

      return;
    }

    const sessionId = url.searchParams.get("session");

    if (!sessionId) {
      response
        .writeHead(400, { "content-type": "application/json" })
        .end(JSON.stringify({ error: "A session query parameter is required." }));
      return;
    }

    // `since` is inclusive. A browser reconnect instead sends Last-Event-ID,
    // which names the last event it already has, so resume after it.
    const sinceParam = url.searchParams.get("since");
    const lastEventId = request.headers["last-event-id"];
    const requested =
      sinceParam !== null
        ? Number(sinceParam)
        : lastEventId !== undefined
          ? Number(lastEventId) + 1
          : 0;
    const since = Number.isFinite(requested)
      ? Math.max(0, Math.trunc(requested))
      : 0;

    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    // Node holds headers until the first body write, and a session with no
    // backlog writes nothing until its first event. Without this a client
    // joining a quiet session is never acknowledged — EventSource does not fire
    // open, and the guest shows "connecting" until the fifteen-second heartbeat
    // flushes the response, which is indistinguishable from a dead worker.
    response.flushHeaders();

    const unsubscribe = streamSession(
      store,
      sessionId,
      since,
      (chunk) => {
        response.write(chunk);
      },
      redactor,
    );

    const heartbeat = setInterval(() => {
      response.write(": heartbeat\n\n");
    }, HEARTBEAT_MS);

    request.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${port} is already in use — another Novus worker is probably still running. Stop it, or set NOVUS_PORT to a free port.`,
          ),
        );
        return;
      }

      reject(error);
    });

    server.listen(port, host, () => {
      // Reported from the socket rather than from the requested port, so
      // port 0 — an ephemeral port, which is what a test wants — still yields
      // a URL that can be connected to.
      const address = server.address();
      const boundPort =
        address !== null && typeof address === "object" ? address.port : port;

      resolve({
        url: `http://${host}:${boundPort}`,
        close: () =>
          new Promise((closed) => {
            server.close(() => closed());
          }),
      });
    });
  });
};
