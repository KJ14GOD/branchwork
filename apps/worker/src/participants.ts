import { ParticipantSchema, type Participant } from "@novus/contracts";

import { mintAccessToken } from "./access.ts";

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

/** What each role may do. Read down: every role can do everything below it. */
const CAPABILITIES = {
  owner: ["watch", "direct", "approve", "steer", "invite", "transfer"],
  editor: ["watch", "direct", "approve", "steer"],
  reviewer: ["watch", "direct", "approve"],
  viewer: ["watch"],
} as const satisfies Record<Role, readonly string[]>;

export type Capability = (typeof CAPABILITIES)[Role][number];

export const roleCan = (role: Role, capability: Capability): boolean =>
  (CAPABILITIES[role] as readonly string[]).includes(capability);

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
