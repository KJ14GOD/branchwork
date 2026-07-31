import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";

/**
 * Bundles the worker into one JavaScript file the packaged app can run.
 *
 * A packaged Novus has no repository to point at. Today `main.ts` spawns
 * `node --experimental-strip-types apps/worker/src/worker.ts` at a path
 * relative to the checkout, which works from a clone and is exactly nothing
 * once the app is installed somewhere — and it also assumes the machine has a
 * Node new enough to strip types, which is not something an installer can
 * promise.
 *
 * Electron ships its own Node 24, so the packaged app runs this bundle with
 * ELECTRON_RUN_AS_NODE and needs no system Node at all. Bundling to plain JS
 * also removes the type-stripping dependency: the packaged worker is ordinary
 * JavaScript by the time it ships.
 *
 * `@vscode/ripgrep` stays external. It resolves a binary by walking paths
 * relative to its own file on disk — the same reason node-pty is external in
 * the Vite config — so inlining it would make that walk start from the bundle
 * and never find the binary.
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

await build({
  entryPoints: [resolve(root, "apps/worker/src/worker.ts")],
  outfile: resolve(root, "apps/desktop/dist-worker/worker.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["@vscode/ripgrep"],
  // Node builtins the bundler should never try to inline, and the shim ESM
  // needs so bundled CommonJS dependencies still see `require`.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "warning",
});

/**
 * ripgrep travels with the bundle.
 *
 * Left external, it has to be resolvable from wherever the bundle sits — and
 * the bundle deliberately does not sit inside a node_modules tree. Copying the
 * package (and the platform binary it depends on) next to the output makes
 * ordinary Node resolution find it in both places that matter: this checkout
 * when the bundle is tested directly, and the packaged app's resources.
 *
 * `dereference` because pnpm's store is a forest of symlinks, and a packaged
 * app that shipped links into a store nobody else has would resolve to nothing.
 */
const vendored = resolve(root, "apps/desktop/dist-worker/node_modules/@vscode");
await rm(vendored, { recursive: true, force: true });
await mkdir(vendored, { recursive: true });

// The platform binary is an *optional* dependency of ripgrep, so it is not
// resolvable from the worker — only from ripgrep itself. Under pnpm the two
// sit side by side inside the store, and `apps/worker/node_modules` holds a
// symlink into it, so the real path of the link is what leads to the sibling.
// Derived rather than written out, because a store path encodes a version and
// would rot at the next upgrade.
const linked = resolve(root, "apps/worker/node_modules/@vscode/ripgrep");
const inStore = existsSync(linked) ? realpathSync(linked) : "";
const platformName = `ripgrep-${process.platform}-${process.arch}`;
const sources = [
  ["ripgrep", inStore],
  [platformName, inStore === "" ? "" : resolve(dirname(inStore), platformName)],
];

for (const [name, from] of sources) {
  if (from === "" || !existsSync(from)) {
    // Loud rather than silent: a bundle shipped without the binary fails at
    // the first search, in the packaged app, on somebody else's machine.
    throw new Error(
      `Cannot vendor ${name} for the worker bundle — searched ${from || "(unresolved)"}. ` +
        `search_repository would fail in the packaged app.`,
    );
  }

  await cp(from, resolve(vendored, name), {
    recursive: true,
    dereference: true,
  });
}

console.log("worker bundled to apps/desktop/dist-worker/worker.mjs");
