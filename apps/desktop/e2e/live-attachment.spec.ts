import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { MissionDetailResponse, NovusBridge } from "@novus/contracts";

/**
 * Live proof: a file a person attached actually reaches Claude, and the answer
 * proves the model received it (D-150, extended to documents by D-151).
 *
 * The whole chain is real — the file on disk, the resize, the digest, the
 * store's verification, the runner's fetch under its own credential, the
 * image content block on the harness's stdin, and the real `claude` binary
 * answering. Nothing here is faked but the GitHub OAuth upstream.
 *
 * The assertion is deliberately about **what only seeing the image could
 * tell you**: the picture is a red square on a blue ground, and no words in
 * the prompt say so. A turn that never received the image cannot answer it,
 * and a turn that answers it cannot have missed it — which is the difference
 * between proving this and claiming it.
 *
 * Opt-in (`NOVUS_LIVE_CLAUDE=1`): it spends the machine owner's quota.
 */

declare global {
  interface Window {
    novus: NovusBridge;
  }
}

const LIVE = process.env.NOVUS_LIVE_CLAUDE === "1";

const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const evidenceDir = join(desktopRoot, "e2e", "evidence");
const CP_PORT = 4494;
const CP_URL = `http://127.0.0.1:${CP_PORT}`;
const DB_URL = "postgres://novus:novus@127.0.0.1:5433/novus_e2e_live_attachment";

let controlPlane: ChildProcess;
let app: ElectronApplication;
let page: Page;

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${CP_URL}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("control plane never became healthy");
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd }).toString().trim();
}

/**
 * A 64×64 PNG: a red square centred on a blue ground, written byte by byte so
 * the test owns exactly what the model is asked about and depends on no
 * fixture file. Nothing in the prompt names either colour.
 */
function redOnBluePng(): Buffer {
  const size = 64;
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x += 1) {
      const inSquare = x >= 16 && x < 48 && y >= 16 && y < 48;
      const at = 1 + x * 3;
      row[at] = inSquare ? 220 : 20;
      row[at + 1] = inSquare ? 40 : 40;
      row[at + 2] = inSquare ? 40 : 200;
    }
    rows.push(row);
  }
  const zlib = require("node:zlib") as typeof import("node:zlib");
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) >>> 0 : crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

/**
 * A one-page PDF printing a single word. Built here rather than fixtured for
 * the same reason as the image: the test owns exactly what the agent is asked
 * about, and the word appears nowhere in the prompt.
 */
