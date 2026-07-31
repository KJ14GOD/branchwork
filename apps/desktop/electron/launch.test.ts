import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type AddressInfo } from "node:net";

import { choosePort, launchPlan, probePort } from "./launch.ts";

/**
 * The delineation itself: a launch is hosting unless it says it is joining,
 * and only a hosting launch spawns a worker. These run without Electron on
 * purpose — the decision is made before any window exists, so it must be
 * provable without one.
 */

test("a plain launch hosts and spawns the worker — single-player sees no mode", () => {
  const plan = launchPlan(["/usr/bin/electron", "."], {});

  assert.deepEqual(plan, { mode: "host", spawnWorker: true });
});

test("a join launch never spawns a worker", () => {
  const plan = launchPlan(["/usr/bin/electron", ".", "--join"], {});

  assert.equal(plan.mode, "join");
  assert.equal(plan.spawnWorker, false);
  assert.equal(plan.mode === "join" ? plan.invite : "unset", null);
});

test("a join launch can carry the invite link", () => {
  const invite = "http://127.0.0.1:5274/?session=abc&token=t";
  const plan = launchPlan(["electron", ".", `--join=${invite}`], {});

  assert.deepEqual(plan, { mode: "join", spawnWorker: false, invite });
});

test("NOVUS_JOIN=1 joins with nothing prefilled", () => {
  const plan = launchPlan(["electron", "."], { NOVUS_JOIN: "1" });

  assert.deepEqual(plan, { mode: "join", spawnWorker: false, invite: null });
});

test("NOVUS_JOIN carrying a link joins with it", () => {
  const invite = "http://127.0.0.1:5274/?relay=ws%3A%2F%2F127.0.0.1%3A4400&token=t";
  const plan = launchPlan(["electron", "."], { NOVUS_JOIN: invite });

  assert.deepEqual(plan, { mode: "join", spawnWorker: false, invite });
});

test("an empty NOVUS_JOIN means what an unset one means: hosting", () => {
  const plan = launchPlan(["electron", "."], { NOVUS_JOIN: "  " });

  assert.deepEqual(plan, { mode: "host", spawnWorker: true });
});

test("a free preferred port is used as-is", async () => {
  const chosen = await choosePort(4319, false, (port) => Promise.resolve(port));

  assert.deepEqual(chosen, { kind: "ok", port: 4319, fallback: false });
});

test("a taken default port falls back to a free one", async () => {
  const chosen = await choosePort(4319, false, (port) =>
    Promise.resolve(port === 4319 ? null : 49_152),
  );

  assert.deepEqual(chosen, { kind: "ok", port: 49_152, fallback: true });
});

test("a taken pinned port refuses instead of silently moving", async () => {
  const chosen = await choosePort(4319, true, () => Promise.resolve(null));

  assert.equal(chosen.kind, "refused");
  assert.match(chosen.kind === "refused" ? chosen.reason : "", /NOVUS_PORT/);
});

test("against a real socket: a port someone else holds is detected and a different free one is chosen", async () => {
  // Occupy an ephemeral port for real — the situation two Novus instances on
  // one machine create — and let the real probe find its way around it.
  const occupier = createServer();

  await new Promise<void>((settle) => occupier.listen(0, "127.0.0.1", settle));

  const taken = (occupier.address() as AddressInfo).port;

  try {
    const chosen = await choosePort(taken, false, probePort);

    assert.equal(chosen.kind, "ok");

    if (chosen.kind === "ok") {
      assert.equal(chosen.fallback, true);
      assert.notEqual(chosen.port, taken);
      assert.ok(chosen.port > 0);
    }
  } finally {
    await new Promise<void>((settle) => occupier.close(() => settle()));
  }
});
