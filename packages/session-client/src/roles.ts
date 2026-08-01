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
 *
 * `finish` is `POST /sessions/:id/complete` and `/reopen`, and a client may
 * render off it: it is the one judgement bit with a route behind it. It is
 * separate from `approve` even though the same three roles hold both, because
 * `approve` means saying yes to a tool call and fusing the two would make them
 * impossible to separate once the approval route exists.
 *
 * `decide` is `POST /sessions/:id/decision`, and it is owner-only for V1
 * because that route both settles the comparison and writes the chosen files.
 * A joined window renders no decision surface at all today, so this is here to
 * keep the mirror honest before one does, rather than to hide a control that
 * exists.
 */

export type ParticipantRole = "owner" | "editor" | "reviewer" | "viewer";

export type ParticipantCapability =
  | "watch"
  | "direct"
  | "approve"
  | "finish"
  | "steer"
  | "decide"
  | "invite"
  | "transfer";

const ROLE_CAPABILITIES = {
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
