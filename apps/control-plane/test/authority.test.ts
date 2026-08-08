import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CreatedInvitationSchema,
  InvitationListResponseSchema,
  OkResponseSchema,
  RedeemInvitationResponseSchema,
  type MissionRole
} from "@novus/contracts";
import { completeTransferAtBoundary } from "../src/authority.ts";
import { withTransaction } from "../src/db.ts";
import { sweepOffers } from "../src/reliability.ts";
import { bearer, createHarness, type Harness, type SignedIn } from "./harness.ts";

/**
 * Multiplayer authority against a real PostgreSQL: invitations, participants,
 * and the three control machines (PRODUCT.md#control). Only GitHub's upstream
 * and the repository provider are faked — sessions, membership, capability
 * enforcement, leases, and every compare-and-swap run for real, and the two
 * people below are two separately authenticated sessions.
 *
 * These are deterministic tests. They are evidence that the tested paths behave
 * as specified; they are not live proof of the product (AGENTS.md rule 11).
 */

let h: Harness;
let kartik: SignedIn; // creator, Mission Admin, first lease holder
let maya: SignedIn; // joins as Contributor
let ravi: SignedIn; // second joiner, for simultaneous requests
let dana: SignedIn; // joins as Viewer
let outsider: SignedIn; // stays in their own organization, never invited

beforeAll(async () => {
  h = await createHarness("novus_test_authority");
  kartik = await h.signIn("kartik");
  maya = await h.signIn("maya");
  ravi = await h.signIn("ravi");
  dana = await h.signIn("dana");
  outsider = await h.signIn("outsider");
});

afterAll(async () => {
  await h.close();
});

async function createMission(actor: SignedIn, goal: string): Promise<{ missionId: string; workstreamId: string }> {
  const base = await h.app.inject({
    method: "GET",
    url: "/repositories/available/9001/base",
    headers: bearer(actor)
  });
  expect(base.statusCode).toBe(200);
  const { ref, sha } = base.json();
  const created = await h.app.inject({
    method: "POST",
    url: "/missions",
    headers: bearer(actor),
    payload: {
      goal,
      successCriteria: "The team can reconstruct who did what",
      providerRepoId: "9001",
      baseRef: ref,
      baseSha: sha,
      creationKey: crypto.randomUUID()
    }
  });
  expect(created.statusCode).toBe(201);
  const body = created.json();
  return { missionId: body.mission.missionId, workstreamId: body.workstream.workstreamId };
}

async function invite(
  actor: SignedIn,
  missionId: string,
  role: MissionRole = "contributor"
): Promise<{ invitationId: string; token: string }> {
  const created = await h.app.inject({
    method: "POST",
    url: `/missions/${missionId}/invitations`,
    headers: bearer(actor),
    payload: { role }
  });
  expect(created.statusCode).toBe(201);
  // The desktop client validates every response against these schemas, so a
  // shape drift here is a broken client, not a cosmetic difference.
  const body = CreatedInvitationSchema.parse(created.json());
  return { invitationId: body.invitation.invitationId, token: body.token };
}

/**
 * Redeems an invitation. The joiner keeps their own organization and gains a
 * membership in the mission's, which is the real shape after redemption — no
 * test-side compensation stands between these assertions and the product.
 */
async function join(joiner: SignedIn, token: string): Promise<{ missionId: string; role: MissionRole }> {
  const redeemed = await h.app.inject({
    method: "POST",
    url: "/invitations/redeem",
    headers: bearer(joiner),
    payload: { token }
  });
  expect(redeemed.statusCode).toBe(200);
  return RedeemInvitationResponseSchema.parse(redeemed.json());
}

/** A mission with kartik controlling and the named people already joined. */
async function room(
  goal: string,
  joiners: { who: SignedIn; role?: MissionRole }[] = []
): Promise<{ missionId: string; workstreamId: string }> {
  const mission = await createMission(kartik, goal);
  for (const joiner of joiners) {
    const invitation = await invite(kartik, mission.missionId, joiner.role ?? "contributor");
    await join(joiner.who, invitation.token);
  }
  return mission;
}

