import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import type { SessionEvent } from "@novus/contracts";
import {
  CreateSessionRequestSchema,
  SubmitTurnRequestSchema,
} from "@novus/contracts/protocol";
import type { InMemorySessionEventStore } from "@novus/session-service";

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
  store: InMemorySessionEventStore,
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
  const { events, unreadable } = store.readable(sessionId);
  const backlog = events.filter((event) => event.sequence >= since);

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
  store: InMemorySessionEventStore,
  options: EventServerOptions = {},
): Promise<EventServer> => {
  // Bound to the loopback interface: the host machine stays the execution
  // authority, and nothing on the network can read a session's event log.
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.NOVUS_PORT ?? 4319);

  const sessions = options.sessions;
  // Built once, at startup: the snapshot of secret-looking environment values
  // is taken before any run can add to the environment.
  const redactor = options.redactor ?? createRedactor();

  const describe = (session: Session) => ({
    id: session.id,
    repositoryPath: session.repositoryPath,
    allowWrites: session.allowWrites,
    allowCommands: session.allowCommands,
    createdAt: session.createdAt,
  });

  const handleCommand = async (
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): Promise<boolean> => {
    if (!sessions) {
      return false;
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

    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "content-type");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }

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

    if (url.pathname !== "/events") {
      void handleCommand(request, response, url.pathname)
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
