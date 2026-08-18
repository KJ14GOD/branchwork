import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { RouteDeps } from "./routes.ts";
import { missionAccess } from "./authz.ts";
import { touchHeldLeases, touchPresence } from "./reliability.ts";
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
