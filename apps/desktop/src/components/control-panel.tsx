import { useState } from "react";

import type { Authority } from "@novus/contracts/protocol";
import type { PresenceEntry } from "../use-presence.ts";

/**
 * Who holds control, who is asking for it, and what a handoff is doing.
 *
 * Two surfaces over one piece of state, the same split presence already makes:
 * a compact `<ControlBaton>` in the session bar for the glance, and the rail's
 * `<ControlPanel>` where the lifecycle is legible and actionable.
 *
 * Every action here is rendered only when the person looking may take it. That
 * is deliberate and it is not the same as disabling: STEERING §10 asks for
 * roles that are structural rather than cosmetic, and a greyed-out "Offer
 * control" still tells a viewer that offering control is a thing this screen
 * does and they are being denied it, which is a worse answer than the honest
 * one. The worker refuses these calls independently — the absence of a button
 * is not the security boundary, it is the interface agreeing with it.
 */

const nameOf = (
  participants: readonly PresenceEntry[],
  participantId: string | null,
): string | null => {
  if (participantId === null) {
    return null;
  }

  return (
    participants.find((entry) => entry.id === participantId)?.name ??
    // A participant the roster no longer carries. Naming them "someone" beats
    // printing a UUID at a person, and beats implying nobody holds control.
    "Someone who has left"
  );
};

export type ControlProps = {
  authority: Authority;
  participants: readonly PresenceEntry[];
  onOffer: (toParticipantId: string) => void;
  onRequest: (reason?: string) => void;
  onAnswer: (
    offerEventId: string,
    answer: "accept" | "decline" | "withdraw",
  ) => void;
};

/** The one-line version, for the session bar. */
export const ControlBaton = ({
  authority,
  participants,
}: Pick<ControlProps, "authority" | "participants">) => {
  const { you, controlHeldBy, controlOffer, controlRequests } = authority;

  // Nothing to say on a worker with no participant registry — the single-user
  // path, where "who is in control" is not a question anybody is asking.
  if (you === null) {
    return null;
  }

  const holder =
    controlHeldBy === null
      ? "Nobody in control"
      : controlHeldBy === you
        ? "You in control"
        : `${nameOf(participants, controlHeldBy)} in control`;

  const waiting =
    controlOffer !== null
      ? controlOffer.state === "accepted"
        ? "Transfer pending"
        : "Handoff offered"
      : controlRequests.length > 0
        ? `${controlRequests.length} asking`
        : null;

  return (
    <span
      className={`baton${controlHeldBy === you ? " baton--yours" : ""}`}
      title={
        waiting
          ? `${holder} · ${waiting} — see Control in the rail`
          : "Who holds execution authority for this mission"
      }
    >
      <span className="baton__mark" />
      {holder}
      {waiting ? <span className="baton__count">{waiting}</span> : null}
    </span>
  );
};

