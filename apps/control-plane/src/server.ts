import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { CreateMissionInputSchema } from "@novus/contracts";
import { z } from "zod";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import {
  authenticate,
  claimFlow,
  completeFlow,
  exchangeGithubCode,
  revokeSession,
  startFlow,
  type AuthedContext
} from "./auth.ts";
import {
  MissionCreationError,
  attemptBranchCreation,
  createMission,
  getMission,
  getWorkstreamMission,
  listMissions
} from "./missions.ts";
import {
  ProviderUnconfiguredError,
  UnknownRepositoryError,
  selectRepositoryProvider,
  type RepositoryProvider
} from "./repo-provider.ts";

declare module "fastify" {
  interface FastifyRequest {
    authed?: AuthedContext;
  }
}

const StateSchema = z.object({ state: z.string().min(16).max(64) });
const CallbackSchema = z.object({ code: z.string().min(1).max(200), state: z.string().min(16).max(64) });

export function buildServer(db: Db, config: Config, providerOverride?: RepositoryProvider): FastifyInstance {
  const app = Fastify({ logger: false });
  const provider = providerOverride ?? selectRepositoryProvider(config);

  const sendError = (reply: FastifyReply, status: number, code: string, message: string) =>
    reply.status(status).send({ error: { code, message } });

  const requireAuth = async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const ctx = token ? await authenticate(db, token) : null;
    if (!ctx) {
      await sendError(reply, 401, "unauthenticated", "Sign in to continue.");
      return null;
    }
    request.authed = ctx;
    return ctx;
  };

  app.get("/health", async () => ({ ok: true }));

  app.post("/auth/github/start", async (_request, reply) => {
    if (!config.fakeGithub && !config.githubClientId) {
      return sendError(
        reply,
        503,
        "auth_unconfigured",
        "GitHub sign-in isn't configured yet: the control plane has no OAuth app credentials."
      );
    }
    return startFlow(db, config);
  });

  if (config.fakeGithub) {
    // Test-only upstream stand-in; refuses to exist in production (config.ts).
    app.get("/auth/fake/authorize", async (request, reply) => {
      const { state } = StateSchema.parse(request.query);
      return reply.redirect(`${config.publicBaseUrl}/auth/github/callback?code=fake&state=${state}`);
    });
  }

  app.get("/auth/github/callback", async (request, reply) => {
    const parsed = CallbackSchema.safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "bad_callback", "Malformed OAuth callback.");
    try {
      const identity = await exchangeGithubCode(config, parsed.data.code);
      await completeFlow(db, config, parsed.data.state, identity);
      return reply
        .type("text/html")
        .send("<!doctype html><meta charset=\"utf-8\"><title>Novus</title><body style=\"font-family: system-ui; padding: 48px; max-width: 480px\"><h1 style=\"font-size:20px\">Signed in</h1><p>You can close this tab and return to Novus.</p></body>");
    } catch (error) {
      request.log?.error?.(error);
      return reply
        .status(502)
        .type("text/html")
        .send("<!doctype html><meta charset=\"utf-8\"><title>Novus</title><body style=\"font-family: system-ui; padding: 48px; max-width: 480px\"><h1 style=\"font-size:20px\">Sign-in failed</h1><p>Return to Novus and try again.</p></body>");
    }
  });

  app.post("/auth/github/claim", async (request, reply) => {
    const parsed = StateSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "bad_state", "Malformed claim.");
    let token: string | null;
    try {
      token = await claimFlow(db, config, parsed.data.state);
    } catch {
      return sendError(reply, 410, "flow_gone", "Sign-in attempt expired. Start again.");
    }
    if (!token) return reply.status(202).send({ pending: true });
    const ctx = await authenticate(db, token);
    if (!ctx) return sendError(reply, 500, "session_missing", "Session could not be established.");
    return {
      token,
      user: { userId: ctx.userId, login: ctx.login, name: ctx.name },
      org: { orgId: ctx.orgId, name: ctx.orgName }
    };
  });

  app.post("/auth/signout", async (request, reply) => {
    const ctx = await requireAuth(request, reply);
    if (!ctx) return;
    await revokeSession(db, ctx.sessionId);
    return { ok: true };
  });

  app.get("/me", async (request, reply) => {
    const ctx = await requireAuth(request, reply);
    if (!ctx) return;
    return {
      user: { userId: ctx.userId, login: ctx.login, name: ctx.name },
      org: { orgId: ctx.orgId, name: ctx.orgName }
    };
  });

  app.get("/repositories/available", async (request, reply) => {
    const ctx = await requireAuth(request, reply);
    if (!ctx) return;
    try {
      return { repositories: await provider.listRepositories(ctx.orgId) };
    } catch (error) {
      if (error instanceof ProviderUnconfiguredError) {
        return sendError(reply, 503, "repo_unconfigured", error.message);
      }
      throw error;
    }
  });

  app.get("/repositories/available/:providerRepoId/base", async (request, reply) => {
    const ctx = await requireAuth(request, reply);
    if (!ctx) return;
    const params = z.object({ providerRepoId: z.string().min(1) }).safeParse(request.params);
    const query = z.object({ ref: z.string().min(1).optional() }).safeParse(request.query);
    if (!params.success || !query.success) return sendError(reply, 400, "bad_request", "Malformed request.");
    try {
      return await provider.resolveBase(params.data.providerRepoId, query.data.ref);
    } catch (error) {
      if (error instanceof ProviderUnconfiguredError) {
        return sendError(reply, 503, "repo_unconfigured", error.message);
      }
      if (error instanceof UnknownRepositoryError) {
        return sendError(reply, 404, "unknown_repository", error.message);
      }
      throw error;
    }
  });

  app.get("/missions", async (request, reply) => {
    const ctx = await requireAuth(request, reply);
    if (!ctx) return;
    return { missions: await listMissions(db, ctx) };
  });

  app.post("/missions", async (request, reply) => {
    const ctx = await requireAuth(request, reply);
    if (!ctx) return;
    const parsed = CreateMissionInputSchema.safeParse(request.body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid mission.";
      return sendError(reply, 422, "invalid_mission", message);
    }
    try {
      const created = await createMission(db, provider, ctx, parsed.data);
      return reply.status(201).send(created);
    } catch (error) {
      if (error instanceof ProviderUnconfiguredError) {
        return sendError(reply, 503, "repo_unconfigured", error.message);
      }
      if (error instanceof MissionCreationError) {
        return sendError(reply, 422, error.code, error.message);
      }
      throw error;
    }
  });

  app.post("/workstreams/:workstreamId/branch/retry", async (request, reply) => {
    const ctx = await requireAuth(request, reply);
    if (!ctx) return;
    const params = z.object({ workstreamId: z.string().startsWith("wst_") }).safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "bad_id", "Malformed workstream id.");
    const missionId = await getWorkstreamMission(db, ctx, params.data.workstreamId);
    if (!missionId) return sendError(reply, 404, "not_found", "No such workstream in your organization.");
    await attemptBranchCreation(db, provider, ctx, missionId);
    const detail = await getMission(db, ctx, missionId);
    if (!detail?.workstream) return sendError(reply, 500, "workstream_missing", "Workstream disappeared.");
    return { workstream: detail.workstream };
  });

  app.get("/missions/:missionId", async (request, reply) => {
    const ctx = await requireAuth(request, reply);
    if (!ctx) return;
    const params = z.object({ missionId: z.string().startsWith("msn_") }).safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "bad_id", "Malformed mission id.");
    const found = await getMission(db, ctx, params.data.missionId);
    if (!found) return sendError(reply, 404, "not_found", "No such mission in your organization.");
    return found;
  });

  return app;
}
