import assert from "node:assert/strict";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

import {
  contentTypeFor,
  isLoopbackHost,
  resolveAsset,
  serveRenderer,
  type RendererHost,
} from "./renderer-host.ts";

const ROOT = resolve("/app/dist");

describe("resolveAsset", () => {
  test("a bare path is the entry document", () => {
    assert.equal(resolveAsset(ROOT, "/"), join(ROOT, "index.html"));
    assert.equal(resolveAsset(ROOT, "/sub/"), join(ROOT, "sub/index.html"));
  });

  test("a file under the root resolves to it", () => {
    assert.equal(
      resolveAsset(ROOT, "/assets/index-a1b2.js"),
      join(ROOT, "assets/index-a1b2.js"),
    );
  });

  test("a query string is not part of the path", () => {
    assert.equal(resolveAsset(ROOT, "/assets/app.css?v=2"), join(ROOT, "assets/app.css"));
  });

  test("a plain climb is normalised back into the bundle, not honoured", () => {
    // The URL parser collapses `..` segments — including `%2e%2e`, which it is
    // required to treat as a dot — before we ever see a pathname. Worth pinning:
    // it is the reason the obvious attack does not reach the containment check.
    assert.equal(resolveAsset(ROOT, "/../.env"), join(ROOT, ".env"));
    assert.equal(resolveAsset(ROOT, "/assets/../../../etc/passwd"), join(ROOT, "etc/passwd"));
    assert.equal(resolveAsset(ROOT, "/%2e%2e/%2e%2e/etc/passwd"), join(ROOT, "etc/passwd"));
  });

  test("a climb hidden from the parser is refused", () => {
    // `..%2f` is one opaque segment to the URL parser and becomes `../` only
    // when we decode it, which is after normalisation. Nothing but the
    // containment check stands between this and the host filesystem.
    assert.equal(resolveAsset(ROOT, "/..%2f..%2fetc/passwd"), null);
    assert.equal(resolveAsset(ROOT, "/assets/..%2f..%2f..%2fetc%2fpasswd"), null);
    // A sibling directory that merely shares the root's prefix is not inside it.
    assert.equal(resolveAsset(ROOT, "/..%2fdist-secrets%2fkey.txt"), null);
  });

  test("a path that cannot be a filename is refused", () => {
    assert.equal(resolveAsset(ROOT, "/a%00.js"), null);
    assert.equal(resolveAsset(ROOT, "/%zz"), null);
  });
});

describe("isLoopbackHost", () => {
  test("this machine only", () => {
    assert.ok(isLoopbackHost("127.0.0.1:5273"));
    assert.ok(isLoopbackHost("localhost:5273"));
    assert.ok(isLoopbackHost("[::1]:5273"));
    assert.ok(!isLoopbackHost("evil.example.com:5273"));
    assert.ok(!isLoopbackHost(undefined));
  });
});

test("content types cover what the build emits", () => {
  assert.equal(contentTypeFor("/a/index.html"), "text/html; charset=utf-8");
  assert.equal(contentTypeFor("/a/index-a1b2.js"), "text/javascript; charset=utf-8");
  assert.equal(contentTypeFor("/a/index-a1b2.CSS"), "text/css; charset=utf-8");
  assert.equal(contentTypeFor("/a/font.woff2"), "font/woff2");
  assert.equal(contentTypeFor("/a/unknown.bin"), "application/octet-stream");
});

type RawResponse = { status: number; headers: IncomingHttpHeaders; body: string };

/**
 * A request sent exactly as written.
 *
 * `fetch` normalises the path and refuses to set `Host`, which is precisely the
 * two things worth attacking here — so the traversal and rebinding cases have to
 * go out over a socket we control rather than through a client that has already
 * cleaned them up.
 */
const raw = (
  origin: string,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<RawResponse> =>
  new Promise((settle, fail) => {
    const target = new URL(origin);

    const request = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        path,
        method: options.method ?? "GET",
        headers: options.headers ?? {},
      },
      (response) => {
        let body = "";

        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () =>
          settle({ status: response.statusCode ?? 0, headers: response.headers, body }),
        );
      },
    );

    request.on("error", fail);
    request.end();
  });

describe("serveRenderer", () => {
  let root: string;
  let secret: string;
  let host: RendererHost;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "novus-renderer-"));
    // Outside the served root, and named so a bare prefix comparison — the
    // mistake this containment check exists to avoid — would call it inside.
    secret = `${root}-secret`;

    await mkdir(join(root, "assets"));
    await writeFile(join(root, "index.html"), "<!doctype html><title>Novus</title>");
    await writeFile(join(root, "assets", "app.js"), "export const ok = 1;\n");
    await writeFile(secret, "nope");

    host = await serveRenderer(root);
  });

  after(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
    await rm(secret, { force: true });
  });

  /**
   * The whole reason this server exists. `isAllowedOrigin` in the worker admits
   * http(s) on a loopback host and nothing else, which is why `loadFile` — and
   * the `Origin: null` a `file://` page sends — could never have worked.
   */
  test("hands back a loopback http origin", () => {
    assert.match(host.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test("serves the entry document at the origin root", async () => {
    const response = await raw(host.origin, "/");

    assert.equal(response.status, 200);
    assert.equal(response.headers["content-type"], "text/html; charset=utf-8");
    assert.match(response.body, /<title>Novus<\/title>/);
  });

  test("serves a hashed asset", async () => {
    const response = await raw(host.origin, "/assets/app.js");

    assert.equal(response.status, 200);
    assert.equal(response.headers["content-type"], "text/javascript; charset=utf-8");
    assert.equal(response.body, "export const ok = 1;\n");
  });

  test("refuses a path that leaves the bundle", async () => {
    const response = await raw(host.origin, `/..%2f${basename(secret)}`);

    assert.equal(response.status, 403);
    assert.doesNotMatch(response.body, /nope/);
  });

  test("a missing file is a miss, not a page", async () => {
    const response = await raw(host.origin, "/assets/gone.js");

    assert.equal(response.status, 404);
  });

  test("reads only", async () => {
    const response = await raw(host.origin, "/", { method: "POST" });

    assert.equal(response.status, 405);
    assert.equal(response.headers["allow"], "GET, HEAD");
  });

  test("refuses a request addressed to some other hostname", async () => {
    const response = await raw(host.origin, "/", {
      headers: { host: "rebound.example.com" },
    });

    assert.equal(response.status, 403);
  });

  test("closing releases the port", async () => {
    const disposable = await serveRenderer(root);
    await disposable.close();

    await assert.rejects(raw(disposable.origin, "/"));
  });
});
