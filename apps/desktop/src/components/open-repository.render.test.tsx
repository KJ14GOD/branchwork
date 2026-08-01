import assert from "node:assert/strict";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import type { HostCapabilities } from "@novus/contracts/protocol";

import { OpenRepository, seedPermissions } from "./open-repository.tsx";

/**
 * Opening a repository, now that it is only that.
 *
 * The regression this file exists for is the composition: this panel used to
 * render the form *and* every remembered mission underneath it, so its height
 * was a function of how much history the log had and its own Open button
 * ended up below the bottom of the window. Creation and navigation are two
 * surfaces now, and the first assertion below is that this one has no list in
 * it at all.
 */

// `bridge()` reads `window.novus`. There is no window under `node --test`, so
// each test says which of the two worlds it is in: inside the Electron shell
// (a directory picker exists) or served in a browser (it does not).
const withWindow = (novus: unknown): void => {
  (globalThis as { window?: unknown }).window = { novus };
};

const capabilities = (over: Partial<HostCapabilities> = {}): HostCapabilities =>
  ({ allowWrites: false, allowCommands: false, ...over }) as HostCapabilities;

const panel = (props: {
  capabilities?: HostCapabilities | null;
  error?: string | null;
  opening?: boolean;
}): string =>
  renderToStaticMarkup(
    <OpenRepository
      onOpen={() => {}}
      opening={props.opening ?? false}
      error={props.error ?? null}
      capabilities={props.capabilities ?? null}
      onClose={() => {}}
    />,
  );

test("the form carries no mission list, whatever the log remembers", () => {
  withWindow(undefined);

  const markup = panel({ capabilities: capabilities() });

  assert.ok(!markup.includes("inbox__"));
  assert.ok(!markup.includes("Needs your decision"));
  assert.ok(markup.includes("Open a repository"));
});

test("current host permission defaults seed the form", () => {
  assert.deepEqual(seedPermissions(capabilities({ allowWrites: true })), {
    allowWrites: true,
    allowCommands: false,
  });
  assert.deepEqual(
    seedPermissions(capabilities({ allowWrites: true, allowCommands: true })),
    { allowWrites: true, allowCommands: true },
  );

  withWindow(undefined);

  // An operator who set NOVUS_ALLOW_WRITES=1 and saw an unchecked box had no
  // way to tell whether the variable was ignored or the control was.
  const permitted = panel({
    capabilities: capabilities({ allowWrites: true, allowCommands: true }),
  });

  assert.equal(permitted.match(/checked/g)?.length, 2);
});

test("permissions are off until the worker has answered", () => {
  assert.deepEqual(seedPermissions(null), {
    allowWrites: false,
    allowCommands: false,
  });

  withWindow(undefined);

  assert.equal(panel({ capabilities: null }).match(/checked/g), null);
  assert.equal(panel({ capabilities: capabilities() }).match(/checked/g), null);
});

test("an error stays visible beside the Open button", () => {
  withWindow(undefined);

  const markup = panel({
    capabilities: capabilities(),
    error: "Not a git repository: /tmp/nope",
  });
  const foot = markup.indexOf('class="sheet__foot"');

  assert.ok(markup.includes("Not a git repository: /tmp/nope"));
  assert.ok(
    markup.indexOf("Not a git repository") > foot,
    "in the foot, which does not scroll away under a long form",
  );
});

test("directory browsing is offered inside the shell and not in a browser", () => {
  withWindow({ pickDirectory: () => Promise.resolve(null) });

  const inShell = panel({ capabilities: capabilities() });

  assert.ok(inShell.includes("Browse…"));
  // A button in a form defaults to submit — browsing must not open a session.
  assert.ok(inShell.includes('type="button">Browse…'));

  withWindow(undefined);

  assert.ok(!panel({ capabilities: capabilities() }).includes("Browse…"));
});

test("the repository field is what focus lands on", () => {
  withWindow(undefined);

  assert.ok(panel({ capabilities: capabilities() }).includes("data-autofocus"));
});

test("opening says so and cannot be double-submitted", () => {
  withWindow(undefined);

  const markup = panel({ capabilities: capabilities(), opening: true });

  assert.ok(markup.includes("Opening…"));
  assert.ok(markup.includes("disabled"));
});
