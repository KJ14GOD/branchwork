export interface Config {
  port: number;
  publicBaseUrl: string;
  databaseUrl: string;
  githubClientId: string;
  githubClientSecret: string;
  /**
   * Test-only substitute for GitHub's OAuth upstream. Every other part of the
   * auth machinery (flows, sessions, orgs, scoping) runs for real against the
   * database. Refuses to activate in production.
   */
  fakeGithub: boolean;
  sessionTtlHours: number;
  githubAppId: string;
  githubAppPem: string;
  /** Verifies X-Hub-Signature-256 on /webhooks/github (D-101). Empty means
   *  the endpoint answers 404 — a local-first control plane has nothing a
   *  webhook could reach, and the poll is its transport. */
  githubWebhookSecret: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const fakeGithub = env.NOVUS_FAKE_GITHUB === "1";
  if (fakeGithub && env.NODE_ENV === "production") {
    throw new Error("NOVUS_FAKE_GITHUB must never be enabled in production");
  }
  const port = Number(env.NOVUS_CP_PORT ?? 4460);
  return {
    port,
    publicBaseUrl: env.NOVUS_CP_PUBLIC_URL ?? `http://127.0.0.1:${port}`,
    databaseUrl: env.NOVUS_DATABASE_URL ?? "postgres://novus:novus@127.0.0.1:5433/novus",
    githubClientId: env.NOVUS_GITHUB_CLIENT_ID ?? "",
    githubClientSecret: env.NOVUS_GITHUB_CLIENT_SECRET ?? "",
    fakeGithub,
    sessionTtlHours: Number(env.NOVUS_SESSION_TTL_HOURS ?? 24 * 30),
    githubAppId: env.NOVUS_GHAPP_ID ?? "",
    githubWebhookSecret: env.NOVUS_GITHUB_WEBHOOK_SECRET ?? "",
    githubAppPem: env.NOVUS_GHAPP_PEM_B64
      ? Buffer.from(env.NOVUS_GHAPP_PEM_B64, "base64").toString("utf8")
      : ""
  };
}
