import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { RouteDeps } from "./routes.ts";
import { missionAccess } from "./authz.ts";
import { touchHeldLeases, touchPresence } from "./reliability.ts";
import { runnerAuthenticator } from "./runner.ts";
import type { MissionBus } from "./mission-bus.ts";

const MissionParamsSchema = z.object({ missionId: z.string().startsWith("msn_") });

/**
 * How often the stream writes a comment line so a dead connection is noticed
 * by both ends rather than sitting open forever behind a sleeping laptop or a
 * proxy that quietly dropped it.
 */
const HEARTBEAT_MS = 15_000;

/**
 * How often an open stream renews its watcher's held leases. The room used to
 * do this by re-reading the mission every two seconds (D-051); with the read
 * no longer on a timer, the connection itself is the evidence the holder's
 * client is alive — a better heartbeat than a poll, which is exactly what
 * D-051 said to revisit this on.
 */
const LEASE_TOUCH_MS = 30_000;

/**
 * How often an open stream refreshes its watcher's presence. Ten seconds is
 * the write throttle `touchPresence` already applies (D-091), and it must stay
 * well inside the 30-second *connected* threshold: presence used to ride on a
 * two-second read, and a room that now re-reads on change alone would have
 * flickered its own watcher to *reconnecting* between quiet moments. The
 * connection is the truer signal anyway — it is open whether or not anything
 * happened.
 */
const PRESENCE_TOUCH_MS = 10_000;

/**
 * The room's live connection (D-149).
 *
 * Server-sent events, not a WebSocket: everything on this wire travels one way
 * — the control plane telling a watcher that the mission moved — and nothing
 * the client wants to say lacks an authorized route of its own already. D-021
 * chose sockets for the runner's bidirectional command channel and that stands
 * unchanged; this is the client half, and half a socket is a stream.
 *
 * What crosses is an **address**: mission, sequence, and event kind. The
 * payload itself never does. A watcher re-reads `GET /missions/:id` through the
 * same authorization every other reader passes, so this endpoint can leak
 * nothing that endpoint would not already return, and the projection stays the
 * single place that decides what a given person may see.
 */
/**
 * The runner's own wait (D-154).
 *
 * The same shape as the room's stream and for the same reason: everything on
 * this wire travels one way, and the runner's other half — posting events,
 * acknowledging commands, reporting completion — already has authorized routes
 * that are unchanged. What crosses is a **bare signal**: work is waiting on
 * this lane. No command, no payload, no id. The runner then asks
 * `GET /runner/commands` under its own credential exactly as it does on its
 * timer, so the durable queue keeps its idempotency keys, its ordering, its
 * delivered/acknowledged/completed lifecycle and its de-duplication untouched.
 * This removes the waiting and nothing else, which is precisely why it is
 * cheap: D-035's semantics never enter the transport.
 */
export function registerRunnerStreamRoutes(app: FastifyInstance, deps: RouteDeps, bus: MissionBus): void {
  const requireRunner = runnerAuthenticator(deps);

  app.get("/runner/stream", async (request, reply) => {
    const runner = await requireRunner(request, reply);
    if (!runner) return;

    const raw = reply.raw;
    reply.hijack();
    raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });

    let open = true;
    const write = (line: string): void => {
      if (!open) return;
      try {
        raw.write(line);
      } catch {
        close();
      }
    };

    write(`event: ready\ndata: ${JSON.stringify({ workstreamId: runner.workstreamId })}\n\n`);
    const unsubscribe = bus.subscribeWork(runner.workstreamId, () => {
      write("event: work\ndata: {}\n\n");
    });
    const heartbeat = setInterval(() => write(": heartbeat\n\n"), HEARTBEAT_MS);

    function close(): void {
      if (!open) return;
      open = false;
      clearInterval(heartbeat);
      unsubscribe();
      try {
        raw.end();
      } catch {
        // Already gone.
      }
    }

    request.raw.on("close", close);
    request.raw.on("error", close);
  });
}

/**
 * How often the all-missions stream re-resolves its watcher's participant set
 * (D-179): a mission created or joined mid-stream starts streaming within one
 * beat instead of waiting for a reconnect, and a mission left stops.
 */
const RESUBSCRIBE_MS = 30_000;

/**
 * Every mission this person participates in, on one connection (D-179).
 *
 * The rail used to learn about background missions by re-reading the whole
 * list — and every mission's full detail — on a five-second timer. This is
 * the same shape as the room's stream and keeps its two load-bearing rules:
 * what crosses is an **address** ({missionId, seq, kind}), never content, so
 * the projection stays the one place that decides what a person may see; and
 * the set of missions streamed is the watcher's own **participant** set —
 * resolved at connect and re-resolved on a slow beat, never the whole
 * organization's, because visibility is participation (missions.ts's
 * VISIBLE_TO), and an address for a mission you cannot read is still a leak
 * that it exists.
 *
 * Deliberately absent: presence and lease touching. Those are per-mission
 * facts about a *room being read* (D-051, D-091), and this connection only
 * proves the app is open.
 */
