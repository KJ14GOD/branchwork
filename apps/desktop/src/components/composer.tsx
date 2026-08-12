import { useEffect, useRef, useState } from "react";
import {
  CLAUDE_MODELS,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  EFFORTS,
  PERMISSION_PROFILES,
  type Capability,
  type Effort,
  type ModelId,
  type PermissionProfile
} from "@novus/contracts";
import codexIcon from "../assets/codex-icon.png";
import { Dialog } from "./dialog";
import { ClaudeGlyph } from "./identity";

/** One line on what each profile answers, keyed to the vocabulary the server
 *  enforces (D-115). The wire never changes: the harness always asks, and a
 *  profile only changes who answers — which is why there is no bypass row. */
const PROFILE_MEANINGS: Record<PermissionProfile, string> = {
  plan: "Read and propose. Nothing changes the workspace; the harness presents a plan.",
  manual: "Every privileged act is a question in the room. The default.",
  accept_edits: "File edits are approved by policy, on the record. Shell commands still ask.",
  auto: "Everything but a shell command is approved by policy, on the record.",
  dont_ask: "Every act is approved by policy, on the record — shell commands included."
};

/** The sentence a Mission Admin confirms to set Don't ask — sent to the server
 *  verbatim as the acknowledgement and recorded on `policy.changed`, the
 *  D-100 accepted-blockers pattern. */
export const DONT_ASK_WARNING =
  "Every act Claude asks about will be approved by this policy — shell commands included — until the profile changes.";

export function profileLabel(profile: PermissionProfile): string {
  return PERMISSION_PROFILES.find((option) => option.id === profile)?.label ?? profile;
}

/** What the composer needs to say and change about the lane's answer policy
 *  (D-115). Null while no lane exists — the ask-dialog's composer. */
export interface PolicyControl {
  profile: PermissionProfile;
  /** Whether this viewer holds `policy.set` — rendered, never decisive. */
  maySet: boolean;
  /** Whether this viewer's role may set Don't ask (Mission Admin). */
  maySetUnsupervised: boolean;
  onSet: (
    profile: PermissionProfile,
    acknowledged: string | null
  ) => Promise<{ ok: boolean; message?: string }>;
}

export interface SubmitOutcome {
  ok: boolean;
  /** True when the server queued the direction instead of dispatching it. */
  queued?: boolean;
  /** The server's own reason for not dispatching, shown verbatim. */
  deferred?: string | null;
  message?: string;
}

const MODEL_IDS = CLAUDE_MODELS.map((model) => model.id);

function isModelId(value: string | null): value is ModelId {
  return value !== null && (MODEL_IDS as readonly string[]).includes(value);
}

function isEffort(value: string | null): value is Effort {
  return value !== null && (EFFORTS as readonly string[]).includes(value);
}

/**
 * The room's persistent composer (DESIGN.md#component-behavior, D-032). One
 * bordered field: the textarea on the box's own surface, a foot row carrying
 * the model chip, the effort chip, and the single send control.
 *
 * Compact at idle, grows with content, and returns to one row after it
 * submits. Model and effort come from CLAUDE_MODELS — the allowlist of ids
 * verified live against the CLI — so the menu can never offer a model that
 * does not exist.
 */