function magentaPdf(): Buffer {
  const content = Buffer.from("BT /F1 36 Tf 72 700 Td (MAGENTA) Tj ET", "ascii");
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "ascii"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "ascii"),
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R " +
        "/Resources << /Font << /F1 5 0 R >> >> >>",
      "ascii"
    ),
    Buffer.concat([
      Buffer.from(`<< /Length ${content.length} >>\nstream\n`, "ascii"),
      content,
      Buffer.from("\nendstream", "ascii")
    ]),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", "ascii")
  ];
  let out = Buffer.from("%PDF-1.4\n", "ascii");
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(out.length);
    out = Buffer.concat([
      out,
      Buffer.from(`${index + 1} 0 obj\n`, "ascii"),
      object,
      Buffer.from("\nendobj\n", "ascii")
    ]);
  });
  const xref = out.length;
  out = Buffer.concat([
    out,
    Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, "ascii"),
    Buffer.from(offsets.map((off) => `${String(off).padStart(10, "0")} 00000 n \n`).join(""), "ascii"),
    Buffer.from(
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`,
      "ascii"
    )
  ]);
  return out;
}

/** CRC-32, for the Node versions whose zlib does not expose one. */
function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function detail(missionId: string): Promise<MissionDetailResponse> {
  return page.evaluate(async (id) => {
    const result = await window.novus.missions.get(id);
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    return result.value;
  }, missionId);
}

async function until(
  missionId: string,
  predicate: (value: MissionDetailResponse) => boolean,
  what: string,
  timeoutMs: number
): Promise<MissionDetailResponse> {
  const deadline = Date.now() + timeoutMs;
  let last: MissionDetailResponse | null = null;
  while (Date.now() < deadline) {
    last = await detail(missionId);
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(
    `timed out waiting for ${what}; last execution state: ${last?.executions.at(-1)?.state ?? "none"}`
  );
}

beforeAll(async () => {
  if (!LIVE) return;
  mkdirSync(evidenceDir, { recursive: true });
  controlPlane = spawn(
    process.execPath,
    ["--experimental-strip-types", join(repoRoot, "apps", "control-plane", "src", "main.ts")],
    {
      env: {
        ...process.env,
        NOVUS_FAKE_GITHUB: "1",
        NOVUS_CP_PORT: String(CP_PORT),
        NOVUS_DATABASE_URL: DB_URL,
        // The local store, in a directory this run owns.
        NOVUS_ARTIFACT_STORE: "local",
        NOVUS_ARTIFACT_DIR: mkdtempSync(join(tmpdir(), "novus-live-artifacts-"))
      },
      stdio: "inherit"
    }
  );
  await waitForHealth();
}, 120_000);

afterAll(async () => {
  if (!LIVE) return;
  await app?.close().catch(() => undefined);
  controlPlane?.kill("SIGTERM");
});

describe.skipIf(!LIVE)("an attached image reaching a real Claude Code turn", () => {
  it("uploads it, hands it to the harness, and gets back an answer only seeing it could give", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "novus-live-attach-repo-"));
    const repoName = basename(repoDir);
    git(repoDir, ["init", "-b", "main"]);
    writeFileSync(join(repoDir, "README.md"), "# attachment demo\n");
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-m", "init"]);
    const headSha = git(repoDir, ["rev-parse", "HEAD"]);

    const userDataDir = mkdtempSync(join(tmpdir(), "novus-live-attach-"));
    const localId = randomUUID();
    writeFileSync(join(userDataDir, "local-repos.json"), JSON.stringify({ [localId]: repoDir }));

    // The image, on disk, exactly as a person's screenshot would be.
    const imageDir = mkdtempSync(join(tmpdir(), "novus-live-image-"));
    const imagePath = join(imageDir, "the-screen.png");
    writeFileSync(imagePath, redOnBluePng());

    app = await electron.launch({
      args: [desktopRoot],
      env: {
        ...process.env,
        NOVUS_CP_URL: CP_URL,
        NOVUS_AUTH_AUTOVISIT: "1",
        NOVUS_FAKE_IDENTITY: "kartik",
        NOVUS_USER_DATA_DIR: userDataDir
        // Deliberately no NOVUS_FAKE_HARNESS: this runs the real CLI.
      }
    });
    app.process().stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[novus] ${chunk}`));
    app.process().stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[novus!] ${chunk}`));
    page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => typeof window.novus !== "undefined");

    await page.evaluate(() => window.novus.auth.start());
    const signedIn = Date.now() + 60_000;
    for (;;) {
      const status = await page.evaluate(() => window.novus.auth.status());
      if (status.state === "signed_in") break;
      if (Date.now() > signedIn) throw new Error("sign-in never completed");
      await new Promise((r) => setTimeout(r, 250));
    }

    const token = await (async () => {
      const start = await fetch(`${CP_URL}/auth/github/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ as: "kartik" })
      });
      const { state, authorizeUrl } = (await start.json()) as { state: string; authorizeUrl: string };
      await fetch(authorizeUrl, { redirect: "follow" });
      const claim = await fetch(`${CP_URL}/auth/github/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state })
      });
      return ((await claim.json()) as { token: string }).token;
    })();
    const registered = await fetch(`${CP_URL}/repositories/local`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ localId, name: repoName, defaultBranch: "main", headSha })
    });
    expect(registered.ok).toBe(true);

    const base = await page.evaluate(async (id) => {
      const result = await window.novus.repos.baseLocal(id);
      if (!result.ok) throw new Error(result.message);
      return result.value;
    }, localId);

    const created = await page.evaluate(
      async (input) => {
        const result = await window.novus.missions.create({
          goal: "Look at what I attached",
          successCriteria: "The agent answers a question only the image can answer",
          provider: "local",
          providerRepoId: input.localId,
          baseRef: input.ref,
          baseSha: input.sha,
          creationKey: input.creationKey
        });
        if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
        return result.value;
      },
      { localId, ref: base.ref, sha: base.sha, creationKey: randomUUID() }
    );
    const missionId = created.mission.missionId;

    await until(missionId, (value) => value.runner !== null, "the runner to register", 60_000);

    // --- Attach the image, the way the composer does -------------------------
    const attached = await page.evaluate(
      async (input) => {
        const result = await window.novus.missions.attachImage({
          missionId: input.missionId,
          path: input.path
        });
        if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
        return result.value;
      },
      { missionId, path: imagePath }
    );
    expect(attached.artifactId).toMatch(/^art_/);
    expect(attached.label).toBe("the-screen.png");

    // --- Direct with it, asking something only the picture answers -----------
    await page.evaluate(
      async (input) => {
        const result = await window.novus.missions.direct({
          missionId: input.missionId,
          body:
            "Look at the attached image. Reply with exactly two words and nothing else: " +
            "the colour of the shape in the middle, then the colour of the background. " +
            "Do not use any tools.",
          model: "claude-fable-5",
          effort: "low",
          attachmentIds: [input.artifactId]
        });
        if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
      },
      { missionId, artifactId: attached.artifactId }
    );

    // --- The answer, which is the proof --------------------------------------
    const answered = await until(
      missionId,
      (value) =>
        value.events.some(
          (event) =>
            event.kind === "harness.text" &&
            /red/i.test(String((event.payload as { text?: unknown }).text ?? ""))
        ),
      "the real Claude to answer from the image",
      300_000
    );

    const said = answered.events
      .filter((event) => event.kind === "harness.text")
      .map((event) => String((event.payload as { text?: unknown }).text ?? ""))
      .join(" ");
    // Both colours, neither of them named anywhere in the prompt. The only
    // place either could have come from is the image itself.
    expect(said).toMatch(/red/i);
    expect(said).toMatch(/blue/i);

    // The record says what the direction carried, and says it is supplied
    // rather than captured.
    const carrying = answered.directions.find((row) => row.attachments.length > 0);
    expect(carrying?.attachments[0]?.artifactId).toBe(attached.artifactId);
    expect(carrying?.attachments[0]?.state).toBe("available");
    const artifact = answered.artifacts.find((row) => row.artifactId === attached.artifactId);
    expect(artifact?.kind).toBe("attachment");
    expect(artifact?.captureSource).toBe("upload");

    // The image never touched the worktree: nothing to gitignore, nothing a
    // checkpoint could sweep in (D-150).
    const status = git(repoDir, ["status", "--porcelain"]);
    expect(status).not.toMatch(/\.png/);

    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page.getByTestId("project-shell").waitFor({ timeout: 60_000 });
    await page.waitForTimeout(2_500);
    await page.screenshot({ path: join(evidenceDir, "194-attached-image-answered.png") });

    // --- The same road for a PDF, which the harness reads rather than sees ---
    // A different content block on the CLI's stdin (`document`, not `image`),
    // so it is a separate claim and gets its own proof (D-151). The word is
    // printed only inside the file.
    const pdfPath = join(imageDir, "the-contract.pdf");
    writeFileSync(pdfPath, magentaPdf());
    const attachedPdf = await page.evaluate(
      async (input) => {
        const result = await window.novus.missions.attachImage({
          missionId: input.missionId,
          path: input.path
        });
        if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
        return result.value;
      },
      { missionId, path: pdfPath }
    );
    expect(attachedPdf.mimeType).toBe("application/pdf");

    await page.evaluate(
      async (input) => {
        const result = await window.novus.missions.direct({
          missionId: input.missionId,
          body:
            "Read the attached document. Reply with exactly the one word printed " +
            "in it and nothing else. Do not use any tools.",
          model: "claude-fable-5",
          effort: "low",
          attachmentIds: [input.artifactId]
        });
        if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
      },
      { missionId, artifactId: attachedPdf.artifactId }
    );

    const readIt = await until(
      missionId,
      (value) =>
        value.events.some(
          (event) =>
            event.kind === "harness.text" &&
            /magenta/i.test(String((event.payload as { text?: unknown }).text ?? ""))
        ),
      "the real Claude to read the attached PDF",
      300_000
    );
    const fromDocument = readIt.events
      .filter((event) => event.kind === "harness.text")
      .map((event) => String((event.payload as { text?: unknown }).text ?? ""))
      .join(" ");
    // The word exists only inside the PDF's content stream.
    expect(fromDocument).toMatch(/magenta/i);

    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page.getByTestId("project-shell").waitFor({ timeout: 60_000 });
    await page.waitForTimeout(2_500);
    await page.screenshot({ path: join(evidenceDir, "195-attached-pdf-read.png") });

    // --- Both at once, on one direction ---------------------------------------
    // A mixed sequence is the real question (D-152): the two travel as
    // different content blocks, so a turn carrying both proves the blocks are
    // built per file rather than per turn. Each answer is a word only its own
    // file holds.
    const mixedImage = join(imageDir, "mixed.png");
    writeFileSync(mixedImage, redOnBluePng());
    const mixedPdf = join(imageDir, "mixed.pdf");
    writeFileSync(mixedPdf, magentaPdf());
    const both = await page.evaluate(
      async (input) => {
        const ids: string[] = [];
        for (const path of input.paths) {
          const result = await window.novus.missions.attachImage({
            missionId: input.missionId,
            path
          });
          if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
          ids.push(result.value.artifactId);
        }
        return ids;
      },
      { missionId, paths: [mixedImage, mixedPdf] }
    );
    expect(both).toHaveLength(2);

    await page.evaluate(
      async (input) => {
        const result = await window.novus.missions.direct({
          missionId: input.missionId,
          body:
            "You have been given a picture and a document. Reply with exactly " +
            "three words and nothing else: the colour of the shape in the " +
            "picture, the colour of its background, then the single word " +
            "printed in the document. Do not use any tools.",
          model: "claude-fable-5",
          effort: "low",
          attachmentIds: input.ids
        });
        if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
      },
      { missionId, ids: both }
    );

    const sawBoth = await until(
      missionId,
      (value) =>
        value.events.some((event) => {
          if (event.kind !== "harness.text") return false;
          const text = String((event.payload as { text?: unknown }).text ?? "");
          return /magenta/i.test(text) && /red/i.test(text);
        }),
      "the real Claude to answer from an image and a document at once",
      300_000
    );
    const mixedSaid = sawBoth.events
      .filter((event) => event.kind === "harness.text")
      .map((event) => String((event.payload as { text?: unknown }).text ?? ""))
      .join(" ");
    expect(mixedSaid).toMatch(/red/i);
    expect(mixedSaid).toMatch(/blue/i);
    expect(mixedSaid).toMatch(/magenta/i);

    // The direction records both, in the order they were attached.
    const carriedBoth = sawBoth.directions.find((row) => row.attachments.length === 2);
    expect(carriedBoth?.attachments.map((file) => file.mimeType)).toEqual([
      "image/png",
      "application/pdf"
    ]);

    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page.getByTestId("project-shell").waitFor({ timeout: 60_000 });
    await page.waitForTimeout(2_500);
    await page.screenshot({ path: join(evidenceDir, "196-image-and-pdf-together.png") });
  }, 900_000);
});
