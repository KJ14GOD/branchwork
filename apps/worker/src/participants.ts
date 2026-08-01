import { ParticipantSchema, type Participant } from "@novus/contracts";

import { mintAccessToken } from "./access.ts";
import type { ControlOffer, SessionProjection } from "./projection.ts";

/**
 * Who holds which token, and therefore who may do what.
 *
 * Access control started as one token: hold it and you are the host. That is
 * the right shape for a single-user harness and the wrong one the moment a
 * second person is invited, because a role nobody can attribute is not a role.
 * `POST /sessions/:id/turns` cannot ask "is this caller allowed to steer the
 * run" while every caller is indistinguishable.
 *
 * So a token identifies a participant, and a participant carries a role. The
 * host's own token is the owner's — minted at start-up like before, so nothing
 * about the single-user path changes — and an invite mints another with a role
 * the owner chose.
 *
 * In memory on purpose. A token that outlives the process that issued it is a
 * credential somebody still holds for a session that no longer exists, and V1
 * has no story for revoking one.
 */

export type Role = Participant["role"];

/**
 * The session id the host's own participant carries.
 *
 * The owner is the person running the worker, and the worker outlives any one
 * session — it can open a repository, close it, and open another. So the host's
 * participant is not bound to a session the way an invited one is, and this
 * sentinel says so out loud rather than leaving a bare string to be guessed at.
 */
export const HOST_SESSION = "host";

/**
 * What each role may do, taken from README's four definitions rather than from
 * a guess at what sounds reasonable.
 *
 * "Editor: adds direction and can operate within granted permissions."
 * "Reviewer: comments, evaluates, and approves without directly executing."
 *
 * Direction belongs to the editor. A reviewer had it here, which read as
 * harmless — direction only reaches the model at a turn boundary and cannot
 * interrupt a tool call — and was not: direction is free text appended to the
 * goal, so anybody who can submit it can tell the agent to do something else.
 * Granting it to the role defined as approving *without executing* handed that
 * role the power the definition withholds, through a text field.
 *
 * `decide` is its own capability and not a shade of `steer`, which is what
 * `/decision` used to inherit by being unlisted in the route table. Steering is
 * telling a run in flight what to do next — pause it, cancel it, resume it —
 * and it is reversible by the next instruction. Deciding ends the comparison:
 * it is the one act this product exists for, it is the last word on which work
 * survives, and while selection and application share a route it also writes
 * the chosen files into the repository. An editor can steer, so an editor was
 * silently the final authority on every mission they were invited to.
 *
 * Owner only, for V1, and that is a floor rather than a judgement about
 * reviewers: a reviewer is defined as approving *without directly executing*,
 * and this route both selects and applies. Widening it is a real question, and
 * the honest time to answer it is when selecting and applying are separately
 * permissioned — see the gaps register in PROGRESS.md. Control handoff moves
 * the owner role itself (`transferOwnership`), so "the owner" and "whoever
 * holds control" are the same person here by construction.
 *
 * Read down: every role can do everything the one below it can.
 */
/**
 * `finish` is its own bit rather than a second job for `approve`.
 *
 * They are held by the same three roles today, which is exactly why it is
 * worth separating them now: `approve` already has a reserved meaning — saying
 * yes to a tool call the agent proposed — and it simply has no HTTP surface
 * yet, because approvals are still a static allow-list built at session
 * creation. Ending a mission was the first route that needed a judgement bit,
 * and spending `approve` on it would have permanently fused "you may approve
 * my agent's writes" to "you may declare my mission over". Those come apart
 * the moment the approval route lands, and a fused bit cannot be split without
 * a breaking change to every role.
 *
 * Read down: every role can do everything the one below it can.
 */
const CAPABILITIES = {
  owner: [
    "watch",
    "direct",
    "approve",
    "finish",
    "steer",
    "decide",
    "invite",
    "transfer",
  ],
  editor: ["watch", "direct", "approve", "finish", "steer"],
  reviewer: ["watch", "approve", "finish"],
  viewer: ["watch"],
} as const satisfies Record<Role, readonly string[]>;

export type Capability = (typeof CAPABILITIES)[Role][number];

export const roleCan = (role: Role, capability: Capability): boolean =>
  (CAPABILITIES[role] as readonly string[]).includes(capability);

/**
 * Why a control action was refused, in the shape a route can answer with.
 *
 * Separate from `roleCan` because the handoff lifecycle asks a different
 * question. A capability asks what someone's rank permits. A handoff asks
 * whether this particular person is the one the log says may act right now —
 * the holder of control, or the participant an offer names. Those cannot be
 * answered from a role: control is offered *to* people who do not have it yet,
 * so the recipient of an offer is frequently a viewer, and gating acceptance on
 * rank would mean the only people allowed to accept control are the people who
 * least need to be handed it.
 */
export type AuthorityRefusal = { status: number; error: string };

/**
 * Whether this caller may offer control to that participant.
 *
 * Two rules, and the second one has a deliberate hole in it.
 *
 * You must hold control to offer it — otherwise two people could each offer a
 * baton neither is holding, and whichever offer was accepted last would win a
 * race nobody could see. But when *nobody* holds control the rule cannot apply:
 * the previous holder left, the projection set `controlHeldBy` to null, and
 * requiring the holder's identity would wedge the session with no way to ever
 * name a new controller. So an unheld baton falls back to the capability table,
 * which is checked before this function runs and admits only roles carrying
 * `transfer`.
 */
