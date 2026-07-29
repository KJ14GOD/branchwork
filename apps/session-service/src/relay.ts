import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";

import { WebSocketServer, type WebSocket } from "ws";

import {
  SessionEventSchema,
  type SessionEvent,
} from "@novus/contracts";

/**
 * The thing that makes Novus multiplayer rather than a second window.
 *
 * Until now the guest connected straight to the worker over loopback, which
 * works only because both are on one machine — the whole product claim is that
 * a teammate somewhere else joins a live run. The relay is what stands between
 * them: the worker connects outbound and publishes, guests connect and receive.
 *
 * The worker keeps its own complete log. What crosses this service is the
 * subset it chose to share, already redacted, and the service never asks for
 * the repository. V1 is explicit that source stays on the host.
 */

/** A number the relay assigns; the worker's own sequence is a different thing. */
type RelaySequence = number;

type Publisher = { socket: WebSocket; sessionId: string };
type Subscriber = { socket: WebSocket; sessionId: string };

export type RelayOptions = {
  port?: number;
  host?: string;
  /**
   * Proves a connection may publish to, or watch, a session.
   *
   * Returns the session it is good for, or null. The relay does not mint
   * tokens or know how they were issued — that is the host's business, and it
   * is the host who invites people.
   */
  authorize: (token: string, intent: "publish" | "watch") => string | null;
};

export type Relay = {
  url: string;
  /** Events the relay has accepted, oldest first, for a session. */
  history(sessionId: string): SessionEvent[];
  close(): Promise<void>;
};

const tokensMatch = (expected: string, offered: string): boolean => {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(offered, "utf8");
  const width = Math.max(a.length, b.length, 1);
  const left = Buffer.alloc(width);
  const right = Buffer.alloc(width);

  a.copy(left);
  b.copy(right);

  return timingSafeEqual(left, right) && a.length === b.length;
};

/**
 * A fixed-token authorizer, for tests and single-session hosts.
 *
 * Exported because the alternative is every caller writing the constant-time
 * comparison themselves, and one of them getting it wrong.
 */
export const fixedTokens = (
  sessionId: string,
  publishToken: string,
  watchToken: string,
): RelayOptions["authorize"] =>
  (token, intent) => {
    const expected = intent === "publish" ? publishToken : watchToken;

    return tokensMatch(expected, token) ? sessionId : null;
  };

export const startRelay = (options: RelayOptions): Promise<Relay> => {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;

  // Per session, in arrival order. The relay assigns these, not the worker:
  // V1 says the server assigns sequence numbers and server-confirmed order is
  // canonical. A worker that reconnects and republishes, or two workers on one
  // session, must not be able to decide what order a guest sees.
  const log = new Map<string, SessionEvent[]>();
  const subscribers = new Set<Subscriber>();
  const publishers = new Set<Publisher>();

  const historyFor = (sessionId: string): SessionEvent[] =>
    log.get(sessionId) ?? [];

  const server: Server = createServer((_request, response) => {
    // Nothing but WebSocket lives here. An HTTP GET is a client that has the
    // wrong idea about this service, and saying so beats a hanging socket.
    response.writeHead(426, { "content-type": "text/plain" });
    response.end("This endpoint speaks WebSocket only.\n");
  });

  const sockets = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);
    const token = url.searchParams.get("token") ?? "";
    const intent = url.searchParams.get("intent") === "publish" ? "publish" : "watch";
    const sessionId = options.authorize(token, intent);

    if (sessionId === null) {
      // Refused during the handshake, so an unauthorised client never reaches
      // a state where it can send anything.
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();

      return;
    }

    sockets.handleUpgrade(request, socket, head, (connection) => {
      if (intent === "publish") {
        attachPublisher(connection, sessionId);
      } else {
        attachSubscriber(connection, sessionId, url.searchParams.get("since"));
      }
    });
  });

  const fanOut = (sessionId: string, event: SessionEvent): void => {
    const frame = JSON.stringify(event);

    for (const subscriber of subscribers) {
      if (subscriber.sessionId === sessionId && subscriber.socket.readyState === 1) {
        subscriber.socket.send(frame);
      }
    }
  };

  const attachPublisher = (socket: WebSocket, sessionId: string): void => {
    const publisher: Publisher = { socket, sessionId };
    publishers.add(publisher);

    socket.on("message", (raw) => {
      let payload: unknown;

      try {
        payload = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // The contract is the boundary here as much as anywhere. A worker is
      // trusted to be the host, not trusted to be correct, and an event the
      // relay cannot validate is one a guest would render as a half-known row.
      const parsed = SessionEventSchema.safeParse(payload);

      if (!parsed.success) {
        socket.send(
          JSON.stringify({ error: "rejected", reason: parsed.error.message }),
        );

        return;
      }

      const history = log.get(sessionId) ?? [];

      // Re-sequenced on arrival. The worker's own sequence is meaningful in the
      // worker's log and says nothing about the order this service accepted
      // things in — which is the order every guest must agree on.
      const relayed = SessionEventSchema.parse({
        ...parsed.data,
        sequence: history.length as RelaySequence,
      });

      history.push(relayed);
      log.set(sessionId, history);
      fanOut(sessionId, relayed);
    });

    socket.on("close", () => {
      publishers.delete(publisher);
    });
  };

  const attachSubscriber = (
    socket: WebSocket,
    sessionId: string,
    since: string | null,
  ): void => {
    const subscriber: Subscriber = { socket, sessionId };
    subscribers.add(subscriber);

    // Everything from `since` forward, before any live event is sent. A guest
    // joining late and one present throughout end up holding the same log,
    // which is the property that makes this a shared session rather than two
    // people watching different things.
    const from = Number(since ?? 0);
    const backlog = historyFor(sessionId).filter(
      (event) => event.sequence >= (Number.isFinite(from) ? from : 0),
    );

    for (const event of backlog) {
      socket.send(JSON.stringify(event));
    }

    socket.on("close", () => {
      subscribers.delete(subscriber);
    });
  };

  return new Promise((settle, fail) => {
    server.once("error", fail);
    server.listen(port, host, () => {
      const address = server.address();
      const bound = typeof address === "object" && address ? address.port : port;

      settle({
        url: `ws://${host}:${bound}`,
        history: historyFor,
        close: () =>
          new Promise((done) => {
            for (const subscriber of subscribers) {
              subscriber.socket.close();
            }
            for (const publisher of publishers) {
              publisher.socket.close();
            }
            sockets.close(() => {
              server.close(() => done());
            });
          }),
      });
    });
  });
};
