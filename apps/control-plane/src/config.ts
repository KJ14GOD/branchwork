import { randomBytes } from "node:crypto";

export interface Config {
  port: number;
  /**
   * The interface the server binds (D-221). Loopback by default — the
   * local-first deployment serves one machine and must not be reachable from
   * the network by accident. A deployed control plane sets NOVUS_CP_HOST
   * (typically 0.0.0.0 behind a TLS-terminating reverse proxy) deliberately,
   * together with the https NOVUS_CP_PUBLIC_URL its clients and GitHub see.
   */
  host: string;
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
  /**
   * The artifact store (D-022, D-122). `local` is the default for the
   * local-first deployment: blobs on this control plane's own disk behind
   * HMAC-signed expiring URLs. `s3` is the AWS adapter, opt-in via the
   * NOVUS_ARTIFACT_S3_* variables; misconfigured or empty resolves to *no*
   * store, and every artifact route then answers with a named error rather
   * than pretending storage exists.
   */
  artifactStoreKind: "local" | "s3" | "";
  artifactLocalDir: string;
  /** Signs the local store's expiring URLs. Random per boot when unset —
   *  grants are short-lived, so surviving a restart buys nothing. */
  artifactLocalSecret: string;
  s3Bucket: string;
  s3Region: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
  s3Endpoint: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const fakeGithub = env.NOVUS_FAKE_GITHUB === "1";
  if (fakeGithub && env.NODE_ENV === "production") {
    throw new Error("NOVUS_FAKE_GITHUB must never be enabled in production");
  }
  const port = Number(env.NOVUS_CP_PORT ?? 4460);
  return {
    port,
    host: env.NOVUS_CP_HOST ?? "127.0.0.1",
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
      : "",
    artifactStoreKind: (env.NOVUS_ARTIFACT_STORE ?? "local") as "local" | "s3" | "",
    artifactLocalDir: env.NOVUS_ARTIFACT_DIR ?? ".novus-artifacts",
    artifactLocalSecret: env.NOVUS_ARTIFACT_SECRET ?? randomBytes(32).toString("hex"),
    s3Bucket: env.NOVUS_ARTIFACT_S3_BUCKET ?? "",
    s3Region: env.NOVUS_ARTIFACT_S3_REGION ?? "",
    s3AccessKeyId: env.NOVUS_ARTIFACT_S3_KEY_ID ?? "",
    s3SecretAccessKey: env.NOVUS_ARTIFACT_S3_SECRET ?? "",
    s3Endpoint: env.NOVUS_ARTIFACT_S3_ENDPOINT ?? ""
  };
}
