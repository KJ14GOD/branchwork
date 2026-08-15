import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";

/**
 * The artifact store behind D-022's S3-compatible interface, realized for this
 * phase (D-122). The control plane holds the only credentials; runners and
 * clients are handed short-lived signed URLs that are never stored, never
 * logged, and never enter an event or a receipt. Object keys are generated
 * and scoped by Novus — nothing a client names becomes a key.
 *
 * Two implementations:
 *
 *  - **local** — blobs on the control plane's own disk, uploaded and read
 *    over HTTP routes whose authorization is an expiring HMAC signature. The
 *    deterministic store for tests and the honest default for the local-first
 *    deployment. It really verifies: a PUT whose bytes do not hash to the
 *    promised SHA-256, or whose length is not the promised length, is refused
 *    and leaves nothing behind.
 *  - **s3** — AWS SigV4 presigned URLs against a real bucket, opt-in via
 *    environment. The upload signature pins `x-amz-content-sha256`, so the
 *    service itself refuses bytes that do not hash to the promise. Written,
 *    and **not proven live** in this repository until credentials and a
 *    dedicated bucket exist; PROGRESS.md states exactly that. A deterministic
 *    suite passing against the local store is never called live S3 proof.
 *
 * Unconfigured is explicit: `resolveArtifactStore` returns null and every
 * artifact route answers with a named error rather than pretending storage
 * exists (the D-031 posture).
 */

export interface UploadGrant {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: string;
}

export interface ArtifactStore {
  readonly kind: "local" | "s3";
  /** A short-lived upload authorization for exactly these bytes: the key, the
   *  length, and the SHA-256 are all bound into the grant. */
  presignUpload(
    key: string,
    opts: { byteSize: number; sha256: string; contentType: string; expiresInSeconds: number }
  ): Promise<UploadGrant>;
  /** A short-lived viewing URL. Minted per request, never persisted. */
  presignDownload(key: string, opts: { expiresInSeconds: number }): Promise<string>;
  /** What the store actually holds for a key, or null when nothing does. The
   *  completion check reads this rather than trusting the uploader. */
  stat(key: string): Promise<{ byteSize: number; sha256: string | null } | null>;
}

// --- The local store ---------------------------------------------------------

interface LocalMeta {
  sha256: string;
  contentType: string;
  byteSize: number;
}

/** Keys are server-generated (`missions/msn_x/artifacts/art_y/blob`), but the
 *  path build refuses traversal anyway: defense against a future caller, not
 *  against the server's own generator. */
function safeBlobPath(root: string, key: string): string | null {
  if (key.includes("..") || key.startsWith("/") || key.includes("\\")) return null;
  const path = normalize(join(root, key));
  if (path !== root && !path.startsWith(`${root}${sep}`)) return null;
  return path;
}

export class LocalArtifactStore implements ArtifactStore {
  readonly kind = "local" as const;
  private readonly rootDir: string;
  private readonly secret: string;
  /** The control plane's own public base URL; the signed routes live on it. */
  private readonly baseUrl: string;

  constructor(rootDir: string, secret: string, baseUrl: string) {
    this.rootDir = rootDir;
    this.secret = secret;
    this.baseUrl = baseUrl;
    mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  }

  private sign(parts: string[]): string {
    return createHmac("sha256", this.secret).update(parts.join("\n")).digest("hex");
  }