async function detail(actor: SignedIn, missionId: string) {
  const response = await h.app.inject({
    method: "GET",
    url: `/missions/${missionId}`,
    headers: bearer(actor)
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

const post = (actor: SignedIn, url: string, payload: Record<string, unknown> = {}) =>
  h.app.inject({ method: "POST", url, headers: bearer(actor), payload });

const kinds = async (missionId: string): Promise<string[]> => {
  const rows = await h.db.query("select kind from events where mission_id = $1 order by seq", [missionId]);
  return rows.rows.map((row) => row.kind as string);
};

describe("invitations", () => {
  it("mints a single-use token, stores only its hash, and keeps it out of the log", async () => {
    const { missionId } = await createMission(kartik, "Rotate the signing keys");
    const { invitationId, token } = await invite(kartik, missionId);
    expect(token.length).toBeGreaterThanOrEqual(32);

    const stored = await h.db.query("select token_hash, expires_at from invitations where inv_id = $1", [
      invitationId
    ]);
    expect(stored.rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0].token_hash).not.toBe(token);
    // Seven days, single use (ARCHITECTURE.md#authentication).
    const days = (stored.rows[0].expires_at.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);

    const events = await h.db.query(
      "select payload from events where mission_id = $1 and kind = 'invitation.created'",
      [missionId]
    );
    expect(events.rowCount).toBe(1);
    expect(JSON.stringify(events.rows)).not.toContain(token);
  });

  it("lets the invited person join, and lists the redemption", async () => {
    const { missionId } = await createMission(kartik, "Add rate limiting");
    const { token } = await invite(kartik, missionId);
    const redeemed = await join(maya, token);
    expect(redeemed).toEqual({ missionId, role: "contributor" });

    const listed = await h.app.inject({
      method: "GET",
      url: `/missions/${missionId}/invitations`,
      headers: bearer(kartik)
    });
    expect(listed.statusCode).toBe(200);
    const invitation = InvitationListResponseSchema.parse(listed.json()).invitations[0];
    expect(invitation?.redeemedByLogin).toBe("maya");
    expect(invitation?.revokedAt).toBeNull();

    // Least privilege: joining an organization never makes you its owner.
    const membership = await h.db.query(
      "select org_role from organization_members where org_id = $1 and user_id = $2",
      [kartik.orgId, maya.userId]
    );
    expect(membership.rows[0].org_role).toBe("member");
    expect(await kinds(missionId)).toContain("participant.joined");
  });

  it("leaves the joiner in two organizations and still resolves the mission", async () => {
    const { missionId } = await createMission(kartik, "Two organizations, one mission");
    const { token } = await invite(kartik, missionId);
    await join(maya, token);

    // She belongs to her own organization and to the mission's.
    const memberships = await h.db.query(
      "select org_id from organization_members where user_id = $1",
      [maya.userId]
    );
    expect(memberships.rows).toHaveLength(2);
    expect(memberships.rows.map((row) => row.org_id as string)).toEqual(
      expect.arrayContaining([maya.orgId, kartik.orgId])
    );

    // Her session's organization is still her own — it scopes organization-level
    // acts, and it is not what decides mission access.
    const me = await h.app.inject({ method: "GET", url: "/me", headers: bearer(maya) });
    expect(me.json().org.orgId).toBe(maya.orgId);

    // The mission resolves anyway, scoped to the organization that owns it.
    const room = await detail(maya, missionId);
    expect(room.mission.orgId).toBe(kartik.orgId);
    expect(room.mission.orgId).not.toBe(maya.orgId);
    expect(room.capabilities).toContain("direction.submit");
  });

  it("rejects a replayed redemption", async () => {
    const { missionId } = await createMission(kartik, "Replace the queue driver");
    const { token } = await invite(kartik, missionId);
    await join(maya, token);

    const again = await post(maya, "/invitations/redeem", { token });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("invitation_redeemed");

    // And not just for the same person: the token is spent, not personal.
    const bySomeoneElse = await post(ravi, "/invitations/redeem", { token });
    expect(bySomeoneElse.statusCode).toBe(409);
    expect(bySomeoneElse.json().error.code).toBe("invitation_redeemed");
    const participants = await h.db.query("select user_id from participants where mission_id = $1", [missionId]);
    expect(participants.rowCount).toBe(2);
  });

  it("rejects an expired invitation and creates nothing", async () => {
    const { missionId } = await createMission(kartik, "Retire the legacy worker");
    const { invitationId, token } = await invite(kartik, missionId);
    await h.db.query("update invitations set expires_at = now() - interval '1 minute' where inv_id = $1", [
      invitationId
    ]);

    const redeemed = await post(ravi, "/invitations/redeem", { token });
    expect(redeemed.statusCode).toBe(410);
    expect(redeemed.json().error.code).toBe("invitation_expired");
    const participants = await h.db.query(
      "select user_id from participants where mission_id = $1 and user_id = $2",
      [missionId, ravi.userId]
    );
    expect(participants.rowCount).toBe(0);
  });

  it("rejects a revoked invitation", async () => {
    const { missionId } = await createMission(kartik, "Split the billing service");
    const { invitationId, token } = await invite(kartik, missionId);
    const revoked = await post(kartik, `/invitations/${invitationId}/revoke`);
    expect(revoked.statusCode).toBe(200);

    const redeemed = await post(ravi, "/invitations/redeem", { token });
    expect(redeemed.statusCode).toBe(409);
    expect(redeemed.json().error.code).toBe("invitation_revoked");
    expect(await kinds(missionId)).toContain("invitation.revoked");
  });

  it("refuses to revoke an invitation that was already redeemed", async () => {
    const { missionId } = await createMission(kartik, "Cache the price table");
    const { invitationId, token } = await invite(kartik, missionId);
    await join(maya, token);
    const revoked = await post(kartik, `/invitations/${invitationId}/revoke`);
    expect(revoked.statusCode).toBe(409);
    expect(revoked.json().error.code).toBe("invitation_redeemed");
  });

  it("refuses an unknown token without confirming anything", async () => {
    const redeemed = await post(maya, "/invitations/redeem", { token: "x".repeat(43) });
    expect(redeemed.statusCode).toBe(404);
    expect(redeemed.json().error.code).toBe("unknown_invitation");
  });

  it("enforces mission.invite on the server, not in the interface", async () => {
    const { missionId } = await room("Harden the webhook receiver", [{ who: maya }]);
    const created = await post(maya, `/missions/${missionId}/invitations`, { role: "contributor" });
    expect(created.statusCode).toBe(403);
    expect(created.json().error.code).toBe("forbidden");

    const listed = await h.app.inject({
      method: "GET",
      url: `/missions/${missionId}/invitations`,
      headers: bearer(maya)
    });
    expect(listed.statusCode).toBe(403);
    // Her own capability list says the same thing the server just enforced.
    expect((await detail(maya, missionId)).capabilities).not.toContain("mission.invite");
  });
});

describe("mission scoping", () => {
  it("gives a mission-X token no standing whatsoever in mission Y", async () => {
    const x = await createMission(kartik, "Mission X: rotate credentials");
    const y = await createMission(kartik, "Mission Y: unrelated work");
    const { token } = await invite(kartik, x.missionId);
    await join(maya, token);

    expect((await detail(maya, x.missionId)).mission.missionId).toBe(x.missionId);

    const other = await h.app.inject({
      method: "GET",
      url: `/missions/${y.missionId}`,
      headers: bearer(maya)
    });
    expect(other.statusCode).toBe(404); // not 403: a mission id is not probeable

    const requested = await post(maya, `/missions/${y.missionId}/control/request`);
    expect(requested.statusCode).toBe(404);
    const participants = await h.db.query("select user_id from participants where mission_id = $1", [
      y.missionId
    ]);
    expect(participants.rows.map((row) => row.user_id)).toEqual([kartik.userId]);
  });

  it("404s a non-participant who holds a valid session in the same organization", async () => {
    const joined = await createMission(kartik, "Dana's mission");
    const { token } = await invite(kartik, joined.missionId, "viewer");
    await join(dana, token);

    const closed = await createMission(kartik, "A mission dana was never invited to");
    const response = await h.app.inject({
      method: "GET",
      url: `/missions/${closed.missionId}`,
      headers: bearer(dana)
    });
    expect(response.statusCode).toBe(404);
    // Same organization — proven by the mission she *is* in resolving fine.
    expect((await detail(dana, joined.missionId)).mission.missionId).toBe(joined.missionId);
  });

  it("denies everything across organizations", async () => {
    const { missionId } = await createMission(kartik, "Org-private mission");
    // A genuine outsider: no participant row, and no membership in the
    // organization that owns the mission.
    const standing = await h.db.query(
      `select (select count(*) from participants where mission_id = $1 and user_id = $2)::int as participant,
              (select count(*) from organization_members om join missions m on m.org_id = om.org_id
                where m.mission_id = $1 and om.user_id = $2)::int as member`,
      [missionId, outsider.userId]
    );
    expect(standing.rows[0]).toEqual({ participant: 0, member: 0 });

    for (const url of [
      `/missions/${missionId}/control/request`,
      `/missions/${missionId}/control/revoke`,
      `/missions/${missionId}/invitations`
    ]) {
      const response = await post(outsider, url, { role: "contributor" });
      expect(response.statusCode).toBe(404);
    }
    const read = await h.app.inject({
      method: "GET",
      url: `/missions/${missionId}`,
      headers: bearer(outsider)
    });
    expect(read.statusCode).toBe(404);
    const list = await h.app.inject({ method: "GET", url: "/missions", headers: bearer(outsider) });
    expect(list.json().missions).toEqual([]);
  });
});

describe("requests for control", () => {
  it("keeps simultaneous requests from two people open and visible to everyone", async () => {
    const { missionId } = await room("Two people want the baton", [{ who: maya }, { who: ravi }]);
    const [first, second] = await Promise.all([
      post(maya, `/missions/${missionId}/control/request`),
      post(ravi, `/missions/${missionId}/control/request`)
    ]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    for (const viewer of [kartik, maya, ravi]) {
      const control = (await detail(viewer, missionId)).control;
      expect(control.openRequests.map((r: { requesterLogin: string }) => r.requesterLogin).sort()).toEqual([
        "maya",
        "ravi"
      ]);
      expect(control.holderUserId).toBe(kartik.userId);
    }
    expect((await detail(kartik, missionId)).overlays).toContain("control_requested");
  });

  it("treats a second request from the same person as a no-op, not a duplicate", async () => {
    const { missionId } = await room("Impatient contributor", [{ who: maya }]);
    expect((await post(maya, `/missions/${missionId}/control/request`)).statusCode).toBe(200);
    expect((await post(maya, `/missions/${missionId}/control/request`)).statusCode).toBe(200);

    const rows = await h.db.query(
      "select state from control_requests where mission_id = $1 and requester_user_id = $2",
      [missionId, maya.userId]
    );
    expect(rows.rowCount).toBe(1);
    const requested = (await kinds(missionId)).filter((kind) => kind === "control.requested");
    expect(requested).toHaveLength(1);
  });

  it("refuses a request from the person already holding control", async () => {
    const { missionId } = await room("Controller asks for their own baton");
    const response = await post(kartik, `/missions/${missionId}/control/request`);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("already_controller");
  });

  it("lets the requester withdraw, and only the controller decline", async () => {
    const { missionId } = await room("Withdrawing and declining", [{ who: maya }, { who: ravi }]);
    await post(maya, `/missions/${missionId}/control/request`);
    await post(ravi, `/missions/${missionId}/control/request`);

    const withdrawn = await post(maya, `/missions/${missionId}/control/request/withdraw`);
    expect(withdrawn.statusCode).toBe(200);
    const twice = await post(maya, `/missions/${missionId}/control/request/withdraw`);
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error.code).toBe("no_open_request");

    const raviRequest = (await detail(kartik, missionId)).control.openRequests[0];
    expect(raviRequest.requesterLogin).toBe("ravi");
    const byPeer = await post(maya, `/control/requests/${raviRequest.requestId}/decline`);
    expect(byPeer.statusCode).toBe(403); // maya is not the controller
    const byController = await post(kartik, `/control/requests/${raviRequest.requestId}/decline`);
    expect(byController.statusCode).toBe(200);
    expect((await detail(kartik, missionId)).control.openRequests).toEqual([]);
    expect(await kinds(missionId)).toEqual(
      expect.arrayContaining(["control.request_withdrawn", "control.request_declined"])
    );
  });

  it("fulfils a request against an unheld lease immediately — a claim", async () => {
    const { missionId, workstreamId } = await room("Nobody is holding it", [{ who: maya }]);
    // Lease expiry has no sweeper yet; this is the durable state one would set.
    await h.db.query("update control_leases set state = 'expired', ended_at = now() where wst_id = $1", [
      workstreamId
    ]);
    expect((await detail(maya, missionId)).control.holderUserId).toBeNull();

    const claimed = await post(maya, `/missions/${missionId}/control/request`);
    expect(claimed.statusCode).toBe(200);
    expect(OkResponseSchema.parse(claimed.json())).toEqual({ ok: true });
    const control = (await detail(maya, missionId)).control;
    expect(control.holderUserId).toBe(maya.userId);
    expect(control.state).toBe("held");
    expect(control.openRequests).toEqual([]);
    const request = await h.db.query("select state from control_requests where wst_id = $1", [workstreamId]);
    expect(request.rows[0].state).toBe("fulfilled");
    expect(await kinds(missionId)).toContain("control.granted");
  });
});

describe("handoff offers", () => {
  it("shows the offer to both people and lets the controller withdraw it", async () => {
    const { missionId } = await room("Offer then withdraw", [{ who: maya }]);
    expect((await post(kartik, `/missions/${missionId}/control/offer`, { toUserId: maya.userId })).statusCode).toBe(200);

    const offered = (await detail(maya, missionId)).control.liveOffer;
    expect(offered).toMatchObject({ fromLogin: "kartik", toLogin: "maya", state: "open" });
    expect((await detail(maya, missionId)).overlays).toContain("handoff_offered");

    const withdrawn = await post(kartik, `/control/offers/${offered.offerId}/withdraw`);
    expect(withdrawn.statusCode).toBe(200);
    expect((await detail(maya, missionId)).control.liveOffer).toBeNull();

    // Withdrawn before acceptance: accepting it now is refused, and control
    // never moved.
    const late = await post(maya, `/control/offers/${offered.offerId}/accept`);
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe("offer_settled");
    expect((await detail(maya, missionId)).control.holderUserId).toBe(kartik.userId);
  });

  it("refuses a second live offer and names the fix", async () => {
    const { missionId } = await room("One offer at a time", [{ who: maya }, { who: ravi }]);
    await post(kartik, `/missions/${missionId}/control/offer`, { toUserId: maya.userId });
    const second = await post(kartik, `/missions/${missionId}/control/offer`, { toUserId: ravi.userId });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("offer_live");
  });

  it("only the named recipient may answer an offer", async () => {
    const { missionId } = await room("The offer is addressed", [{ who: maya }, { who: ravi }]);
    await post(kartik, `/missions/${missionId}/control/offer`, { toUserId: maya.userId });
    const offerId = (await detail(kartik, missionId)).control.liveOffer.offerId;

    expect((await post(ravi, `/control/offers/${offerId}/accept`)).json().error.code).toBe("not_recipient");
    expect((await post(ravi, `/control/offers/${offerId}/decline`)).json().error.code).toBe("not_recipient");
    expect((await post(maya, `/control/offers/${offerId}/withdraw`)).json().error.code).toBe("not_offerer");

    const declined = await post(maya, `/control/offers/${offerId}/decline`);
    expect(declined.statusCode).toBe(200);
    expect((await detail(kartik, missionId)).control.holderUserId).toBe(kartik.userId);
    expect(await kinds(missionId)).toContain("control.offer_declined");
  });

  it("refuses to offer control to a non-participant or to a Viewer", async () => {
    const { missionId } = await room("Who can be offered control", [{ who: dana, role: "viewer" }]);
    const stranger = await post(kartik, `/missions/${missionId}/control/offer`, { toUserId: ravi.userId });
    expect(stranger.statusCode).toBe(422);
    expect(stranger.json().error.code).toBe("not_a_participant");

    const viewer = await post(kartik, `/missions/${missionId}/control/offer`, { toUserId: dana.userId });
    expect(viewer.statusCode).toBe(422);
    expect(viewer.json().error.code).toBe("recipient_cannot_accept");
  });

  it("resolves a double acceptance to exactly one winner and one explicit rejection", async () => {
    const { missionId } = await room("Two accepts, one baton", [{ who: maya }]);
    await post(kartik, `/missions/${missionId}/control/offer`, { toUserId: maya.userId });
    const offerId = (await detail(maya, missionId)).control.liveOffer.offerId;

    const results = await Promise.all([
      post(maya, `/control/offers/${offerId}/accept`),
      post(maya, `/control/offers/${offerId}/accept`)
    ]);
    const codes = results.map((result) => result.statusCode).sort();
    expect(codes).toEqual([200, 409]);
    const loser = results.find((result) => result.statusCode === 409);
    expect(loser?.json().error.code).toBe("offer_settled");

    const leases = await h.db.query(
      "select state from control_leases where mission_id = $1 and state in ('held', 'releasing')",
      [missionId]
    );
    expect(leases.rowCount).toBe(1); // two clients can never both hold control
  });

  it("carries its expiry on the wire, ten minutes from creation (D-092)", async () => {
    const { missionId } = await room("An offer that says when it lapses", [{ who: maya }]);
    await post(kartik, `/missions/${missionId}/control/offer`, { toUserId: maya.userId });

    const offer = (await detail(maya, missionId)).control.liveOffer;
    const minutes =
      (Date.parse(offer.expiresAt) - Date.parse(offer.createdAt)) / 60_000;
    expect(minutes).toBeGreaterThan(9.9);
    expect(minutes).toBeLessThan(10.1);
  });

  it("an unanswered offer lapses to expired with its event, and frees the slot", async () => {
    const { missionId } = await room("Nobody answered", [{ who: maya }, { who: ravi }]);
    await post(kartik, `/missions/${missionId}/control/offer`, { toUserId: maya.userId });
    const offerId = (await detail(kartik, missionId)).control.liveOffer.offerId;

    await h.db.query(
      "update handoff_offers set expires_at = now() - interval '1 second' where offer_id = $1",
      [offerId]
    );
    expect(await sweepOffers(h.db)).toBe(1);

    const lapsed = await h.db.query("select state from handoff_offers where offer_id = $1", [offerId]);
    expect(lapsed.rows[0].state).toBe("expired");
    expect(await kinds(missionId)).toContain("control.offer_expired");
    expect((await detail(kartik, missionId)).control.liveOffer).toBeNull();
    // Control never moved, and the one-live-offer slot is free again.
    expect((await detail(kartik, missionId)).control.holderUserId).toBe(kartik.userId);
    const again = await post(kartik, `/missions/${missionId}/control/offer`, { toUserId: ravi.userId });
    expect(again.statusCode).toBe(200);
  });

  it("an offer past its expiry cannot be accepted, sweep or no sweep", async () => {
    const { missionId } = await room("Too late to accept", [{ who: maya }]);
    await post(kartik, `/missions/${missionId}/control/offer`, { toUserId: maya.userId });
    const offerId = (await detail(maya, missionId)).control.liveOffer.offerId;

    await h.db.query(
      "update handoff_offers set expires_at = now() - interval '1 second' where offer_id = $1",
      [offerId]
    );
    // The sweep has not run: expiry is the offer's own fact, not its schedule.
    const late = await post(maya, `/control/offers/${offerId}/accept`);
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe("offer_settled");
    expect((await detail(maya, missionId)).control.holderUserId).toBe(kartik.userId);
  });
});

describe("transfer at a boundary", () => {
  it("completes immediately when the workstream is idle", async () => {
    const { missionId } = await room("Idle handoff", [{ who: maya }]);
    await post(maya, `/missions/${missionId}/control/request`);
    await post(kartik, `/missions/${missionId}/control/offer`, { toUserId: maya.userId });
    const offerId = (await detail(maya, missionId)).control.liveOffer.offerId;

    const accepted = await post(maya, `/control/offers/${offerId}/accept`);
    expect(accepted.statusCode).toBe(200);

    const control = (await detail(kartik, missionId)).control;
    expect(control.holderUserId).toBe(maya.userId);
    expect(control.holderLogin).toBe("maya");
    expect(control.state).toBe("held");
    expect(control.liveOffer).toBeNull();
    expect((await detail(kartik, missionId)).overlays).not.toContain("handoff_waiting_for_boundary");

    const offer = await h.db.query("select state from handoff_offers where offer_id = $1", [offerId]);
    expect(offer.rows[0].state).toBe("completed");
    const request = await h.db.query(
      "select state from control_requests where mission_id = $1 and requester_user_id = $2",
      [missionId, maya.userId]
    );
    expect(request.rows[0].state).toBe("fulfilled");
    expect(await kinds(missionId)).toEqual(
      expect.arrayContaining(["control.offered", "control.offer_accepted", "control.transferred"])
    );
  });

  it("waits at waiting_for_boundary while an execution is live, then completes on the boundary", async () => {
    const { missionId, workstreamId } = await room("Running handoff", [{ who: maya }, { who: ravi }]);
    // The execution rows are the runner slice's to write; this is the durable
    // state a live turn leaves behind, which is what the boundary rule reads.
    await h.db.query(
      `insert into executions (exe_id, org_id, mission_id, wst_id, session_id, harness, model, effort, state, started_by)
         values ($1, $2, $3, $4,
                 (select csn_id from workstream_sessions where wst_id = $4 order by created_at, csn_id limit 1),
                 'claude-code', 'claude-fable-5', 'high', 'running', $5)`,
      [`exe_${missionId.slice(4)}`, kartik.orgId, missionId, workstreamId, kartik.userId]
    );
    await post(ravi, `/missions/${missionId}/control/request`);
    await post(maya, `/missions/${missionId}/control/request`);
    await post(kartik, `/missions/${missionId}/control/offer`, { toUserId: maya.userId });
    const offerId = (await detail(maya, missionId)).control.liveOffer.offerId;
    expect((await post(maya, `/control/offers/${offerId}/accept`)).statusCode).toBe(200);

    const waiting = await detail(maya, missionId);
    expect(waiting.control.state).toBe("releasing");
    expect(waiting.control.holderUserId).toBe(kartik.userId); // still his until the boundary
    expect(waiting.control.liveOffer.state).toBe("waiting_for_boundary");
    expect(waiting.overlays).toContain("handoff_waiting_for_boundary");
    expect(await kinds(missionId)).toContain("control.waiting_for_boundary");

    // The privileged verbs still belong to the outgoing controller: the
    // recipient cannot operate the workstream before the transfer lands.
    const early = await post(maya, `/missions/${missionId}/control/offer`, { toUserId: ravi.userId });
    expect(early.statusCode).toBe(403);
    expect(early.json().error.code).toBe("forbidden");
    expect(waiting.capabilities).not.toContain("control.offer");
    const secondOffer = await post(kartik, `/missions/${missionId}/control/offer`, { toUserId: ravi.userId });
    expect(secondOffer.statusCode).toBe(409);

    // The runner declares the boundary; this is the call its ingestion makes.
    const holder = await withTransaction(h.db, (client) =>
      completeTransferAtBoundary(client, { orgId: kartik.orgId, missionId, workstreamId })
    );
    expect(holder).toBe(maya.userId);

    const settled = await detail(kartik, missionId);
    expect(settled.control.holderUserId).toBe(maya.userId);
    expect(settled.control.state).toBe("held");
    expect(settled.control.liveOffer).toBeNull();
    expect(settled.control.openRequests).toEqual([]); // ravi's closed as superseded
    const requests = await h.db.query(
      `select u.login, r.state from control_requests r join users u on u.user_id = r.requester_user_id
        where r.wst_id = $1`,
      [workstreamId]
    );
    expect(
      Object.fromEntries(requests.rows.map((row) => [row.login as string, row.state as string]))
    ).toEqual({ maya: "fulfilled", ravi: "superseded" });

    // Idempotent: a replayed boundary changes nothing.
    const again = await withTransaction(h.db, (client) =>
      completeTransferAtBoundary(client, { orgId: kartik.orgId, missionId, workstreamId })
    );
    expect(again).toBeNull();
    const leases = await h.db.query(
      "select state from control_leases where wst_id = $1 and state in ('held', 'releasing')",
      [workstreamId]
    );
    expect(leases.rowCount).toBe(1);
  });

  it("does nothing at a boundary when no handoff is pending", async () => {
    const { missionId, workstreamId } = await room("No handoff pending");
    const holder = await withTransaction(h.db, (client) =>
      completeTransferAtBoundary(client, { orgId: kartik.orgId, missionId, workstreamId })
    );
    expect(holder).toBeNull();
    expect((await detail(kartik, missionId)).control.holderUserId).toBe(kartik.userId);
  });
});

describe("the previous controller loses authority", () => {
  it("strips the lease verbs the moment control transfers, and rejects the calls", async () => {
    const { missionId } = await room("The rule the demo turns on", [{ who: maya }]);
    const before = await detail(kartik, missionId);
    expect(before.capabilities).toEqual(expect.arrayContaining(["direction.apply", "control.offer"]));

    // A non-controller's direction queues for whoever holds the baton; it is
    // the thing `direction.apply` decides, so it is the honest probe for the
    // rule below.
    const submitted = await post(maya, `/missions/${missionId}/direction`, {
      body: "Check the migration against the staging snapshot first",
      model: "claude-fable-5",
      effort: "high"
    });
    expect(submitted.statusCode).toBe(200);
    const directionId = submitted.json().direction.directionId;

    await post(kartik, `/missions/${missionId}/control/offer`, { toUserId: maya.userId });
    const offerId = (await detail(maya, missionId)).control.liveOffer.offerId;
    expect((await post(maya, `/control/offers/${offerId}/accept`)).statusCode).toBe(200);

    // Capabilities are role ∪ lease, recomputed from durable state per request:
    // the lease verbs left with the lease.
    const after = await detail(kartik, missionId);
    expect(after.capabilities).not.toContain("direction.apply");
    expect(after.capabilities).not.toContain("control.offer");
    expect(after.capabilities).toContain("mission.invite"); // his role is untouched
    const mayaNow = await detail(maya, missionId);
    expect(mayaNow.capabilities).toEqual(
      expect.arrayContaining(["direction.apply", "control.offer", "execution.start"])
    );

    // Hiding a button is not enforcement: the server rejects the calls.
    const stale = await post(kartik, `/missions/${missionId}/control/offer`, { toUserId: maya.userId });
    expect(stale.statusCode).toBe(403);
    expect(stale.json().error.code).toBe("forbidden");
    expect(stale.json().error.message).toBe("Only the controller can do that.");

    const staleApply = await post(kartik, `/directions/${directionId}/resolve`, {
      action: "reject",
      reason: "I still think I run this room"
    });
    expect(staleApply.statusCode).toBe(403);
    expect(staleApply.json().error.code).toBe("forbidden");
    // The new controller decides it instead.
    expect((await post(maya, `/directions/${directionId}/resolve`, { action: "reject" })).statusCode).toBe(200);

    // And the same holds in the other direction: handing the baton back strips
    // maya's lease-granted execution.start, which her Contributor role never had.
    await post(maya, `/missions/${missionId}/control/offer`, { toUserId: kartik.userId });
    const backId = (await detail(kartik, missionId)).control.liveOffer.offerId;
    expect((await post(kartik, `/control/offers/${backId}/accept`)).statusCode).toBe(200);
    const mayaAfter = await detail(maya, missionId);
    expect(mayaAfter.capabilities).not.toContain("execution.start");
    expect(mayaAfter.capabilities).not.toContain("direction.apply");
    expect(mayaAfter.capabilities).toContain("direction.submit"); // still not a spectator
  });
});

describe("Mission Admin revocation", () => {
  it("force-takes the lease, closes what was pending, and logs it", async () => {
    const { missionId } = await room("Revocation", [{ who: maya }, { who: ravi }]);
    await post(kartik, `/missions/${missionId}/control/offer`, { toUserId: maya.userId });
    const offerId = (await detail(maya, missionId)).control.liveOffer.offerId;
    expect((await post(maya, `/control/offers/${offerId}/accept`)).statusCode).toBe(200);
    expect((await detail(kartik, missionId)).control.holderUserId).toBe(maya.userId);

    // Maya, now the controller, has a request and an offer in flight.
    await post(ravi, `/missions/${missionId}/control/request`);
    await post(maya, `/missions/${missionId}/control/offer`, { toUserId: ravi.userId });

    const revoked = await post(kartik, `/missions/${missionId}/control/revoke`);
    expect(revoked.statusCode).toBe(200);

    const control = (await detail(ravi, missionId)).control;
    expect(control.holderUserId).toBe(kartik.userId);
    expect(control.state).toBe("held");
    expect(control.liveOffer).toBeNull();
    expect(control.openRequests).toEqual([]);

    const rows = await h.db.query(
      "select state from control_leases where mission_id = $1 and holder_user_id = $2",
      [missionId, maya.userId]
    );
    expect(rows.rows.map((row) => row.state as string)).toContain("revoked");
    const offers = await h.db.query("select state from handoff_offers where mission_id = $1 order by created_at", [
      missionId
    ]);
    expect(offers.rows.map((row) => row.state as string)).toEqual(["completed", "failed"]);
    expect(await kinds(missionId)).toEqual(
      expect.arrayContaining(["control.revoked", "control.offer_failed", "control.requests_superseded"])
    );
    expect((await detail(maya, missionId)).capabilities).not.toContain("control.offer");
  });

  it("refuses revocation to anyone but a Mission Admin", async () => {
    const { missionId } = await room("Only the admin revokes", [{ who: maya }]);
    const response = await post(maya, `/missions/${missionId}/control/revoke`);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("forbidden");
    expect((await detail(kartik, missionId)).control.holderUserId).toBe(kartik.userId);
  });
});

describe("two-client reconstruction", () => {
  it("shows both sessions the same participants, control snapshot, and holder", async () => {
    const { missionId } = await room("One room, two clients", [{ who: maya }, { who: ravi }]);
    await post(ravi, `/missions/${missionId}/control/request`);
    await post(kartik, `/missions/${missionId}/control/offer`, { toUserId: maya.userId });

    // Both clients poll before comparing: a participant's connection state is
    // earned by their own reading (D-091), so the first read of a room whose
    // second person has never polled honestly says that person is offline.
    // Once both have read, the rooms agree — including on presence.
    await detail(kartik, missionId);
    await detail(maya, missionId);
    const asKartik = await detail(kartik, missionId);
    const asMaya = await detail(maya, missionId);

    expect(asMaya.participants).toEqual(asKartik.participants);
    expect(asMaya.control).toEqual(asKartik.control);
    expect(asMaya.control.holderLogin).toBe("kartik");
    expect(asMaya.events.map((event: { seq: number }) => event.seq)).toEqual(
      asKartik.events.map((event: { seq: number }) => event.seq)
    );
    expect(asMaya.overlays).toEqual(asKartik.overlays);

    // What differs is only what is personal: who you are and what you may do.
    expect(asKartik.viewerUserId).toBe(kartik.userId);
    expect(asMaya.viewerUserId).toBe(maya.userId);
    expect(asMaya.capabilities).not.toEqual(asKartik.capabilities);
    expect(asKartik.participants.map((p: { login: string; isController: boolean }) => [p.login, p.isController])).toEqual([
      ["kartik", true],
      ["maya", false],
      ["ravi", false]
    ]);
  });
});
