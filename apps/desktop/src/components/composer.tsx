import { useEffect, useRef, useState } from "react";
import {
  CLAUDE_MODELS,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  EFFORTS,
  type Capability,
  type Effort,
  type ModelId
} from "@novus/contracts";
import codexIcon from "../assets/codex-icon.png";
import { ClaudeGlyph } from "./identity";

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
  const [openMenu, setOpenMenu] = useState<"model" | "effort" | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queuedNote, setQueuedNote] = useState<string | null>(null);
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
    </div>
  );
}