  private verify(parts: string[], signature: string): boolean {
    const expected = this.sign(parts);
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(signature, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async presignUpload(
    key: string,
    opts: { byteSize: number; sha256: string; contentType: string; expiresInSeconds: number }
  ): Promise<UploadGrant> {
    const expires = Date.now() + opts.expiresInSeconds * 1000;
    const signature = this.sign([
      "put",
      key,
      String(expires),
      String(opts.byteSize),
      opts.sha256,
      opts.contentType
    ]);
    const url = new URL(`/artifact-store/${encodeURIComponent(key)}`, this.baseUrl);
    url.searchParams.set("exp", String(expires));
    url.searchParams.set("size", String(opts.byteSize));
    url.searchParams.set("sha", opts.sha256);
    url.searchParams.set("ct", opts.contentType);
    url.searchParams.set("sig", signature);
    return {
      url: url.toString(),
      method: "PUT",
      headers: { "content-type": opts.contentType },
      expiresAt: new Date(expires).toISOString()
    };
  }

  async presignDownload(key: string, opts: { expiresInSeconds: number }): Promise<string> {
    const expires = Date.now() + opts.expiresInSeconds * 1000;
    const signature = this.sign(["get", key, String(expires)]);
    const url = new URL(`/artifact-store/${encodeURIComponent(key)}`, this.baseUrl);
    url.searchParams.set("exp", String(expires));
    url.searchParams.set("sig", signature);
    return url.toString();
  }

  async stat(key: string): Promise<{ byteSize: number; sha256: string | null } | null> {
    const path = safeBlobPath(this.rootDir, key);
    if (path === null) return null;
    try {
      const [blob, meta] = await Promise.all([
        stat(path),
        readFile(`${path}.meta.json`, "utf8").then(
          (text) => JSON.parse(text) as LocalMeta,
          () => null
        )
      ]);
      if (!blob.isFile()) return null;
      return { byteSize: blob.size, sha256: meta?.sha256 ?? null };
    } catch {
      return null;
    }
  }

  /**
   * The PUT route's whole job, given the already-buffered body stream: verify
   * the signature and expiry, hash what actually arrived, and refuse any
   * mismatch with nothing left behind — a failed upload must not exist as a
   * blob a later completion could mistake for evidence.
   */
  async receivePut(
    key: string,
    query: { exp?: string; size?: string; sha?: string; ct?: string; sig?: string },
    body: Readable
  ): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
    const { exp = "", size = "", sha = "", ct = "", sig = "" } = query;
    if (!this.verify(["put", key, exp, size, sha, ct], sig)) {
      return { ok: false, status: 403, message: "This upload authorization is not valid." };
    }
    if (Number(exp) < Date.now()) {
      return { ok: false, status: 403, message: "This upload authorization has expired." };
    }
    const path = safeBlobPath(this.rootDir, key);
    if (path === null) return { ok: false, status: 400, message: "Malformed object key." };

    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const partial = `${path}.uploading-${randomBytes(6).toString("hex")}`;
    const hash = createHash("sha256");
    let received = 0;
    body.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      received += chunk.length;
    });
    try {
      await pipeline(body, createWriteStream(partial, { mode: 0o600 }));
    } catch {
      await rm(partial, { force: true });
      return { ok: false, status: 500, message: "The upload did not complete." };
    }
    if (received !== Number(size)) {
      await rm(partial, { force: true });
      return {
        ok: false,
        status: 422,
        message: `The upload was ${received} bytes; ${size} were authorized.`
      };
    }
    const digest = hash.digest("hex");
    if (digest !== sha) {
      await rm(partial, { force: true });
      return {
        ok: false,
        status: 422,
        message: "The uploaded bytes do not match the digest that was authorized."
      };
    }
    const meta: LocalMeta = { sha256: digest, contentType: ct, byteSize: received };
    await writeFile(`${path}.meta.json`, JSON.stringify(meta), { mode: 0o600 });
    await rename(partial, path);
    return { ok: true };
  }

  /** The GET route's authorization; the caller streams the file on true. */
  authorizeGet(key: string, query: { exp?: string; sig?: string }): boolean {
    const { exp = "", sig = "" } = query;
    if (!this.verify(["get", key, exp], sig)) return false;
    return Number(exp) >= Date.now();
  }

  async open(
    key: string
  ): Promise<{ stream: Readable; byteSize: number; contentType: string } | null> {
    const path = safeBlobPath(this.rootDir, key);
    if (path === null) return null;
    try {
      const [blob, metaText] = await Promise.all([stat(path), readFile(`${path}.meta.json`, "utf8")]);
      if (!blob.isFile()) return null;
      const meta = JSON.parse(metaText) as LocalMeta;
      return {
        stream: createReadStream(path),
        byteSize: blob.size,
        contentType: meta.contentType || "application/octet-stream"
      };
    } catch {
      return null;
    }
  }
}

// --- The S3 store ------------------------------------------------------------
// Hand-written SigV4 (interfaces before vendor SDKs — D-012): presigned PUT
// and GET, plus a server-side signed HEAD for completion checks. The upload
// signature pins `x-amz-content-sha256`, so S3 itself refuses a payload that
// does not hash to the promise, and `x-amz-meta-sha256` records the digest on
// the object for the HEAD to read back.