export const refuseControlOffer = (
  projection: Pick<SessionProjection, "controlHeldBy" | "controlOffer">,
  fromParticipantId: string,
  toParticipantId: string,
): AuthorityRefusal | null => {
  if (projection.controlOffer !== null) {
    return {
      status: 409,
      error:
        "A handoff is already in flight. Withdraw it before offering control to somebody else.",
    };
  }

  if (fromParticipantId === toParticipantId) {
    return { status: 400, error: "Control cannot be offered to its own holder." };
  }

  if (
    projection.controlHeldBy !== null &&
    projection.controlHeldBy !== fromParticipantId
  ) {
    return {
      status: 409,
      error: "Only whoever holds control can offer it.",
    };
  }

  return null;
};

/** Answering an offer: accept and decline are the recipient's, withdraw the offerer's. */
export type HandoffAnswerKind = "accept" | "decline" | "withdraw";

/**
 * Whether this caller may answer that offer.
 *
 * The offer id is checked rather than assumed. An answer arrives from a client
 * that rendered some state, and that state can be stale — the offer it is
 * answering may already have been withdrawn and a different one made in its
 * place. Pinning the id means a stale answer is refused instead of quietly
 * settling an offer the answerer never saw.
 *
 * Accepting twice is refused because acceptance is not idempotent from where
 * the participant sits: the first acceptance may still be waiting on a running
 * execution, and a second one that returned 202 would read as "it went through
 * this time".
 */
export const refuseHandoffAnswer = (
  offer: ControlOffer | null,
  offerEventId: string,
  callerId: string,
  answering: HandoffAnswerKind,
): AuthorityRefusal | null => {
  if (offer === null) {
    return { status: 409, error: "There is no handoff in flight to answer." };
  }

  if (offer.offerEventId !== offerEventId) {
    return {
      status: 409,
      error: "That offer has been settled; a different handoff is in flight.",
    };
  }

  if (answering === "withdraw") {
    return offer.fromParticipantId === callerId
      ? null
      : { status: 403, error: "Only whoever offered control can withdraw it." };
  }

  if (offer.toParticipantId !== callerId) {
    return { status: 403, error: "That handoff was offered to somebody else." };
  }

  if (answering === "accept" && offer.state === "accepted") {
    return {
      status: 409,
      error:
        "You already accepted this handoff. Control moves when the running execution reaches a safe boundary.",
    };
  }

  return null;
};

export type Membership = {
  participant: Participant;
  token: string;
  /** Distinct from membership: a participant who has left is still a member. */
  connected: boolean;
};

export class ParticipantRegistry {
  private readonly byToken = new Map<string, Membership>();

  /**
   * Adds a participant and returns their token.
   *
   * The token is returned once and never stored anywhere it can be read back —
   * it is the caller's job to deliver it. A registry that could re-issue a
   * participant's credential on request would be a way to impersonate them.
   */
  add(
    input: Omit<Participant, "id" | "joinedAt"> & { id?: string },
    token = mintAccessToken(),
  ): Membership {
    const participant = ParticipantSchema.parse({
      id: input.id ?? crypto.randomUUID(),
      sessionId: input.sessionId,
      name: input.name,
      kind: input.kind,
      role: input.role,
      joinedAt: new Date().toISOString(),
    });

    const membership: Membership = { participant, token, connected: false };
    this.byToken.set(token, membership);

    return membership;
  }

  /** The participant a token names, or null. Never throws on a bad token. */
  resolve(token: string | null): Membership | null {
    if (token === null) {
      return null;
    }

    return this.byToken.get(token) ?? null;
  }

  byId(participantId: string): Membership | null {
    for (const membership of this.byToken.values()) {
      if (membership.participant.id === participantId) {
        return membership;
      }
    }

    return null;
  }

  forSession(sessionId: string): Membership[] {
    return [...this.byToken.values()].filter(
      (membership) => membership.participant.sessionId === sessionId,
    );
  }

  setConnected(participantId: string, connected: boolean): Membership | null {
    const membership = this.byId(participantId);

    if (membership) {
      membership.connected = connected;
    }

    return membership;
  }

  /**
   * Moves a role from one participant to another.
   *
   * Control is a role change, not a flag: the previous owner becomes an editor
   * rather than losing the session, because V1 says a handoff transfers
   * execution authority and nothing else. Someone who hands over control is
   * still in the room and still able to direct.
   */
  transferOwnership(fromId: string, toId: string): boolean {
    const from = this.byId(fromId);
    const to = this.byId(toId);

    if (!from || !to || from.participant.role !== "owner") {
      return false;
    }

    from.participant = { ...from.participant, role: "editor" };
    to.participant = { ...to.participant, role: "owner" };

    return true;
  }

  remove(participantId: string): boolean {
    for (const [token, membership] of this.byToken.entries()) {
      if (membership.participant.id === participantId) {
        this.byToken.delete(token);

        return true;
      }
    }

    return false;
  }
}
