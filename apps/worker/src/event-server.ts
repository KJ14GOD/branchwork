import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import type { SessionEvent } from "@novus/contracts";
import type { Authority } from "@novus/contracts/protocol";
import {
  CancelRunRequestSchema,
  ControlRequestSchema,
  CreateSessionRequestSchema,
  DecisionRequestSchema,
  HandoffAnswerSchema,
  HandoffRequestSchema,
  PauseRunRequestSchema,
  ResumeRunRequestSchema,
  SubmitTurnRequestSchema,
} from "@novus/contracts/protocol";
import type { SessionEventStore } from "@novus/session-service";

import { isAllowedOrigin, offeredToken, tokensMatch } from "./access.ts";
import {
  HOST_SESSION,
  refuseControlOffer,
  refuseHandoffAnswer,
  roleCan,
  type Capability,
  type Membership,
  type ParticipantRegistry,
} from "./participants.ts";
import { applyDecision } from "./apply-decision.ts";
import { compareAttempts } from "./compare.ts";
import { projectSession } from "./projection.ts";
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
  // How many open SSE streams each participant currently holds, keyed by
  // participant id. In memory only, like the tokens in `participants.ts` — a
  // presence claim that outlived this process would be a lie the moment the
  // worker restarted with nobody connected.
  const liveConnections = new Map<string, number>();

  const describe = (session: Session) => ({
    id: session.id,
    repositoryPath: session.repositoryPath,
    repositoryState: session.repositoryState,
    allowWrites: session.allowWrites,
    allowCommands: session.allowCommands,
    createdAt: session.createdAt,
  });

  /**
   * What the log says about a session, folded once and read by every route
   * that needs to know who holds control.
   *
   * The fold is the only description of authority. Routes deliberately do not
   * keep their own copy of who is holding what: a second structure beside the
   * log is how the timeline and the baton end up disagreeing, and the timeline
   * is the thing a participant is being asked to trust.
   */
  const projectionOf = (sessionId: string) =>
    projectSession(sessionId, store.list(sessionId));

  /**
   * Run ids belonging to forked attempts rather than to the session's own run.
   *
   * Needed because a fork is visible in the parent's log — its events land
   * there so the timeline and /compare can see them — but it is not the run a
   * direction reaches. `AgentRunner` refuses to drain direction inside a forked
   * attempt (an attempt's goal is frozen at its checkpoint), so queueing a
   * direction against a fork would promise something the runner will not do.
   */
  const forkRunIds = (sessionId: string): Set<string> =>
    new Set(
      store
        .list(sessionId)
        .flatMap((event) =>
          event.type === "fork.created" ? [event.payload.fork.runId] : [],
        ),
    );

  /**
   * The session's own executing run, if one is executing — the run a direction
   * submitted right now would be folded into at its next turn boundary.
   */
  const directionTargetRun = (sessionId: string): string | null => {
    const forks = forkRunIds(sessionId);
    const running = projectionOf(sessionId).runs.find(
      (run) => run.status === "running" && !forks.has(run.runId),
    );

    return running?.runId ?? null;
  };

  /**
   * Whether anything at all is executing in this session, forks included.
   *
   * Stricter than `directionTargetRun` on purpose, and the difference is not an
   * oversight. Direction asks "which run will read this", which only the
   * session's own run can answer. Control asks "is it safe to change who is
   * responsible", and handing the baton to somebody while an attempt of theirs
   * is mid-flight makes them accountable for an execution they never watched
   * start. So a running attempt holds the transfer too.
   */
  const executingRunIds = (sessionId: string): string[] =>
    projectionOf(sessionId)
      .runs.filter((run) => run.status === "running")
      .map((run) => run.runId);

  /**
   * Moves control if an accepted handoff is waiting and nothing is executing.
   *
   * This is the last of the six steps STEERING §10 names — offer, receive,
   * accept, safe boundary, transfer, recorded — and the only one that is not
   * triggered by somebody clicking. It runs both from the acceptance itself
   * (the common case: nothing was running, so the boundary is now) and from
   * every run ending, which is what makes "control transfers at the next safe
   * boundary" a promise the worker keeps rather than a label the UI shows.
   *
   * Returns the transfer event, or null when there was nothing to settle.
   */
  const settleAcceptedHandoff = (sessionId: string) => {
    if (!participants) {
      return null;
    }

    const offer = projectionOf(sessionId).controlOffer;

    if (offer === null || offer.state !== "accepted") {
      return null;
    }

    if (executingRunIds(sessionId).length > 0) {
      return null;
    }

    const moved = participants.transferOwnership(
      offer.fromParticipantId,
      offer.toParticipantId,
    );

    if (!moved) {
      // The offerer is no longer able to give what they offered — they were
      // removed, or control moved elsewhere while this offer sat accepted.
      // Withdrawn rather than left pending: an offer that can never be
      // honoured has to stop being displayed as one, and the alternative is a
      // session that shows "control transfers at the next safe boundary"
      // forever while every boundary passes.
      return store.append({
        sessionId,
        actorId: offer.fromParticipantId,
        type: "control.withdrawn",
        payload: {
          offerEventId: offer.offerEventId,
          participantId: offer.fromParticipantId,
        },
      });
    }

    return store.append({
      sessionId,
      actorId: offer.fromParticipantId,
      type: "control.transferred",
      payload: {
        fromParticipantId: offer.fromParticipantId,
        toParticipantId: offer.toParticipantId,
        acceptedAt: offer.acceptedAt ?? new Date().toISOString(),
        offerEventId: offer.offerEventId,
      },
    });
  };

  const handleCommand = async (
    caller: Membership | null,
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): Promise<boolean> => {
    if (!sessions) {
      return false;
    }

    // An invited participant, as opposed to the host or a bare-token caller.
    // The distinction hosting vs joining rests on: an invite is a credential
    // *for one session*, and holding one must not confer anything about the
    // host's machine beyond that session. The capability table alone cannot
    // say this — an editor legitimately holds "steer" — so the two routes
    // that are about the host rather than about a session check it here.
    const invited =
      caller !== null && caller.participant.sessionId !== HOST_SESSION;

    if (pathname === "/sessions/history" && request.method === "GET") {
      if (invited) {
        // The log remembers every repository this worker ever opened. An
        // invite is scoped to one session; the host's whole history is not
        // part of what it grants.
        sendJson(response, 403, {
          error: "An invited participant cannot read the host's session history.",
        });
        return true;
      }

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
      if (invited) {
        // Opening a session names a path on the host's filesystem and starts
        // an agent against it. That is what *hosting* means, and no invited
        // role includes it — an editor's "steer" is authority over the run
        // they were invited to, not over the host's machine.
        sendJson(response, 403, {
          error:
            "Only the host can open a repository. An invite joins the session it names; it does not open new ones.",
        });
        return true;
      }

      const parsed = CreateSessionRequestSchema.safeParse(
        await readJsonBody(request),
      );

      if (!parsed.success) {
        sendJson(response, 400, { error: "repositoryPath is required." });
        return true;
      }

      try {
        const session = await sessions.create(parsed.data);

        // The host joins their own session, in the log, like anybody else.
        //
        // Without this the host held control by implication — they were the
        // owner in the registry and nobody else was, so every route behaved as
        // though they were in charge while the log said control was held by
        // nobody. That is precisely the silent inheritance the handoff
        // lifecycle exists to end: the fold's rule is that the first owner to
        // appear holds control, and the host never appeared. A baton that only
        // becomes visible once it is handed away was never explicit to begin
        // with.
        //
        // Guarded on the caller resolving to a membership so a worker with no
        // participant registry — the single-user path, where there is nobody
        // to attribute anything to — behaves exactly as it did.
        if (participants && caller) {
          store.append({
            sessionId: session.id,
            actorId: caller.participant.id,
            type: "participant.joined",
            payload: { participant: caller.participant },
          });
        }

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

        store.append({
          sessionId: session.id,
          actorId: caller?.participant.id ?? "host",
          type: "fork.created",
          payload: { fork: handle.fork },
        });

        // The attempt actually runs. This call is what a fork *is* — a child
        // run executing the goal in the isolated worktree just cut — and it
        // was missing entirely: a fork used to be a directory with a label,
        // and the compare screen compared work that never happened. Accepted
        // rather than awaited, the same contract as /turns: the 201 says the
        // attempt exists and has begun, and its progress arrives on the event
        // stream under its own run id.
        void sessions.startForkRun(session, handle, goal);

        sendJson(response, 201, { fork: handle.fork });
      } catch (error) {
        // A fork that could not be built is a 409 rather than a 500: the usual
        // causes are a repository with nothing to check out or a name already
        // taken, and both are the caller's to resolve.
        sendJson(response, 409, { error: (error as Error).message });
      }

      return true;
    }

    const cancelMatch = /^\/sessions\/([^/]+)\/cancel$/.exec(pathname);

    if (cancelMatch && request.method === "POST") {
      const session = sessions.get(decodeURIComponent(cancelMatch[1]!));

      if (!session) {
        sendJson(response, 404, { error: "No such session." });
        return true;
      }

      const parsed = CancelRunRequestSchema.safeParse(await readJsonBody(request));

      if (!parsed.success) {
        sendJson(response, 400, { error: "A runId is required." });
        return true;
      }

      const history = store.list(session.id);
      const started = history.find(
        (event) =>
          event.type === "run.started" && event.payload.run.id === parsed.data.runId,
      );
      const terminator = history.find(
        (event) =>
          (event.type === "run.completed" ||
            event.type === "run.failed" ||
            event.type === "run.cancelled") &&
          event.payload.runId === parsed.data.runId,
      );

      if (!started || terminator) {
        sendJson(response, 409, {
          error: "There is no run in progress with that id.",
        });
        return true;
      }

      // Recorded, not applied. Same as direction: a human needs to see the
      // request was received before it takes effect, and only the run loop
      // itself — reading this same event back — can say when it actually
      // stopped.
      const event = store.append({
        sessionId: session.id,
        actorId: caller?.participant.id ?? "host",
        type: "run.cancel_requested",
        payload: { runId: parsed.data.runId },
      });

      sendJson(response, 202, { accepted: true, eventId: event.eventId });
      return true;
    }

    // Where a run's pause state currently stands, from the log — the same
    // "most recent of the three wins" rule `AgentRunner.pauseRequested` uses,
    // duplicated here because the route has to refuse a redundant pause or an
    // unwarranted resume before it ever reaches the run loop.
    const latestPauseState = (
      history: SessionEvent[],
      runId: string,
    ): "requested" | "paused" | "resumed" | "none" => {
      const latest = history
        .filter(
          (event) =>
            (event.type === "run.pause_requested" ||
              event.type === "run.paused" ||
              event.type === "run.resumed") &&
            event.payload.runId === runId,
        )
        .sort((first, second) => first.sequence - second.sequence)
        .at(-1);

      return latest?.type === "run.pause_requested"
        ? "requested"
        : latest?.type === "run.paused"
          ? "paused"
          : latest?.type === "run.resumed"
            ? "resumed"
            : "none";
    };

    const pauseMatch = /^\/sessions\/([^/]+)\/pause$/.exec(pathname);

    if (pauseMatch && request.method === "POST") {
      const session = sessions.get(decodeURIComponent(pauseMatch[1]!));

      if (!session) {
        sendJson(response, 404, { error: "No such session." });
        return true;
      }

      const parsed = PauseRunRequestSchema.safeParse(await readJsonBody(request));

      if (!parsed.success) {
        sendJson(response, 400, { error: "A runId is required." });
        return true;
      }

      const history = store.list(session.id);
      const started = history.find(
        (event) =>
          event.type === "run.started" && event.payload.run.id === parsed.data.runId,
      );
      const terminator = history.find(
        (event) =>
          (event.type === "run.completed" ||
            event.type === "run.failed" ||
            event.type === "run.cancelled") &&
          event.payload.runId === parsed.data.runId,
      );

      if (!started || terminator) {
        sendJson(response, 409, {
          error: "There is no run in progress with that id.",
        });
        return true;
      }

      const state = latestPauseState(history, parsed.data.runId);

      if (state === "requested" || state === "paused") {
        sendJson(response, 409, {
          error: "This run is already paused, or a pause is already pending.",
        });
        return true;
      }

      // Recorded, not applied — same as cancel: the run loop itself notices
      // this on its next turn boundary and is what actually stops.
      const event = store.append({
        sessionId: session.id,
        actorId: caller?.participant.id ?? "host",
        type: "run.pause_requested",
        payload: { runId: parsed.data.runId },
      });

      sendJson(response, 202, { accepted: true, eventId: event.eventId });
      return true;
    }

    const resumeMatch = /^\/sessions\/([^/]+)\/resume$/.exec(pathname);

    if (resumeMatch && request.method === "POST") {
      const session = sessions.get(decodeURIComponent(resumeMatch[1]!));

      if (!session) {
        sendJson(response, 404, { error: "No such session." });
        return true;
      }

      const parsed = ResumeRunRequestSchema.safeParse(await readJsonBody(request));

      if (!parsed.success) {
        sendJson(response, 400, { error: "A runId is required." });
        return true;
      }

      const history = store.list(session.id);

      if (latestPauseState(history, parsed.data.runId) !== "paused") {
        sendJson(response, 409, { error: "That run is not paused." });
        return true;
      }

      // Unlike pause, resume has to actively restart the run loop — pausing
      // is a request the live loop notices on its own; resuming picks a loop
      // back up that already exited.
      void sessions.resumeTurn(session, parsed.data.runId);
      sendJson(response, 202, { accepted: true });
      return true;
    }

    const controlRequestMatch = /^\/sessions\/([^/]+)\/control\/request$/.exec(
      pathname,
    );

    if (controlRequestMatch && request.method === "POST") {
      const session = sessions.get(
        decodeURIComponent(controlRequestMatch[1]!),
      );

      if (!session) {
        sendJson(response, 404, { error: "No such session." });
        return true;
      }

      const parsed = ControlRequestSchema.safeParse(await readJsonBody(request));

      if (!parsed.success) {
        sendJson(response, 400, { error: "Invalid request body." });
        return true;
      }

      const event = store.append({
        sessionId: session.id,
        actorId: caller?.participant.id ?? "host",
        type: "control.requested",
        payload: {
          participantId: caller?.participant.id ?? "host",
          ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
        },
      });

      sendJson(response, 202, { accepted: true, eventId: event.eventId });
      return true;
    }

    const handoffMatch = /^\/sessions\/([^/]+)\/handoff$/.exec(pathname);

    if (handoffMatch && request.method === "POST") {
      const session = sessions.get(decodeURIComponent(handoffMatch[1]!));

      if (!session || !participants) {
        sendJson(response, 404, { error: "No such session." });
        return true;
      }

      const parsed = HandoffRequestSchema.safeParse(await readJsonBody(request));

      if (!parsed.success) {
        sendJson(response, 400, { error: "A toParticipantId is required." });
        return true;
      }

      // Unlike `actorId` elsewhere, this cannot fall back to a bare "host"
      // label: `transferOwnership` looks the id up in the registry, and
      // HOST_SESSION names a sentinel *session*, not a participant. A caller
      // who did not resolve to a real membership has nothing to hand off
      // from, full stop — the host's own participant is always resolvable
      // here because it is registered under its own token like anyone else's.
      if (!caller) {
        sendJson(response, 401, {
          error: "The caller could not be identified for a handoff.",
        });
        return true;
      }

      const fromId = caller.participant.id;
      const target = participants.byId(parsed.data.toParticipantId);

      // The host's own participant is registered under HOST_SESSION rather
      // than this session's id — the worker outlives any one session — so it
      // counts as being in the room the same way /presence already treats it.
      const inRoom =
        target !== null &&
        (target.participant.sessionId === session.id ||
          target.participant.sessionId === HOST_SESSION);

      if (!inRoom) {
        sendJson(response, 404, {
          error: "That participant is not in this session.",
        });
        return true;
      }

      const refusal = refuseControlOffer(
        projectionOf(session.id),
        fromId,
        parsed.data.toParticipantId,
      );

      if (refusal) {
        sendJson(response, refusal.status, { error: refusal.error });
        return true;
      }

      // An offer, and nothing more. Control does not move here, the registry
      // is not touched, and the recipient's role is unchanged — this route
      // used to do all three at once, which meant a controller could make
      // somebody responsible for a running execution while they were asleep.
      // The recipient answers next.
      const event = store.append({
        sessionId: session.id,
        actorId: fromId,
        type: "control.offered",
        payload: {
          fromParticipantId: fromId,
          toParticipantId: parsed.data.toParticipantId,
        },
      });

      sendJson(response, 202, { offered: true, offerEventId: event.eventId });
      return true;
    }

    const handoffAnswerMatch =
      /^\/sessions\/([^/]+)\/handoff\/(accept|decline|withdraw)$/.exec(pathname);

    if (handoffAnswerMatch && request.method === "POST") {
      const session = sessions.get(decodeURIComponent(handoffAnswerMatch[1]!));
      const answering = handoffAnswerMatch[2] as
        | "accept"
        | "decline"
        | "withdraw";

      if (!session || !participants) {
        sendJson(response, 404, { error: "No such session." });
        return true;
      }

      if (!caller) {
        sendJson(response, 401, {
          error: "The caller could not be identified for a handoff.",
        });
        return true;
      }

      const parsed = HandoffAnswerSchema.safeParse(await readJsonBody(request));

      if (!parsed.success) {
        sendJson(response, 400, { error: "An offerEventId is required." });
        return true;
      }

      const refusal = refuseHandoffAnswer(
        projectionOf(session.id).controlOffer,
        parsed.data.offerEventId,
        caller.participant.id,
        answering,
      );

      if (refusal) {
        sendJson(response, refusal.status, { error: refusal.error });
        return true;
      }

      if (answering !== "accept") {
        const event = store.append({
          sessionId: session.id,
          actorId: caller.participant.id,
          type:
            answering === "decline" ? "control.declined" : "control.withdrawn",
          payload: {
            offerEventId: parsed.data.offerEventId,
            participantId: caller.participant.id,
            ...(answering === "decline" && parsed.data.reason
              ? { reason: parsed.data.reason }
              : {}),
          },
        });

        sendJson(response, 202, { settled: true, eventId: event.eventId });
        return true;
      }

      // Acceptance is its own event even when the transfer follows one line
      // later. Collapsing them would lose the fact that the recipient agreed —
      // which is the whole difference between a handoff and an assignment —
      // and would make the waiting case, where a run is still executing, look
      // like a different mechanism rather than the same one mid-flight.
      const accepted = store.append({
        sessionId: session.id,
        actorId: caller.participant.id,
        type: "control.accepted",
        payload: {
          offerEventId: parsed.data.offerEventId,
          participantId: caller.participant.id,
        },
      });

      const transfer = settleAcceptedHandoff(session.id);

      sendJson(response, 202, {
        accepted: true,
        eventId: accepted.eventId,
        // False means accepted and waiting: the run in flight has to reach a
        // boundary first. The client says so rather than showing the baton as
        // already moved.
        transferred: transfer?.type === "control.transferred",
      });
      return true;
    }

    const leaveMatch = /^\/sessions\/([^/]+)\/leave$/.exec(pathname);

    if (leaveMatch && request.method === "POST") {
      const session = sessions.get(decodeURIComponent(leaveMatch[1]!));

      if (!session || !participants || !caller) {
        sendJson(response, 404, { error: "No such session." });
        return true;
      }

      // Deliberate, and distinct from a dropped connection. The projection
      // treats the two differently on purpose — a standing control request
      // survives a refresh but not a departure — and until this route existed
      // the "left" reason had no way to ever be written, so every fact about
      // somebody who was gone for good outlived them.
      const event = store.append({
        sessionId: session.id,
        actorId: caller.participant.id,
        type: "participant.left",
        payload: { participantId: caller.participant.id, reason: "left" },
      });

      // Control the leaver was holding is now held by nobody, which the fold
      // above already says. A handoff they were half of is void, so anything
      // that was waiting on a boundary is re-examined here rather than left
      // to a run ending that may never come.
      settleAcceptedHandoff(session.id);

      sendJson(response, 202, { left: true, eventId: event.eventId });
      return true;
    }

    const authorityMatch = /^\/sessions\/([^/]+)\/authority$/.exec(pathname);

    if (authorityMatch && request.method === "GET") {
      const session = sessions.get(decodeURIComponent(authorityMatch[1]!));

      if (!session) {
        sendJson(response, 404, { error: "No such session." });
        return true;
      }

      // The authority slice of the projection, served rather than re-folded in
      // each renderer. Every client already receives the whole event log over
      // /events and could fold this itself; three folds of one lifecycle is
      // how a timeline and a baton come to disagree, and it is the disagreement
      // — not the absence — that would cost trust here.
      //
      // It also makes the standing-fact rule true by construction: a client
      // that just opened asks this and learns that somebody requested control
      // an hour ago, without replaying anything.
      // Annotated, not merely shaped like the contract. This is the one link
      // between the fold and every renderer that the compiler can be made to
      // check, and without it the two drift silently — a field renamed here
      // leaves the panel blank rather than failing a build.
      const projection = projectionOf(session.id);
      const payload: Authority = {
        // Which of these is the caller. A client cannot render authority
        // without it: "Maya in control" and "You are in control" are the same
        // fact and completely different screens, and the alternative is every
        // renderer calling /me alongside this and correlating two responses
        // that can disagree by a handoff. Null for a bare-token caller on a
        // worker with no participant registry — the single-user path, where
        // there is nobody to be.
        you: caller?.participant.id ?? null,
        controlHeldBy: projection.controlHeldBy,
        controlOffer: projection.controlOffer,
        controlRequests: projection.controlRequests,
        pendingDirection: projection.pendingDirection,
        // What the transfer is waiting on, when it is waiting. The offer's own
        // state says "accepted"; this says why that is not yet "moved" — and
        // names the runs, so a client can say which execution is holding it up
        // rather than only that something is.
        executingRunIds: executingRunIds(session.id),
      };

      sendJson(response, 200, payload);
      return true;
    }

    const meMatch = /^\/sessions\/([^/]+)\/me$/.exec(pathname);

    if (meMatch && request.method === "GET") {
      const session = sessions.get(decodeURIComponent(meMatch[1]!));

      // Who the calling token is, in this session. An invite link carries a
      // credential and nothing else, so a joined client has no honest way to
      // know its own role — and the role moves under it on a handoff — except
      // by asking. 404s mirror /presence: a worker with no participant
      // registry has nobody to be.
      if (!session || !participants || !caller) {
        sendJson(response, 404, { error: "No such session." });
        return true;
      }

      // The envelope is hand-shaped and the payload is ParticipantSchema on
      // the client side — the same split /sessions already uses.
      sendJson(response, 200, { participant: caller.participant });
      return true;
    }

    const presenceMatch = /^\/sessions\/([^/]+)\/presence$/.exec(pathname);

    if (presenceMatch && request.method === "GET") {
      const session = sessions.get(decodeURIComponent(presenceMatch[1]!));

      if (!session || !participants) {
        sendJson(response, 404, { error: "No such session." });
        return true;
      }

      // The host's own membership is registered under HOST_SESSION, not this
      // session's id — the worker outlives any one session, so the host is
      // never "for" one the way an invited participant is. Presence has to
      // include them anyway: the host is always in the room.
      const roster = [
        ...participants.forSession(HOST_SESSION),
        ...participants.forSession(session.id),
      ].map((membership) => ({
        id: membership.participant.id,
        name: membership.participant.name,
        role: membership.participant.role,
        connected: membership.connected,
      }));

      sendJson(response, 200, { participants: roster });
      return true;
    }

    const compareMatch = /^\/sessions\/([^/]+)\/compare$/.exec(pathname);

    if (compareMatch && request.method === "GET") {
      const session = sessions.get(decodeURIComponent(compareMatch[1]!));

      if (!session) {
        sendJson(response, 404, { error: "No such session." });
        return true;
      }

      // Derived from the log, not from live fork handles, for the same
      // reason the /files route already is: fork.created is durable and
      // in-memory state is not, so a comparison built from handles forgot
      // every attempt the moment the worker restarted — the log remembered
      // them, and their evidence, the whole time.
      const events = store.list(session.id);
      const attempts = events.flatMap((event) =>
        event.type === "fork.created"
          ? [
              {
                runId: event.payload.fork.runId,
                label: event.payload.fork.label,
              },
            ]
          : [],
      );

      sendJson(response, 200, compareAttempts(session.id, events, attempts));
      return true;
    }

    const filesMatch = /^\/sessions\/([^/]+)\/files$/.exec(pathname);

    if (filesMatch && request.method === "GET") {
      const session = sessions.get(decodeURIComponent(filesMatch[1]!));

      if (!session) {
        sendJson(response, 404, { error: "No such session." });
        return true;
      }

      // The same projection /compare folds attempts from — filtered to this
      // session's own runs, because a fork's filesChanged describes its own
      // worktree, not the one this panel is showing.
      const events = store.list(session.id);
      const projected = projectSession(session.id, events);
      // Derived from the log, not session.forks: that map is in-memory only
      // and empty after any worker restart, even though fork.created (the
      // parent's durable record of having branched) survives in the store
      // that projectSession just read. Reading it from session.forks meant
      // every fork's files silently folded back into this panel — the exact
      // thing the comment above says this filter exists to prevent — the
      // moment a session outlived the process that forked it.
      const forkRunIds = new Set(
        events.flatMap((event) =>
          event.type === "fork.created" ? [event.payload.fork.runId] : [],
        ),
      );
      const byPath = new Map<
        string,
        { path: string; additions: number; deletions: number }
      >();

      for (const run of projected.runs) {
        if (forkRunIds.has(run.runId)) {
          continue;
        }

        for (const file of run.filesChanged) {
          const existing = byPath.get(file.path);

          if (existing) {
            existing.additions += file.additions;
            existing.deletions += file.deletions;
          } else {
            byPath.set(file.path, { ...file });
          }
        }
      }

      const files = [...byPath.values()].sort((first, second) =>
        first.path.localeCompare(second.path),
      );

      sendJson(response, 200, {
        files,
        additions: files.reduce((total, file) => total + file.additions, 0),
        deletions: files.reduce((total, file) => total + file.deletions, 0),
      });
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

      // The worktree manager holds the live handles — populated at fork
      // creation in this process, or re-adopted from the log when the
      // session was resumed after a restart. A fork the log remembers but
      // whose checkout is gone lands here as a 404 too, which the message
      // already covers.
      const handle = session.worktrees.get(parsed.data.runId);

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

      // Whether a run is live decides what the submitter is actually promised,
      // and those are two different promises. With an execution running, that
      // execution drains direction at its next turn boundary — the direction is
      // queued, and the person who typed it can expect it to matter within the
      // minute. With nothing running it is recorded and waits for whatever runs
      // next, which may be never. Both are honest; "submitted" alone cannot
      // tell them apart, and a participant reading a shared timeline needs to
      // know whether their words are about to be acted on.
      //
      // Queued at submission rather than at the boundary the runner drains at:
      // by that boundary the direction is being applied in the same instant, so
      // an event emitted there would describe a state that never lasted long
      // enough for anyone to see it.
      const targetRun = directionTargetRun(session.id);

      if (targetRun !== null) {
        store.append({
          sessionId: session.id,
          actorId: caller?.participant.id ?? "host",
          type: "direction.queued",
          payload: {
            runId: targetRun,
            directionEventId: event.eventId,
            direction: parsed.data.goal,
          },
        });
      }

      sendJson(response, 202, {
        accepted: true,
        eventId: event.eventId,
        queuedForRunId: targetRun,
      });
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

      const chosen = parsed.data.model;

      if (
        chosen &&
        !sessions
          .models()
          .some(
            (available) =>
              available.provider === chosen.provider &&
              available.model === chosen.model,
          )
      ) {
        // Refused here rather than at the model call. A turn that names a
        // model this worker has no adapter for would otherwise start, reach
        // the runner, and die with "No model adapter is configured" — a
        // failed run in the log for what is really a bad request.
        sendJson(response, 400, {
          error: `This worker has no adapter for ${chosen.provider}/${chosen.model}.`,
        });
        return true;
      }

      // Accepted, not completed: progress arrives on the event stream.
      void sessions.submitTurn(session, parsed.data.goal, chosen);
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
            : // Named explicitly rather than left to the trailing default:
              // stopping, pausing, or resuming a run in flight is exactly the
              // kind of action participants.ts warns about a reviewer
              // inheriting by accident when a route is not listed here.
              /^\/sessions\/[^/]+\/(cancel|pause|resume)$/.test(url.pathname)
              ? "steer"
              : // Asking for control is not taking it — anyone who can watch
                // a session may say they want it, the same way anyone can
                // speak up in a room without being handed the microphone.
                /^\/sessions\/[^/]+\/control\/request$/.test(url.pathname)
                ? "watch"
                : // Handing off is what actually moves execution authority,
                  // so it needs the same capability `transferOwnership`
                  // itself is gated on — checked twice on purpose, once here
                  // and once in participants.ts, the same defense in depth
                  // the rest of this table already relies on.
                  /^\/sessions\/[^/]+\/handoff$/.test(url.pathname)
                  ? "transfer"
                  : // Answering an offer, and leaving, are not privileges of
                    // rank. Control is routinely offered to people who do not
                    // hold it — that is what a baton is for — so requiring
                    // "transfer" to accept would mean the only participants
                    // allowed to take control are the ones who already have
                    // it. What authorises these is being named in the offer,
                    // or being oneself, and `refuseHandoffAnswer` checks that
                    // identity at the route. "watch" here is the floor: you
                    // must still be a participant of this session, which the
                    // scope check above enforces.
                    /^\/sessions\/[^/]+\/(handoff\/(accept|decline|withdraw)|leave)$/.test(
                      url.pathname,
                    )
                    ? "watch"
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

    // Live presence, distinct from `participant.joined` in the log: that event
    // says who was ever invited, this says who has an open stream right now. A
    // second tab or a reconnect must not read as a departure, so this counts
    // open connections per participant rather than tracking one boolean per
    // stream — `connected` only flips to false when the last of them closes.
    if (caller && participants) {
      const id = caller.participant.id;
      liveConnections.set(id, (liveConnections.get(id) ?? 0) + 1);
      participants.setConnected(id, true);
    }

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

      if (caller && participants) {
        const id = caller.participant.id;
        const remaining = Math.max(0, (liveConnections.get(id) ?? 1) - 1);

        liveConnections.set(id, remaining);

        if (remaining === 0) {
          participants.setConnected(id, false);
        }
      }
    });
  });

  /**
   * The safe boundary, watched rather than polled.
   *
   * An acceptance that arrived while a run was executing left the offer sitting
   * in the "accepted" state, and something has to notice when the execution
   * ends. This subscription is that something: every terminal run event —
   * completed, failed, cancelled, and paused, which is a boundary too because
   * the loop has genuinely stopped — re-examines the session for a handoff
   * waiting on it.
   *
   * Process-wide, like `store.subscribe` itself, so it is filtered by the event
   * carrying its own session id rather than by one subscription per session.
   */
  const unsubscribeBoundaries = store.subscribe((event) => {
    if (
      event.type === "run.completed" ||
      event.type === "run.failed" ||
      event.type === "run.cancelled" ||
      event.type === "run.paused"
    ) {
      settleAcceptedHandoff(event.sessionId);
    }
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
            unsubscribeBoundaries();
            server.close(() => closed());
          }),
      });
    });
  });
};