export function Composer({
  capabilities,
  denialReason,
  isController,
  contextNote,
  placeholderOverride,
  alongsideOffer,
  policy,
  onEmptySubmit,
  onSubmit
}: {
  /** Null until the server has said what this viewer may do. The composer
   *  never guesses a capability it has not been told about. */
  capabilities: Capability[] | null;
  /** Why direction is refused, when the reason is not a missing role — a
   *  repository nothing can run needs its own sentence, not a lecture about
   *  capabilities the person may well hold. */
  denialReason?: string;
  isController: boolean;
  contextNote?: string | null;
  /** Overrides the state-derived placeholder — the ask-dialog is a question,
   *  not a room, and its placeholder is the question (D-077). */
  placeholderOverride?: string;
  /** Set while the workspace's turn belongs to another chat and this person
   *  holds the baton (D-095): sending then asks — queue behind the named
   *  running chat, or run this one alongside, read-only. Null keeps the
   *  ordinary immediate submit. */
  alongsideOffer?: { runningTitle: string | null } | null;
  /** The lane's permission profile, worn on the foot beside model and effort
   *  (D-115) — visible to everyone who can read the composer, changeable by
   *  whoever the server says holds `policy.set`. Null hides the chip. */
  policy?: PolicyControl | null;
  /** Enter on an empty box. The room does nothing; the ask-dialog closes,
   *  because an empty ask is a dismissal (D-077). */
  onEmptySubmit?: () => void;
  onSubmit: (input: {
    body: string;
    model: ModelId;
    effort: Effort;
    alongside?: boolean;
  }) => Promise<SubmitOutcome>;
}) {
  const [textValue, setTextValue] = useState("");
  const [model, setModel] = useState<ModelId>(() => {
    const stored = localStorage.getItem("novus-model");
    return isModelId(stored) ? stored : DEFAULT_MODEL;
  });
  const [effort, setEffort] = useState<Effort>(() => {
    const stored = localStorage.getItem("novus-effort");
    return isEffort(stored) ? stored : DEFAULT_EFFORT;
  });
  const [openMenu, setOpenMenu] = useState<"model" | "effort" | "policy" | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queuedNote, setQueuedNote] = useState<string | null>(null);
  /** The Don't ask confirmation, open (D-115). The warning is the dialog. */
  const [confirmingUnsupervised, setConfirmingUnsupervised] = useState(false);
  const [settingProfile, setSettingProfile] = useState(false);
  /** The slider stop under the pointer (D-116): its meaning previews on the
   *  one explaining line, falling back to the profile that is set. */
  const [previewProfile, setPreviewProfile] = useState<PermissionProfile | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const footRef = useRef<HTMLDivElement>(null);

  // Direction is a server-enforced verb, and nothing else gates this box.
  // Whether a runner exists is the state line's business: a participant whose
  // machine has no checkout still directs the work the host's runner performs.
  const known = capabilities !== null;
  const mayDirect = capabilities?.includes("direction.submit") ?? false;
  const enabled = mayDirect;

  useEffect(() => {
    if (!openMenu) return;
    const onDown = (event: MouseEvent) => {
      if (!footRef.current?.contains(event.target as Node)) setOpenMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenu(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [openMenu]);

  const grow = (element: HTMLTextAreaElement) => {
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, Math.floor(window.innerHeight * 0.4))}px`;
  };

  const [pendingChoice, setPendingChoice] = useState(false);

  const perform = async (alongside: boolean) => {
    const body = textValue.trim();
    if (!body || sending || !enabled) return;
    setPendingChoice(false);
    setSending(true);
    setError(null);
    setQueuedNote(null);
    const outcome = await onSubmit({ body, model, effort, alongside });
    setSending(false);
    if (!outcome.ok) {
      setError(outcome.message ?? "That direction did not go through.");
      return;
    }
    setTextValue("");
    // The box returns to one row: a composer that stays tall after sending is
    // a blank canvas, which the room is not (DESIGN.md prohibited pattern 9).
    if (inputRef.current) inputRef.current.style.height = "";
    setQueuedNote(
      outcome.queued ? (outcome.deferred ?? "Queued — applies at the next safe point") : null
    );
  };

  const chooseProfile = async (profile: PermissionProfile, acknowledged: string | null) => {
    if (!policy || settingProfile) return;
    setSettingProfile(true);
    setError(null);
    const outcome = await policy.onSet(profile, acknowledged);
    setSettingProfile(false);
    if (!outcome.ok) {
      setError(outcome.message ?? "The profile did not change.");
      setConfirmingUnsupervised(false);
      return;
    }
    setOpenMenu(null);
    setConfirmingUnsupervised(false);
  };

  const send = async () => {
    const body = textValue.trim();
    if (!body) {
      onEmptySubmit?.();
      return;
    }
    if (sending || !enabled) return;
    // The workspace is on another chat's turn and the choice is this person's
    // (D-095): asked once, here, before anything is sent. A second Enter takes
    // the default — queueing, exactly what sending always did.
    if (alongsideOffer && !pendingChoice) {
      setPendingChoice(true);
      return;
    }
    await perform(false);
  };

  // The question can go moot while it is being asked: the running turn ends —
  // or was already over, seen through the poll's two-second lag — and there is
  // nothing to run alongside any more. The person already pressed send, so
  // their direction goes now, the ordinary way, instead of the click being
  // silently swallowed (found by the sessions spec: one click, no submit).
  useEffect(() => {
    if (pendingChoice && !alongsideOffer) {
      setPendingChoice(false);
      void perform(false);
    }
    // Deliberately keyed on the question and its subject alone: `perform`
    // reads the current state when it runs.
  }, [pendingChoice, alongsideOffer]);

  const placeholder = placeholderOverride ?? (!known
    ? "Loading this mission…"
    : !mayDirect
      // A refusal the person can act on belongs where they are looking, not
      // only in a tooltip they may never hover.
      ? denialReason ?? "You can follow this mission — sending direction needs Contributor access"
      : isController
        ? "Direct Claude Code…"
        : "Add direction to the queue…");

  return (
    <div className="composer" data-testid="composer">
      {error && (
        <p className="inline-error composer-error" role="alert" data-testid="send-error">
          {error}
        </p>
      )}
      <div
        className="composer-box"
        title={
          known && !mayDirect
            ? denialReason ??
              "Only participants with direction.submit can send direction. Ask a Mission Admin for Contributor access."
            : undefined
        }
        data-testid={known && !mayDirect ? "composer-no-capability" : undefined}
      >
        <textarea
          ref={inputRef}
          className="composer-input"
          placeholder={placeholder}
          value={textValue}
          rows={1}
          disabled={!enabled || sending}
          onChange={(event) => {
            setTextValue(event.target.value);
            setQueuedNote(null);
            // Editing the words withdraws the question: the choice was about
            // the direction as it stood (D-095).
            setPendingChoice(false);
            grow(event.target);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
            if (event.key === "Escape" && pendingChoice) setPendingChoice(false);
          }}
          aria-label="Direct Claude Code"
          data-testid="composer-input"
        />
        <div className="composer-foot" ref={footRef}>
          <span className="chip-wrap">
            <button
              className="chip-button"
              disabled={!enabled}
              aria-haspopup="menu"
              aria-expanded={openMenu === "model"}
              onClick={() => setOpenMenu(openMenu === "model" ? null : "model")}
              data-testid="model-chip"
            >
              <ClaudeGlyph className="chip-glyph" />
              {CLAUDE_MODELS.find((option) => option.id === model)?.label ?? model}
            </button>
            {openMenu === "model" && (
              <div className="chip-menu" role="menu" data-testid="model-menu">
                {CLAUDE_MODELS.map((option) => (
                  <button
                    key={option.id}
                    className="chip-menu-row"
                    role="menuitem"
                    onClick={() => {
                      setModel(option.id);
                      localStorage.setItem("novus-model", option.id);
                      setOpenMenu(null);
                    }}
                  >
                    <ClaudeGlyph className="chip-glyph" />
                    {option.label}
                    {option.id === model && <span className="chip-menu-note">current</span>}
                  </button>
                ))}
                {/* A harness that does not exist here renders disabled with a
                    plain note — never as a live option. */}
                <button className="chip-menu-row" role="menuitem" disabled data-testid="codex-option">
                  <img className="chip-glyph chip-glyph-bitmap" src={codexIcon} alt="" />
                  Codex
                  <span className="chip-menu-note">arrives later</span>
                </button>
              </div>
            )}
          </span>

          <span className="chip-wrap">
            <button
              className="chip-button"
              disabled={!enabled}
              aria-haspopup="menu"
              aria-expanded={openMenu === "effort"}
              onClick={() => setOpenMenu(openMenu === "effort" ? null : "effort")}
              data-testid="effort-chip"
            >
              Effort · {effort}
            </button>
            {openMenu === "effort" && (
              <div className="chip-menu" role="menu" data-testid="effort-menu">
                {EFFORTS.map((option) => (
                  <button
                    key={option}
                    className="chip-menu-row"
                    role="menuitem"
                    onClick={() => {
                      setEffort(option);
                      localStorage.setItem("novus-effort", option);
                      setOpenMenu(null);
                    }}
                  >
                    {option}
                    {option === effort && <span className="chip-menu-note">current</span>}
                  </button>
                ))}
              </div>
            )}
          </span>

          {policy && (
            <span className="chip-wrap">
              {/* The lane's answer policy, worn where directing happens (D-115).
                  The word is a fact for everyone; changing it is policy.set,
                  which the server enforces — this chip only asks. */}
              <button
                className="chip-button"
                disabled={!enabled || !policy.maySet}
                title={
                  policy.maySet
                    ? undefined
                    : "Only a Mission Admin or Operator can change permissions (policy.set)."
                }
                aria-haspopup="menu"
                aria-expanded={openMenu === "policy"}
                onClick={() => setOpenMenu(openMenu === "policy" ? null : "policy")}
                data-testid="policy-chip"
              >
                Permissions ·{" "}
                <span className={policy.profile === "dont_ask" ? "tone-warn" : undefined}>
                  {profileLabel(policy.profile)}
                </span>
              </button>
              {openMenu === "policy" && (
                <div className="chip-menu policy-slider-menu" data-testid="policy-menu">
                  {/* One track, five stops, autonomy growing rightward — the
                      owner's slider (D-116, on sight of the D-115 row menu).
                      The dangerous end wears the warn tone before it is
                      chosen, and choosing it still opens the warning. */}
                  <div className="policy-slider" role="radiogroup" aria-label="Permission profile">
                    <span className="policy-track" aria-hidden="true" />
                    <span
                      className={
                        policy.profile === "dont_ask"
                          ? "policy-track-fill policy-track-fill-warn"
                          : "policy-track-fill"
                      }
                      style={{
                        width: `${
                          (Math.max(
                            0,
                            PERMISSION_PROFILES.findIndex((option) => option.id === policy.profile)
                          ) /
                            (PERMISSION_PROFILES.length - 1)) *
                          100
                        }%`
                      }}
                      aria-hidden="true"
                    />
                    {PERMISSION_PROFILES.map((option) => {
                      const unsupervised = option.id === "dont_ask";
                      const withheld = unsupervised && !policy.maySetUnsupervised;
                      const active = option.id === policy.profile;
                      return (
                        <button
                          key={option.id}
                          type="button"
                          className={[
                            "policy-stop",
                            active ? "active" : "",
                            unsupervised ? "stop-warn" : ""
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          role="radio"
                          aria-checked={active}
                          aria-label={option.label}
                          disabled={withheld || settingProfile}
                          title={
                            withheld ? "Only a Mission Admin can set Don't ask." : option.label
                          }
                          onMouseEnter={() => setPreviewProfile(option.id)}
                          onMouseLeave={() => setPreviewProfile(null)}
                          onFocus={() => setPreviewProfile(option.id)}
                          onBlur={() => setPreviewProfile(null)}
                          onClick={() => {
                            if (active) {
                              setOpenMenu(null);
                              return;
                            }
                            if (unsupervised) {
                              setConfirmingUnsupervised(true);
                              setOpenMenu(null);
                              return;
                            }
                            void chooseProfile(option.id, null);
                          }}
                          data-testid={`policy-${option.id}`}
                        />
                      );
                    })}
                  </div>
                  {/* One line does the explaining: the stop under the pointer,
                      or the one that is set. Five stacked paragraphs were the
                      first build, and the owner was right that a wall of text
                      is not a control. */}
                  <p className="policy-current" data-testid="policy-current">
                    <span
                      className={
                        (previewProfile ?? policy.profile) === "dont_ask"
                          ? "policy-current-name tone-warn"
                          : "policy-current-name"
                      }
                    >
                      {profileLabel(previewProfile ?? policy.profile)}
                    </span>{" "}
                    — {PROFILE_MEANINGS[previewProfile ?? policy.profile]}
                  </p>
                  {/* Not a sixth stop, deliberately: a mode that turns the
                      asking off cannot keep the record (D-115). */}
                  <p className="chip-menu-foot" data-testid="policy-no-bypass">
                    There is no bypass: the harness always asks, and a profile only changes who
                    answers. Applies from the next turn.
                  </p>
                </div>
              )}
            </span>
          )}

          {contextNote && <span className="composer-note mono">{contextNote}</span>}
          {queuedNote && (
            <span className="composer-note" data-testid="queued-note">
              {queuedNote}
            </span>
          )}
          {pendingChoice && alongsideOffer && (
            <span className="composer-choice" data-testid="composer-choice">
              <span className="composer-note">
                {alongsideOffer.runningTitle
                  ? `"${alongsideOffer.runningTitle}" is running.`
                  : "Another chat is running."}
              </span>
              <button
                className="btn btn-secondary"
                onClick={() => void perform(false)}
                data-testid="choice-queue"
              >
                Queue
              </button>
              <button
                className="btn btn-text"
                onClick={() => void perform(true)}
                data-testid="choice-alongside"
              >
                Run alongside · read-only
              </button>
            </span>
          )}

          <button
            className="send-button"
            onClick={() => void send()}
            disabled={!enabled || sending || textValue.trim().length === 0}
            aria-label="Send direction"
            data-testid="send"
          >
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        </div>
      </div>

      {confirmingUnsupervised && policy && (
        // The dangerous profile's warning (D-115), on the dialog's own axis
        // (D-076): the act named with its consequence beneath, the facts as
        // quiet rows, the danger action on the right. What is confirmed here
        // is recorded verbatim on the change (the D-100 pattern).
        <Dialog
          label="Set Don't ask"
          onClose={() => setConfirmingUnsupervised(false)}
          testId="policy-confirm"
        >
          <header className="dialog-head">
            <h2>Don't ask</h2>
            <p className="dialog-sub">{DONT_ASK_WARNING}</p>
          </header>
          <div className="dialog-body">
            <div className="confirm-field">
              <span className="field-label tone-warn">Approved without a person, if you proceed</span>
              <ul className="confirm-facts">
                <li>File edits, shell commands, and every other act the harness asks about</li>
              </ul>
            </div>
            <div className="confirm-field">
              <span className="field-label">Still yours, whatever the profile</span>
              <ul className="confirm-facts">
                <li>Every grant is recorded as it happens, and Stop always works</li>
                <li>Who may direct, stop, decide, and change this profile — the server enforces it</li>
              </ul>
            </div>
          </div>
          <footer className="dialog-actions">
            <button
              className="btn btn-text"
              onClick={() => setConfirmingUnsupervised(false)}
              data-testid="policy-confirm-cancel"
            >
              Cancel
            </button>
            <button
              className="btn btn-danger"
              disabled={settingProfile}
              onClick={() => void chooseProfile("dont_ask", DONT_ASK_WARNING)}
              data-testid="policy-confirm-set"
            >
              Set Don't ask, accepting this
            </button>
          </footer>
        </Dialog>
      )}
    </div>
  );
}
