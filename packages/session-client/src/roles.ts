/**
 * What each role may do, as the client understands it.
 *
 * A deliberate mirror of the one authoritative table in
 * `apps/worker/src/participants.ts` — the worker enforces this per route, and
 * nothing a client renders can widen it. The mirror exists so a joined window
 * can *hide* what would 403 instead of offering a control that fails on
 * click; if the two tables ever disagree, the worker wins and the UI is
 * merely wrong about what to show, never about what happens.
 *
 * Read down: every role can do everything the one below it can. `approve` is
 * listed for parity with the server's table, but no HTTP surface exists for
 * it yet — approvals are policy-level on the host — so a client should not
 * render an approve control off the back of it.
 */

export type ParticipantRole = "owner" | "editor" | "reviewer" | "viewer";

export type ParticipantCapability =
  | "watch"
  | "direct"
  | "approve"
  | "steer"
  | "invite"
  | "transfer";

const ROLE_CAPABILITIES = {
  owner: ["watch", "direct", "approve", "steer", "invite", "transfer"],
  editor: ["watch", "direct", "approve", "steer"],
  reviewer: ["watch", "approve"],
  viewer: ["watch"],
} as const satisfies Record<ParticipantRole, readonly ParticipantCapability[]>;

export const roleAllows = (
  role: ParticipantRole,
  capability: ParticipantCapability,
): boolean =>
  (ROLE_CAPABILITIES[role] as readonly string[]).includes(capability);

/** One line a join screen can show beside the role it was given. */
export const describeRole = (role: ParticipantRole): string => {
  switch (role) {
    case "owner":
      return "Owner — controls the session";
    case "editor":
      return "Editor — can add direction and steer the run";
    case "reviewer":
      return "Reviewer — can watch and approve";
    case "viewer":
      return "Viewer — read-only";
  }
};
