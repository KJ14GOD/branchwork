import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import type { AuthedContext } from "./auth.ts";
import type { RepositoryProvider } from "./repo-provider.ts";

/**
 * The shared surface every route module registers against. Modules never
 * import the server; the server imports them. Each module owns a disjoint set
 * of paths, which is what lets several people work on the control plane at
 * once without fighting over one file.
 */
export interface RouteDeps {
  db: Db;
  config: Config;
  provider: RepositoryProvider;
  /** Resolves the caller's session, or replies 401 and returns null. */
  requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<AuthedContext | null>;
  sendError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply;
}

export type RouteModule = (app: FastifyInstance, deps: RouteDeps) => void;
