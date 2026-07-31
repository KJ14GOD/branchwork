/**
 * The shape of `GET /sessions/:id/authority`.
 *
 * **This belongs in `packages/contracts/src/protocol.ts` as a Zod schema,
 * beside `PresenceResponseSchema`, and is here as plain types only because the
 * contract lock was held by another slice when this landed.** It is the same
 * kind of thing that schema exists for: a worker response a renderer parses,
 * which read as an unvalidated plain shape until somebody noticed. `zod` is
 * not a dependency of `apps/desktop` — deliberately, since the shared package
 * is where boundary schemas go — so the interim here validates by hand.
 *
 * Moving it: add `AuthorityResponseSchema` to protocol.ts, delete this file,
 * and repoint `use-authority.ts` and `components/control-panel.tsx`. The hand
 * check below goes away with it.
 *
 * Until then nothing but this comment stops these types drifting from what
 * `event-server.ts` actually sends, which is precisely why they should not
 * stay here.
 */

export type ControlOfferView = {
  offerEventId: string;
  fromParticipantId: string;
  toParticipantId: string;
  /** Waiting on the recipient, or waiting on a safe boundary. */
  state: "offered" | "accepted";
  offeredAt: string;
  acceptedAt: string | null;
};

export type Authority = {
  /** Which participant the calling token is. Null on a tokenless worker. */
  you: string | null;
  controlHeldBy: string | null;
  controlOffer: ControlOfferView | null;
  controlRequests: {
    eventId: string;
    participantId: string;
    reason: string | null;
    requestedAt: string;
  }[];
  pendingDirection: {
    eventId: string;
    direction: string;
    submittedAt: string;
    /** Non-null means a live run has committed to folding it in. */
    queuedForRunId: string | null;
    queuedAt: string | null;
  }[];
  /** What a waiting transfer is waiting on. */
  executingRunIds: string[];
};

/**
 * Enough of a check to refuse a response this screen cannot render.
 *
 * Not a substitute for the schema — it does not inspect the arrays' contents,
 * which a Zod schema would. It exists so a worker answering something
 * unexpected leaves the panel empty rather than throwing inside a render.
 */
export const isAuthority = (value: unknown): value is Authority => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    (candidate["you"] === null || typeof candidate["you"] === "string") &&
    (candidate["controlHeldBy"] === null ||
      typeof candidate["controlHeldBy"] === "string") &&
    (candidate["controlOffer"] === null ||
      typeof candidate["controlOffer"] === "object") &&
    Array.isArray(candidate["controlRequests"]) &&
    Array.isArray(candidate["pendingDirection"]) &&
    Array.isArray(candidate["executingRunIds"])
  );
};