export function registerAllMissionsStreamRoute(
  app: FastifyInstance,
  deps: RouteDeps,
  bus: MissionBus
): void {
  app.get("/streams/missions", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;

    const participantMissions = async (): Promise<Set<string>> => {
      const result = await deps.db.query(
        `select m.mission_id from missions m
           join participants p on p.mission_id = m.mission_id and p.user_id = $1
           join organization_members om on om.org_id = m.org_id and om.user_id = $1`,
        [ctx.userId]
      );
      return new Set((result.rows as { mission_id: string }[]).map((row) => row.mission_id));
    };
    const memberOrgs = async (): Promise<string[]> => {
      const result = await deps.db.query(
        "select org_id from organization_members where user_id = $1",
        [ctx.userId]
      );
      return (result.rows as { org_id: string }[]).map((row) => row.org_id);
    };

    const raw = reply.raw;
    reply.hijack();
    raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });

    let open = true;
    const write = (line: string): void => {
      if (!open) return;
      try {
        raw.write(line);
      } catch {
        close();
      }
    };

    // Fan-out is org-keyed so a mission created a moment ago streams from its
    // first event; authorization stays per mission and per event: an address
    // is forwarded only once this watcher's participation in that mission is
    // on record. `foreign` caches the confirmed-not-mine answers so a busy
    // sibling mission costs one membership query per realign beat, not one
    // per event.
    let mine = await participantMissions();
    const foreign = new Set<string>();
    let checking = false;
    const onChange = (change: { missionId: string; seq: number; kind: string }): void => {
      const address = {
        missionId: change.missionId,
        seq: change.seq,
        kind: change.kind
      };
      if (mine.has(change.missionId)) {
        write(`event: change\ndata: ${JSON.stringify(address)}\n\n`);
        return;
      }
      if (foreign.has(change.missionId) || checking) return;
      checking = true;
      void participantMissions()
        .then((ids) => {
          mine = ids;
          if (mine.has(change.missionId)) {
            write(`event: change\ndata: ${JSON.stringify(address)}\n\n`);
          } else {
            foreign.add(change.missionId);
          }
        })
        .catch(() => undefined)
        .finally(() => {
          checking = false;
        });
    };
    const subscriptions = (await memberOrgs()).map((orgId) => bus.subscribeOrg(orgId, onChange));
    write("event: ready\ndata: {}\n\n");

    const heartbeat = setInterval(() => write(": heartbeat\n\n"), HEARTBEAT_MS);
    const realign = setInterval(() => {
      // Removals take effect here; a failed re-resolve keeps the current set
      // and the next beat tries again. The foreign cache clears so a mission
      // this person was invited to since stops being ignored.
      void participantMissions()
        .then((ids) => {
          mine = ids;
          foreign.clear();
        })
        .catch(() => undefined);
    }, RESUBSCRIBE_MS);

    function close(): void {
      if (!open) return;
      open = false;
      clearInterval(heartbeat);
      clearInterval(realign);
      for (const unsubscribe of subscriptions) unsubscribe();
      try {
        raw.end();
      } catch {
        // Already gone.
      }
    }

    request.raw.on("close", close);
    request.raw.on("error", close);
  });
}

export function registerMissionStreamRoutes(app: FastifyInstance, deps: RouteDeps, bus: MissionBus): void {
  app.get("/missions/:missionId/stream", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const params = MissionParamsSchema.safeParse(request.params);
    if (!params.success) return deps.sendError(reply, 400, "bad_id", "Malformed mission id.");
    // Standing is resolved once, at connect. A participant removed from a
    // mission mid-stream keeps a connection that only ever says "re-read", and
    // the re-read is refused by the projection the moment their standing ends.
    const access = await missionAccess(deps.db, ctx, params.data.missionId, null);
    if (!access) return deps.sendError(reply, 404, "not_found", "No such mission in your organization.");

    const raw = reply.raw;
    reply.hijack();
    raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Named for proxies that would otherwise buffer the stream into
      // uselessness by holding writes until a response looks complete.
      "x-accel-buffering": "no"
    });

    let open = true;
    const write = (line: string): void => {
      if (!open) return;
      try {
        raw.write(line);
      } catch {
        close();
      }
    };

    // The first write. It proves the connection reached the client before any
    // event has to, so the room can say it is live rather than assuming it.
    write(`event: ready\ndata: ${JSON.stringify({ missionId: access.missionId })}\n\n`);

    const unsubscribe = bus.subscribe(access.missionId, (change) => {
      write(`event: change\ndata: ${JSON.stringify(change)}\n\n`);
    });

    const heartbeat = setInterval(() => write(": heartbeat\n\n"), HEARTBEAT_MS);
    const presence = setInterval(() => {
      void touchPresence(deps.db, access.missionId, ctx.userId).catch(() => undefined);
    }, PRESENCE_TOUCH_MS);
    const lease = setInterval(() => {
      // Failure here is not the stream's business: a heartbeat that missed one
      // beat is renewed on the next, and half an hour of TTL is a wide grace.
      void touchHeldLeases(deps.db, access.missionId, ctx.userId).catch(() => undefined);
    }, LEASE_TOUCH_MS);

    function close(): void {
      if (!open) return;
      open = false;
      clearInterval(heartbeat);
      clearInterval(presence);
      clearInterval(lease);
      unsubscribe();
      try {
        raw.end();
      } catch {
        // Already gone; there is nothing left to close.
      }
    }

    request.raw.on("close", close);
    request.raw.on("error", close);
    // The connection outlives this handler by design; Fastify was told so by
    // the hijack above.
    void touchHeldLeases(deps.db, access.missionId, ctx.userId).catch(() => undefined);
    void touchPresence(deps.db, access.missionId, ctx.userId).catch(() => undefined);
  });
}
