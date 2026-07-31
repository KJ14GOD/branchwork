import { SessionEventSchema, type SessionEvent } from "@novus/contracts";

import { resolveRelay } from "./endpoint.ts";

/**
 * Reading a session from the relay instead of from the worker.
 *
 * The guest could already watch a live run, but only by talking to the worker
 * directly over loopback — which means a teammate had to be on the host's
 * machine, and "multiplayer" was a second browser window. This is the transport
 * that makes the word honest: the worker publishes outbound to the relay, and a
 * guest anywhere reads from the relay.
 *
 * The rules that made the loopback client trustworthy are kept. Every frame is
 * validated against the contract before it enters state, because a relay is
 * another party's server and a frame it cannot parse is one the timeline would
 * render as a half-known row. Resumption is by sequence, so a reconnect can
 * neither lose an event nor show one twice. And a dropped socket is surfaced
 * rather than silently retried forever, because a stuck state that reads as
 * progress is the one failure this client exists to avoid.
 */

export type RelayConnection = {
  close(): void;
};

export type RelayHandlers = {
  onEvent: (event: SessionEvent) => void;
  onOpen: () => void;
  /** Called with a reason a person can read, not a code. */
  onClosed: (reason: string) => void;
  onRefused: (reason: string) => void;
};

export type RelayRequest = {
  relay: string;
  token: string;
  /** The next sequence this guest has not seen. */
  since: number;
  /** Injected in tests; browsers supply their own. */
  connect?: (url: string) => WebSocket;
};

export const watchRelay = (
  request: RelayRequest,
  handlers: RelayHandlers,
): RelayConnection => {
  const address = resolveRelay(request.relay);

  if (address.kind === "refused") {
    // Refused before anything is contacted, so a crafted invite never reaches
    // a socket at all.
    handlers.onRefused(address.reason);

    return { close: () => {} };
  }

  const open = request.connect ?? ((url: string) => new WebSocket(url));
  let socket: WebSocket | null = null;
  let closed = false;

  const url = `${address.endpoint}/?token=${encodeURIComponent(request.token)}&intent=watch&since=${request.since}`;

  try {
    socket = open(url);
  } catch (cause) {
    handlers.onRefused(
      `Could not open a connection to ${address.endpoint}: ${(cause as Error).message}`,
    );

    return { close: () => {} };
  }

  socket.addEventListener("open", () => {
    if (!closed) {
      handlers.onOpen();
    }
  });

  socket.addEventListener("message", (message) => {
    if (closed) {
      return;
    }

    let payload: unknown;

    try {
      payload = JSON.parse((message as MessageEvent<string>).data);
    } catch {
      // A frame that is not JSON is not an event. Dropping it beats rendering
      // whatever it happened to be.
      return;
    }

    const parsed = SessionEventSchema.safeParse(payload);

    if (!parsed.success) {
      return;
    }

    handlers.onEvent(parsed.data);
  });

  socket.addEventListener("close", () => {
    if (!closed) {
      // The relay refuses an unauthorised connection during the handshake, so
      // a socket that opens and then closes is a relay that went away — not a
      // token problem, and the message should not send someone hunting for one.
      handlers.onClosed(
        "The relay closed the connection. It may have restarted, or the session may have ended.",
      );
    }
  });

  socket.addEventListener("error", () => {
    // `close` follows and owns the reporting. This exists so an error does not
    // surface as an unhandled event.
  });

  return {
    close: () => {
      closed = true;
      socket?.close();
    },
  };
};
