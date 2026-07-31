import type { SessionEvent } from "@novus/contracts";
import type { Comparison } from "@novus/contracts/protocol";

/**
 * Where a mission has actually got to.
 *
 * The rail told you what had *happened* — counts of events, tool calls,
 * patches — and never where the work stood or what it was waiting for. Those
 * are different questions, and a person opening a tab is asking the second
 * one. STEERING calls this the decision spine and asks for it to become a
 * recognisable signature of the product: brief, execution, approaches,
 * decision, receipt, each with one status.
 *
 * Derived, never stored. Every input is already on the log, and a phase that
 * was written down separately would be a second source of truth to disagree
 * with the timeline sitting beside it.
 *
 * Deliberately in the desktop rather than in `packages/ui`: the guest should
 * eventually show the same ladder, but sharing it means agreeing on where the
 * comparison comes from for a relay-fed guest, and that is a decision worth
 * making on purpose rather than by moving a file.
 */

export type PhaseStatus =
  | "complete"
  | "active"
  /** Waiting on a person. The only status that should draw the eye. */
  | "needs-attention"
  | "blocked"
  | "not-started";

export type MissionPhase = {
  key: "brief" | "execution" | "approaches" | "decision" | "receipt";
  label: string;
  status: PhaseStatus;
  /** One short line about *this* phase, or null when there is nothing to add. */
  detail: string | null;
};

export const missionPhases = (
  events: readonly SessionEvent[],
  comparison: Comparison | null,
): MissionPhase[] => {
  const runs = events.filter((event) => event.type === "run.started");
  const running = new Set<string>();
  let awaitingApproval = false;
  const answered = new Set<string>();

  for (const event of events) {
    if (event.type === "run.started") {
      running.add(event.payload.run.id);
    }

    if (
      event.type === "run.completed" ||
      event.type === "run.failed" ||
      event.type === "run.cancelled" ||
      event.type === "run.paused"
    ) {
      running.delete(event.payload.runId);
    }

    if (event.type === "tool.approved" || event.type === "tool.denied") {
      answered.add(event.payload.toolCallId);
    }
  }

  for (const event of events) {
    if (
      event.type === "tool.approval_requested" &&
      !answered.has(event.payload.call.id)
    ) {
      awaitingApproval = true;
    }
  }

  const attempts = comparison?.attempts ?? [];
  const alternatives = attempts.filter((attempt) => !attempt.baseline);
  const decision = comparison?.decision ?? null;
  const settled = alternatives.every(
    (attempt) => attempt.status !== "running" && attempt.status !== "paused",
  );

  // A brief exists the moment somebody has asked for something. Before that
  // the mission is a repository and an intention, which is the one state where
  // this phase is the active one.
  const brief: MissionPhase =
    runs.length === 0
      ? { key: "brief", label: "Brief", status: "active", detail: "Say what you want done" }
      : { key: "brief", label: "Brief", status: "complete", detail: null };

  const execution: MissionPhase =
    runs.length === 0
      ? { key: "execution", label: "Execution", status: "not-started", detail: null }
      : awaitingApproval
        ? {
            key: "execution",
            label: "Execution",
            status: "needs-attention",
            detail: "Waiting on your approval",
          }
        : running.size > 0
          ? { key: "execution", label: "Execution", status: "active", detail: "Working" }
          : { key: "execution", label: "Execution", status: "complete", detail: null };

  const approaches: MissionPhase =
    alternatives.length === 0
      ? {
          key: "approaches",
          label: "Approaches",
          status: runs.length === 0 ? "not-started" : "active",
          // Not a nag. It says what the phase is for, so somebody who has never
          // forked learns what the option is without being pushed into it.
          detail: runs.length === 0 ? null : "One approach — the current work",
        }
      : alternatives.some((attempt) => attempt.status === "running")
        ? {
            key: "approaches",
            label: "Approaches",
            status: "active",
            detail: `${attempts.length} approaches, some still working`,
          }
        : {
            key: "approaches",
            label: "Approaches",
            status: "complete",
            detail: `${attempts.length} approaches`,
          };

  // The one phase allowed to demand attention on its own. Alternatives that
  // have all stopped with nothing recorded is precisely the state this whole
  // product exists to put in front of a person.
  const decisionPhase: MissionPhase =
    decision !== null
      ? {
          key: "decision",
          label: "Decision",
          status: "complete",
          detail:
            decision.kind === "revision"
              ? "Revision requested"
              : decision.kind === "exploration"
                ? "Still exploring"
                : "Adopted",
        }
      : alternatives.length === 0
        ? { key: "decision", label: "Decision", status: "not-started", detail: null }
        : settled
          ? {
              key: "decision",
              label: "Decision",
              status: "needs-attention",
              detail: "Approaches are waiting on you",
            }
          : { key: "decision", label: "Decision", status: "not-started", detail: null };

  // Applied is the only thing that makes a receipt final. A decision recorded
  // and blocked by conflicts is a real decision with an unfinished tail, and
  // showing it complete would tell somebody their change had landed.
  const receipt: MissionPhase =
    decision === null
      ? { key: "receipt", label: "Receipt", status: "not-started", detail: null }
      : decision.outcome.applied
        ? { key: "receipt", label: "Receipt", status: "complete", detail: "Applied" }
        : decision.kind === "adopt"
          ? {
              key: "receipt",
              label: "Receipt",
              status: "blocked",
              detail: "Recorded, not applied",
            }
          : { key: "receipt", label: "Receipt", status: "complete", detail: "Nothing applied" };

  return [brief, execution, approaches, decisionPhase, receipt];
};
