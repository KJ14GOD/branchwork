import assert from "node:assert/strict";
import test from "node:test";

import { roleAllows } from "./roles.ts";

/**
 * These pin the client's mirror of the server's capability table to the same
 * facts `apps/worker/src/participants.ts` enforces — the worker's own route
 * tests prove the server side, and this proves the UI will not offer what
 * the server would refuse. If a capability moves between roles, both tables
 * and both suites must move together, on purpose.
 */

test("a viewer can only watch", () => {
  assert.equal(roleAllows("viewer", "watch"), true);
  assert.equal(roleAllows("viewer", "direct"), false);
  assert.equal(roleAllows("viewer", "steer"), false);
  assert.equal(roleAllows("viewer", "decide"), false);
  assert.equal(roleAllows("viewer", "invite"), false);
  assert.equal(roleAllows("viewer", "transfer"), false);
});

test("a reviewer approves without directing, steering or deciding", () => {
  assert.equal(roleAllows("reviewer", "watch"), true);
  assert.equal(roleAllows("reviewer", "approve"), true);
  assert.equal(roleAllows("reviewer", "direct"), false);
  assert.equal(roleAllows("reviewer", "steer"), false);
  // Deciding and applying are one route for V1, and a reviewer is the role
  // defined as approving without directly executing.
  assert.equal(roleAllows("reviewer", "decide"), false);
});

test("an editor directs and steers but neither decides, invites nor transfers", () => {
  assert.equal(roleAllows("editor", "direct"), true);
  assert.equal(roleAllows("editor", "steer"), true);
  // The pair that says deciding is not a shade of steering. If these ever
  // agree again, the client will start offering a control the worker refuses.
  assert.equal(roleAllows("editor", "decide"), false);
  assert.equal(roleAllows("editor", "invite"), false);
  assert.equal(roleAllows("editor", "transfer"), false);
});

test("an owner can do all of it", () => {
  for (const capability of [
    "watch",
    "direct",
    "approve",
    "steer",
    "decide",
    "invite",
    "transfer",
  ] as const) {
    assert.equal(roleAllows("owner", capability), true);
  }
});