interface S3Options {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Override for S3-compatible endpoints (R2 et al.); empty means AWS. */
  endpoint?: string;
}

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac("sha256", key).update(data, "utf8").digest();
const hex = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export class S3ArtifactStore implements ArtifactStore {
  readonly kind = "s3" as const;
  private readonly opts: S3Options;

  constructor(opts: S3Options) {
    this.opts = opts;
  }

  private host(): string {
    if (this.opts.endpoint) return new URL(this.opts.endpoint).host;
    return `${this.opts.bucket}.s3.${this.opts.region}.amazonaws.com`;
  }

  private pathFor(key: string): string {
    const encodedKey = key.split("/").map(encodeRfc3986).join("/");
    // Path-style for custom endpoints, virtual-hosted for AWS.
    return this.opts.endpoint ? `/${encodeRfc3986(this.opts.bucket)}/${encodedKey}` : `/${encodedKey}`;
  }

  private signingKey(dateStamp: string): Buffer {
    const kDate = hmac(`AWS4${this.opts.secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, this.opts.region);
    const kService = hmac(kRegion, "s3");
    return hmac(kService, "aws4_request");
  }

  private presign(
    method: string,
    key: string,
    expiresInSeconds: number,
    signedHeaders: Record<string, string>,
    payloadHash: string
  ): { url: string; headers: Record<string, string> } {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/${this.opts.region}/s3/aws4_request`;
    const host = this.host();
    const headers: Record<string, string> = { host, ...signedHeaders };
    const headerNames = Object.keys(headers)
      .map((name) => name.toLowerCase())
      .sort();
    const canonicalHeaders = headerNames.map((name) => `${name}:${headers[name]!.trim()}\n`).join("");
    const signedHeaderList = headerNames.join(";");

    const query: Record<string, string> = {
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${this.opts.accessKeyId}/${scope}`,
      "X-Amz-Date": amzDate,
      "X-Amz-Expires": String(expiresInSeconds),
      "X-Amz-SignedHeaders": signedHeaderList
    };
    const canonicalQuery = Object.keys(query)
      .sort()
      .map((name) => `${encodeRfc3986(name)}=${encodeRfc3986(query[name]!)}`)
      .join("&");

    const canonicalRequest = [
      method,
      this.pathFor(key),
      canonicalQuery,
      canonicalHeaders,
      signedHeaderList,
      payloadHash
    ].join("\n");
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, hex(canonicalRequest)].join("\n");
    const signature = createHmac("sha256", this.signingKey(dateStamp))
      .update(stringToSign, "utf8")
      .digest("hex");

    const url = `https://${host}${this.pathFor(key)}?${canonicalQuery}&X-Amz-Signature=${signature}`;
    const clientHeaders = Object.fromEntries(
      Object.entries(headers).filter(([name]) => name !== "host")
    );
    return { url, headers: clientHeaders };
  }

  async presignUpload(
    key: string,
    opts: { byteSize: number; sha256: string; contentType: string; expiresInSeconds: number }
  ): Promise<UploadGrant> {
    const { url, headers } = this.presign(
      "PUT",
      key,
      opts.expiresInSeconds,
      {
        "content-type": opts.contentType,
        "x-amz-content-sha256": opts.sha256,
        "x-amz-meta-sha256": opts.sha256
      },
      opts.sha256
    );
    return {
      url,
      method: "PUT",
      headers,
      expiresAt: new Date(Date.now() + opts.expiresInSeconds * 1000).toISOString()
    };
  }

  async presignDownload(key: string, opts: { expiresInSeconds: number }): Promise<string> {
    return this.presign("GET", key, opts.expiresInSeconds, {}, "UNSIGNED-PAYLOAD").url;
  }

  async stat(key: string): Promise<{ byteSize: number; sha256: string | null } | null> {
    const { url } = this.presign("HEAD", key, 60, {}, "UNSIGNED-PAYLOAD");
    const response = await fetch(url, { method: "HEAD" });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`The artifact store answered HEAD with ${response.status}.`);
    }
    const length = Number(response.headers.get("content-length") ?? "0");
    const sha = response.headers.get("x-amz-meta-sha256");
    return { byteSize: length, sha256: sha };
  }
}

// --- Resolution --------------------------------------------------------------

export interface ArtifactStoreConfig {
  artifactStoreKind: "local" | "s3" | "";
  artifactLocalDir: string;
  artifactLocalSecret: string;
  publicBaseUrl: string;
  s3Bucket: string;
  s3Region: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
  s3Endpoint: string;
}

/**
 * The configured store, or null — and null is answered by every artifact
 * route as a named `artifact_store_unconfigured` error. Nothing degrades
 * silently and nothing pretends an upload succeeded (D-122).
 */
export function resolveArtifactStore(config: ArtifactStoreConfig): ArtifactStore | null {
  if (config.artifactStoreKind === "s3") {
    if (!config.s3Bucket || !config.s3Region || !config.s3AccessKeyId || !config.s3SecretAccessKey) {
      return null;
    }
    return new S3ArtifactStore({
      bucket: config.s3Bucket,
      region: config.s3Region,
      accessKeyId: config.s3AccessKeyId,
      secretAccessKey: config.s3SecretAccessKey,
      endpoint: config.s3Endpoint || undefined
    });
  }
  if (config.artifactStoreKind === "local") {
    return new LocalArtifactStore(
      config.artifactLocalDir,
      config.artifactLocalSecret,
      config.publicBaseUrl
    );
  }
  return null;
}
