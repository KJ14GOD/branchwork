import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import type { AddressInfo } from "node:net";

/**
 * Where the built renderer is served from.
 *
 * The worker refuses any browser origin that is not loopback http(s), and it is
 * right to: a page that can reach 127.0.0.1 can reach the repository, the
 * provider key, and the tools. A window opened with `loadFile` is a `file://`
 * page, and Chromium sends `Origin: null` from one of those — the same thing a
 * sandboxed iframe sends, which is exactly why the worker refuses it. So the
 * built app would have 403'd on every request, `/health` included, and looked
 * simply broken.
 *
 * The fix has to be on this side of the boundary, because the origin rule is
 * the boundary. A custom scheme registered through Electron's `protocol` API is
 * the more idiomatic answer and does not work here: it yields an origin like
 * `novus://app`, which is neither http nor loopback, so the worker would refuse
 * it too and the only way to make it pass would be to widen the rule for a
 * scheme name a hostile page could also claim to be. Serving the same files
 * over loopback HTTP instead gives the packaged window the origin the worker
 * already trusts, and makes it the same shape as development, where Vite has
 * been serving the renderer over loopback all along.
 *
 * What that costs is a second listener on the machine. It is bound to
 * 127.0.0.1 on an ephemeral port, it answers GET and HEAD only, and it serves
 * nothing outside the build directory. What it hands out is the same bundle
 * that ships inside the application; the credential is not in it. A browser
 * that loads this origin gets a UI with no preload bridge, therefore no token,
 * and is refused by the worker — which is already the documented behaviour of
 * opening the desktop UI outside Electron.
 */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
]);

export const contentTypeFor = (path: string): string =>
  CONTENT_TYPES.get(extname(path).toLowerCase()) ?? "application/octet-stream";

/**
 * The file a request path names, or null when it names something else.
 *
 * The same rule the repository tools follow, for the same reason: a path that
 * arrives from outside is a request to be resolved and then checked, never a
 * path to be trusted. `..`, an encoded `..`, a leading slash into the host
 * filesystem and a sibling directory that merely shares a prefix all resolve
 * out of the root, and all are refused here rather than downstream.
 */
export const resolveAsset = (root: string, requestUrl: string): string | null => {
  const base = resolve(root);

  let pathname: string;

  try {
    pathname = decodeURIComponent(new URL(requestUrl, "http://127.0.0.1").pathname);
  } catch {
    return null;
  }

  // A NUL byte truncates the path for anything that later reads it as a C
  // string, so a name containing one is not a name we will serve.
  if (pathname.includes("\0")) {
    return null;
  }

  const candidate = resolve(base, `.${pathname.endsWith("/") ? `${pathname}index.html` : pathname}`);

  if (candidate !== base && !candidate.startsWith(base + sep)) {
    return null;
  }

  return candidate;
};

/**
 * Whether a request is talking to this machine's own loopback address.
 *
 * A remote host cannot reach 127.0.0.1, but a public page whose domain resolves
 * there can, and its requests arrive carrying its own hostname in `Host`.
 * Nothing secret is behind this server, so the consequence is small — but the
 * check is three lines, and "loopback is not a boundary" is the premise the
 * worker's own access rules were written from.
 */
export const isLoopbackHost = (host: string | undefined): boolean => {
  if (!host) {
    return false;
  }

  try {
    return LOOPBACK_HOSTS.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
};

export type RendererHost = {
  /** The origin to hand to `loadURL`. Loopback, so the worker accepts it. */
  origin: string;
  close: () => Promise<void>;
};

const send = (response: ServerResponse, status: number, body: string): void => {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
};

/**
 * Serves `root` on an ephemeral loopback port.
 *
 * The port is not pinned. Nothing needs to predict it — the main process reads
 * it back and hands it to the window — and pinning one would mean a second copy
 * of the app, or anything else already holding that port, fails to start.
 */
export const serveRenderer = async (root: string): Promise<RendererHost> => {
  const base = resolve(root);

  const server: Server = createServer((request, response) => {
    if (!isLoopbackHost(request.headers.host)) {
      send(response, 403, "Not served to this host.");

      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("allow", "GET, HEAD");
      send(response, 405, "Method not allowed.");

      return;
    }

    const path = resolveAsset(base, request.url ?? "/");

    if (!path) {
      send(response, 403, "Outside the renderer bundle.");

      return;
    }

    void (async () => {
      let size: number;

      try {
        const info = await stat(path);

        if (!info.isFile()) {
          send(response, 404, "Not found.");

          return;
        }

        size = info.size;
      } catch {
        send(response, 404, "Not found.");

        return;
      }

      response.writeHead(200, {
        "content-type": contentTypeFor(path),
        "content-length": size,
        // The window is new every launch and the files come off local disk, so
        // a cache buys nothing and a stale entry after an upgrade costs a
        // confusing bug report.
        "cache-control": "no-store",
      });

      if (request.method === "HEAD") {
        response.end();

        return;
      }

      createReadStream(path).pipe(response);
    })();
  });

  await new Promise<void>((settle, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", fail);
      settle();
    });
  });

  const address = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((settle) => {
        server.close(() => settle());
        server.closeAllConnections();
      }),
  };
};