/** The rail section: the lifecycle, and whatever the viewer may do about it. */
export const ControlPanel = ({
  authority,
  participants,
  onOffer,
  onRequest,
  onAnswer,
}: ControlProps) => {
  const { you, controlHeldBy, controlOffer, controlRequests, executingRunIds } =
    authority;
  const [reason, setReason] = useState("");

  if (you === null) {
    return null;
  }

  const yoursToGive = controlHeldBy === you;
  const offeredToYou = controlOffer?.toParticipantId === you;
  const offeredByYou = controlOffer?.fromParticipantId === you;
  const alreadyAsked = controlRequests.some(
    (request) => request.participantId === you,
  );

  return (
    <div className="rail__section">
      <div className="eyebrow">Control</div>

      <div className="control__held">
        {controlHeldBy === null
          ? "Nobody holds control."
          : yoursToGive
            ? "You are in control."
            : `${nameOf(participants, controlHeldBy)} is in control.`}
      </div>

      {controlOffer !== null ? (
        <div className="control__offer">
          <div className="control__offer-state">
            {controlOffer.state === "accepted"
              ? executingRunIds.length > 0
                ? // The middle state, said out loud. Three steps, not two: the
                  // recipient has agreed and control has not moved, and a
                  // screen that showed only "offered" or only "moved" would be
                  // wrong for however long a run takes to reach a boundary.
                  `${nameOf(participants, controlOffer.toParticipantId)} accepted — control transfers at the next safe boundary.`
                : `${nameOf(participants, controlOffer.toParticipantId)} accepted. Control is moving.`
              : offeredToYou
                ? `${nameOf(participants, controlOffer.fromParticipantId)} is offering you control.`
                : `Control offered to ${nameOf(participants, controlOffer.toParticipantId)} — waiting for them to accept.`}
          </div>

          <div className="control__actions">
            {offeredToYou && controlOffer.state === "offered" ? (
              <>
                <button
                  className="button button--primary"
                  type="button"
                  onClick={() => onAnswer(controlOffer.offerEventId, "accept")}
                >
                  Accept control
                </button>
                <button
                  className="button"
                  type="button"
                  onClick={() => onAnswer(controlOffer.offerEventId, "decline")}
                >
                  Decline
                </button>
              </>
            ) : null}
            {offeredByYou ? (
              <button
                className="button"
                type="button"
                onClick={() => onAnswer(controlOffer.offerEventId, "withdraw")}
                title="Take the offer back — they may be away"
              >
                Withdraw offer
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {controlRequests.length > 0 ? (
        <div className="control__requests">
          {controlRequests.map((request) => (
            <div key={request.eventId} className="control__request">
              <span className="control__request-who">
                {request.participantId === you
                  ? "You requested control"
                  : `${nameOf(participants, request.participantId)} requested control`}
              </span>
              {request.reason ? (
                <span className="control__request-why">{request.reason}</span>
              ) : null}
              {yoursToGive &&
              request.participantId !== you &&
              controlOffer === null ? (
                <button
                  className="button"
                  type="button"
                  onClick={() => onOffer(request.participantId)}
                >
                  Offer control
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {!yoursToGive && !offeredToYou && !alreadyAsked ? (
        <form
          className="control__ask"
          onSubmit={(event) => {
            event.preventDefault();
            onRequest(reason.trim() === "" ? undefined : reason.trim());
            setReason("");
          }}
        >
          <input
            className="control__reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why you want it (optional)"
            aria-label="Reason for requesting control"
          />
          <button className="button" type="submit">
            Request control
          </button>
        </form>
      ) : null}

      {/*
        Offering to somebody who has not asked. Only rendered while the offer
        is the viewer's to make and none is already in flight — the worker
        refuses a second offer with a 409, and a button that exists only to
        produce one is a button that lies about what it does.
      */}
      {yoursToGive && controlOffer === null ? (
        <div className="control__hand">
          {participants
            .filter(
              (entry) =>
                entry.id !== you &&
                !controlRequests.some(
                  (request) => request.participantId === entry.id,
                ),
            )
            .map((entry) => (
              <button
                key={entry.id}
                className="button"
                type="button"
                onClick={() => onOffer(entry.id)}
                title={`Offer control to ${entry.name}. They decide whether to take it.`}
              >
                Offer to {entry.name}
              </button>
            ))}
        </div>
      ) : null}
    </div>
  );
};

/**
 * Direction that has been said and not yet acted on.
 *
 * The distinction this draws is the whole reason `direction.queued` exists.
 * "Submitted" is one word for two different promises: with an execution
 * running, that execution folds it in at its next turn boundary and the person
 * who typed it can expect it to matter within the minute; with nothing
 * running, it is recorded and waits for whatever runs next, which may be never.
 */
export const PendingDirection = ({
  pending,
}: {
  pending: Authority["pendingDirection"];
}) => {
  if (pending.length === 0) {
    return null;
  }

  return (
    <div className="rail__section">
      <div className="eyebrow">Direction</div>
      <div className="pending">
        {pending.map((entry) => (
          <div key={entry.eventId} className="pending__row">
            <span
              className={`pending__state${entry.queuedForRunId ? " pending__state--queued" : ""}`}
            >
              {entry.queuedForRunId ? "Queued" : "Waiting"}
            </span>
            <span className="pending__what">
              <span className="pending__text">{entry.direction}</span>
              <span className="pending__when">
                {entry.queuedForRunId
                  ? "The running execution folds this in at its next turn."
                  : "Recorded — it waits for the next execution."}
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};
