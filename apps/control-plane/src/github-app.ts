import type { FastifyInstance } from "fastify";
import { appendFileSync } from "node:fs";
import type { Config } from "./config.ts";

/**
 * GitHub App creation via the manifest flow (D-032): one click to create the
 * app, one to install it. GET /setup/github-app serves an auto-submitting
 * form that carries the manifest to GitHub; GitHub redirects back with a
 * one-time code that converts into the app's credentials, which are appended
 * to .env (gitignored) — never printed, logged, or returned to any client.
 */
export function registerGithubAppSetup(app: FastifyInstance, config: Config): void {
  app.get("/setup/github-app", async (_request, reply) => {
    const manifest = {
      name: "Novus (dev)",
      url: config.publicBaseUrl,
      redirect_url: `${config.publicBaseUrl}/setup/github-app/callback`,
      public: false,
      // `pull_requests: write` covers the whole D-099 surface: draft create,
      // reviewer requests, mark-ready, and reading reviews/comments. There is
      // deliberately no scope here a merge would need beyond it — the absence
      // of a merge verb is Novus's own (D-099) — and an app created before
      // this scope was added needs the permission added in its GitHub
      // settings and the installation re-approved by its owner.
      default_permissions: { contents: "write", metadata: "read", pull_requests: "write" },
      // A public control plane subscribes to the request's own story (D-101);
      // a loopback one declares no hook, because GitHub could never reach it
      // and the poll is its transport.
      ...(config.publicBaseUrl.includes("127.0.0.1") || config.publicBaseUrl.includes("localhost")
        ? { default_events: [] }
        : {
            hook_attributes: { url: `${config.publicBaseUrl}/webhooks/github` },
            default_events: ["pull_request", "pull_request_review", "pull_request_review_comment", "issue_comment"]
          })
    };
    return reply.type("text/html").send(
      `<!doctype html><meta charset="utf-8"><title>Novus</title>` +
        `<body style="font-family: system-ui; padding: 48px; max-width: 520px">` +
        `<h1 style="font-size:20px">Create the Novus GitHub App</h1>` +
        `<p>GitHub will ask you to confirm. Repository access stays in your control — you pick the repositories when you install it.</p>` +
        `<form action="https://github.com/settings/apps/new" method="post">` +
        `<input type="hidden" name="manifest" value='${JSON.stringify(manifest).replace(/'/g, "&#39;")}'>` +
        `<button type="submit" style="font-size:16px;padding:10px 18px">Create GitHub App</button>` +
        `</form></body>`
    );
  });

  app.get("/setup/github-app/callback", async (request, reply) => {
    const code = (request.query as { code?: string }).code;
    if (!code) return reply.status(400).send("missing code");
    const response = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: "POST",
      headers: { accept: "application/vnd.github+json" }
    });
    if (!response.ok) {
      return reply
        .type("text/html")
        .status(502)
        .send(`<body style="font-family:system-ui;padding:48px">Conversion failed (${response.status}). Reopen /setup/github-app and try again.</body>`);
    }
    const created = (await response.json()) as {
      id: number;
      slug: string;
      client_id: string;
      client_secret: string;
      pem: string;
      html_url: string;
    };
    appendFileSync(
      ".env",
      `\nNOVUS_GHAPP_ID=${created.id}\nNOVUS_GHAPP_PEM_B64=${Buffer.from(created.pem).toString("base64")}\n`
    );
    return reply
      .type("text/html")
      .send(
        `<!doctype html><meta charset="utf-8"><title>Novus</title>` +
          `<body style="font-family: system-ui; padding: 48px; max-width: 520px">` +
          `<h1 style="font-size:20px">App created</h1>` +
          `<p>Credentials saved locally. One step left: install it on your account and pick your repositories.</p>` +
          `<p><a href="${created.html_url}/installations/new" style="font-size:16px">Install ${created.slug} →</a></p>` +
          `<p>Then restart Novus (pnpm dev).</p></body>`
      );
  });
}
