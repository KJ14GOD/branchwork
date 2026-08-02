import type { FastifyInstance } from "fastify";
import type { RouteDeps } from "./routes.ts";

/**
 * OWNER: the workspace runtime's control-plane half (D-040 … D-042). Paths:
 *
 *   POST /missions/:missionId/workspace/command   (setup | run | verification)
 *   POST /missions/:missionId/workspace/stop
 *
 * There is deliberately no shell path. A remote controller may invoke the
 * commands the project itself declared and nothing else, which is why the
 * absence is structural rather than a check someone could forget.
 */
export function registerWorkspaceRoutes(_app: FastifyInstance, _deps: RouteDeps): void {
  // Implemented by the workspace slice.
}
