import assert from "node:assert/strict";
import test from "node:test";

import { ParticipantRegistry, roleCan } from "./participants.ts";

const SESSION = "session-1";

const owner = (registry: ParticipantRegistry) =>
  registry.add({
    sessionId: SESSION,
    name: "Host",
    kind: "human",
    role: "owner",
  });

test("every role can watch, and only the owner can invite or transfer", () => {
  assert.ok(roleCan("viewer", "watch"));
  assert.ok(roleCan("reviewer", "watch"));
  assert.ok(roleCan("editor", "watch"));
  assert.ok(roleCan("owner", "watch"));

  // A viewer observes. V1 lists it as the role that does nothing else, and a
  // viewer who could direct a run would make the distinction decorative.
  assert.ok(!roleCan("viewer", "direct"));
  assert.ok(!roleCan("viewer", "approve"));
  assert.ok(!roleCan("viewer", "steer"));

  // A reviewer comments, evaluates, and approves — but does not execute.
  assert.ok(roleCan("reviewer", "approve"));
  assert.ok(!roleCan("reviewer", "steer"));

  assert.ok(roleCan("editor", "steer"));
  assert.ok(!roleCan("editor", "invite"));
  assert.ok(!roleCan("editor", "transfer"));

  assert.ok(roleCan("owner", "invite"));
  assert.ok(roleCan("owner", "transfer"));
});

test("deciding is the controller's alone, and is not a shade of steering", () => {
  // `/decision` used to be unlisted in the route table and inherited `steer`,
  // which handed the last word on every mission — and, while selection and
  // application share one route, a write into the host's repository — to
  // anyone who could pause a run.
  assert.ok(roleCan("owner", "decide"));

  // The editor is the one that matters. It holds `steer`, so if deciding were
  // still a shade of steering this assertion would be the thing that fails.
  assert.ok(roleCan("editor", "steer"));
  assert.ok(!roleCan("editor", "decide"));

  // A reviewer approves without directly executing, and this route executes.
  assert.ok(!roleCan("reviewer", "decide"));
  assert.ok(!roleCan("viewer", "decide"));
});

test("a token resolves to exactly one participant", () => {
  const registry = new ParticipantRegistry();
  const host = owner(registry);
  const guest = registry.add({
    sessionId: SESSION,
    name: "Teammate",
    kind: "human",
    role: "viewer",
  });

  assert.equal(registry.resolve(host.token)?.participant.id, host.participant.id);
  assert.equal(registry.resolve(guest.token)?.participant.id, guest.participant.id);
  assert.notEqual(host.token, guest.token);
});

test("an unknown or absent token resolves to nobody rather than throwing", () => {
  const registry = new ParticipantRegistry();
  owner(registry);

  // The caller is an HTTP handler. A throw here would be a 500 on a request
  // whose correct answer is 401.
  assert.equal(registry.resolve("not-a-token"), null);
  assert.equal(registry.resolve(null), null);
});

test("handing over control makes the previous owner an editor, not a bystander", () => {
  const registry = new ParticipantRegistry();
  const host = owner(registry);
  const teammate = registry.add({
    sessionId: SESSION,
    name: "Teammate",
    kind: "human",
    role: "editor",
  });

  assert.ok(
    registry.transferOwnership(host.participant.id, teammate.participant.id),
  );

  // V1: a handoff transfers execution authority. It does not remove someone
  // from the session, and they can still direct.
  assert.equal(registry.byId(host.participant.id)?.participant.role, "editor");
  assert.equal(registry.byId(teammate.participant.id)?.participant.role, "owner");
});

test("only an owner can hand over control", () => {
  const registry = new ParticipantRegistry();
  owner(registry);
  const a = registry.add({
    sessionId: SESSION,
    name: "A",
    kind: "human",
    role: "editor",
  });
  const b = registry.add({
    sessionId: SESSION,
    name: "B",
    kind: "human",
    role: "viewer",
  });

  assert.equal(
    registry.transferOwnership(a.participant.id, b.participant.id),
    false,
  );
  assert.equal(registry.byId(b.participant.id)?.participant.role, "viewer");
});

test("presence is separate from membership", () => {
  const registry = new ParticipantRegistry();
  const host = owner(registry);

  assert.equal(host.connected, false);
  registry.setConnected(host.participant.id, true);
  assert.equal(registry.byId(host.participant.id)?.connected, true);

  // A dropped connection is not a departure. Conflating them makes a flaky
  // network look like someone leaving the room.
  registry.setConnected(host.participant.id, false);
  assert.equal(registry.byId(host.participant.id)?.connected, false);
  assert.equal(registry.byId(host.participant.id)?.participant.role, "owner");
});

test("removing a participant invalidates their token", () => {
  const registry = new ParticipantRegistry();
  const host = owner(registry);
  const guest = registry.add({
    sessionId: SESSION,
    name: "Teammate",
    kind: "human",
    role: "viewer",
  });

  assert.ok(registry.remove(guest.participant.id));
  assert.equal(registry.resolve(guest.token), null);
  // And removing one does not disturb another.
  assert.equal(registry.resolve(host.token)?.participant.id, host.participant.id);
});

test("participants are scoped to their session", () => {
  const registry = new ParticipantRegistry();
  owner(registry);
  registry.add({
    sessionId: "another-session",
    name: "Elsewhere",
    kind: "human",
    role: "owner",
  });

  assert.equal(registry.forSession(SESSION).length, 1);
  assert.equal(registry.forSession("another-session").length, 1);
});
