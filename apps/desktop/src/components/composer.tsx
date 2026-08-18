import { useEffect, useRef, useState } from "react";
import {
  CLAUDE_MODELS,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  EFFORTS,
  MAX_DIRECTION_ATTACHMENTS,
  PERMISSION_PROFILES,
  type Capability,
  type Effort,
  type ModelId,
  type PermissionProfile,
  type PreparedAttachment
} from "@novus/contracts";
import codexIcon from "../assets/codex-icon.png";
import { Dialog } from "./dialog";
import { ClaudeGlyph, DocumentGlyph, ImageGlyph } from "./identity";

/** One short line on what each profile answers, keyed to the vocabulary the
 *  server enforces (D-115). The wire never changes: the harness always asks,
 *  and a profile only changes who answers — which is why there is no bypass
 *  stop. Fragments, not paragraphs (D-116): the name above the track carries
 *  the identity, this line carries only the consequence. */
const PROFILE_MEANINGS: Record<PermissionProfile, string> = {
  plan: "Read and propose — nothing changes the workspace.",
  manual: "Every act is a question in the room. The default.",
  accept_edits: "File edits approved by policy; shell commands still ask.",
  auto: "Everything but shell commands approved by policy.",
  dont_ask: "Everything approved by policy, shell included."
};

/** The sentence a Mission Admin confirms to set Don't ask — sent to the server
 *  verbatim as the acknowledgement and recorded on `policy.changed`, the
 *  D-100 accepted-blockers pattern. */
export const DONT_ASK_WARNING =
  "Every act Claude asks about will be approved by this policy — shell commands included — until the profile changes.";

export function profileLabel(profile: PermissionProfile): string {
  return PERMISSION_PROFILES.find((option) => option.id === profile)?.label ?? profile;
}

/** One quiet stroke glyph per profile (D-117): the row's anchor, in the
 *  sanctioned inline style — currentColor, no fills, no second hue — so the
 *  danger row can tint glyph, name, and meaning as one word. */
function PolicyGlyph({ profile }: { profile: PermissionProfile }) {
  const paths: Record<PermissionProfile, string> = {
    // A plan is lines on a page.
    plan: "M5 5h10M5 10h10M5 15h6",
    // Asking is a raised hand's simpler cousin: the question.
    manual: "M7 7.5a3 3 0 1 1 4.4 2.7c-.9.5-1.4 1-1.4 2.1M10 15.5v.01",
    // Edits are the pencil.
    accept_edits: "M13.5 4.5l2 2L7 15H5v-2z",
    // Auto is the bolt.
    auto: "M11 3L5 11h4l-1 6 6-8h-4z",
    // The dangerous end is the warning it deserves.
    dont_ask: "M10 4l7 12H3zM10 9v3M10 14.5v.01"
  };
  return (
    <svg
      viewBox="0 0 20 20"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[profile]} />
    </svg>
  );
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
  onSubmit,
  attach
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
    attachmentIds?: string[];
  }) => Promise<SubmitOutcome>;
  /** Attaching an image (D-150). Absent where the surface cannot attach —
   *  a composer with no mission behind it yet. The verbs are the room's; the
   *  composer only holds what came back. */
  attach?: {
    pick: () => Promise<{ ok: true; path: string | null } | { ok: false; message: string }>;
    upload: (path: string) => Promise<
      { ok: true; attachment: PreparedAttachment } | { ok: false; message: string }
    >;
    /** Whatever image the clipboard holds, or null when it holds none (D-152). */
    paste: () => Promise<
      { ok: true; attachment: PreparedAttachment | null } | { ok: false; message: string }
    >;
    /** The path behind a dropped file, resolved by the bridge (D-152). */
    pathOf: (file: File) => string | null;
  };
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
  /** Images already uploaded and waiting to go with the next direction. They
   *  exist in the store the moment they are added, so a slow upload never
   *  delays the words — and abandoning the composer leaves an unattached
   *  artifact the sweep fails, never a half-sent direction. */
  const [attachments, setAttachments] = useState<PreparedAttachment[]>([]);
  const [attaching, setAttaching] = useState(false);

  const room = attachments.length < MAX_DIRECTION_ATTACHMENTS;

  /**
   * Uploads a run of files one after another (D-152), stopping at the bound.
   *
   * Sequential rather than parallel on purpose: the bound is checked against
   * what is already held, and four concurrent uploads all see the same empty
   * list. Any mixture is fine — images and PDFs land in the same list in the
   * order they were given, which is the order the harness reads them.
   */
  const addFiles = async (paths: string[]) => {
    if (!attach || attaching || paths.length === 0) return;
    setError(null);
    setAttaching(true);
    try {
      let held = attachments.length;
      let refusedOne: string | null = null;
      for (const path of paths) {
        if (held >= MAX_DIRECTION_ATTACHMENTS) {
          refusedOne = `A direction may carry ${MAX_DIRECTION_ATTACHMENTS} files; the rest were not attached.`;
          break;
        }
        const uploaded = await attach.upload(path);
        if (!uploaded.ok) {
          // One bad file among several does not discard the good ones: the
          // reason is shown and the rest still go.
          refusedOne = uploaded.message;
          continue;
        }
        held += 1;
        setAttachments((current) => [...current, uploaded.attachment].slice(0, MAX_DIRECTION_ATTACHMENTS));
      }
      if (refusedOne) setError(refusedOne);
    } finally {
      setAttaching(false);
    }
  };

  const addImage = async () => {
    if (!attach || attaching || !room) return;
    setError(null);
    const picked = await attach.pick();
    if (!picked.ok) {
      setError(picked.message);
      return;
    }
    if (picked.path === null) return;
    await addFiles([picked.path]);
  };

  /** Paste (D-152). Returns true when an image was taken, so the caller knows
   *  whether to let the ordinary text paste happen. */
  const pasteImage = async (): Promise<boolean> => {
    if (!attach || attaching || !room) return false;
    const pasted = await attach.paste();
    if (!pasted.ok) {
      setError(pasted.message);
      return true;
    }
    const taken = pasted.attachment;
    if (taken === null) return false;
    setAttachments((current) => [...current, taken].slice(0, MAX_DIRECTION_ATTACHMENTS));
    return true;
  };

  const [dropping, setDropping] = useState(false);

  const perform = async (alongside: boolean) => {
    const body = textValue.trim();
    if (!body || sending || !enabled) return;
    setPendingChoice(false);
    setSending(true);
    setError(null);
    setQueuedNote(null);
    const outcome = await onSubmit({
      body,
      model,
      effort,
      alongside,
      attachmentIds: attachments.map((image) => image.artifactId)
    });
    setSending(false);
    if (!outcome.ok) {
      // The images stay held: a refused direction is one a person will send
      // again, and making them re-attach would be punishing them for it.
      setError(outcome.message ?? "That direction did not go through.");
      return;
    }
    setTextValue("");
    setAttachments([]);
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
        className={dropping ? "composer-box composer-box-dropping" : "composer-box"}
        // Dropping onto the box (D-152). The whole box is the target rather
        // than a strip inside it: a person dragging a screenshot at a text
        // area should not have to aim.
        onDragOver={(event) => {
          if (!attach || !enabled) return;
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setDropping(true);
        }}
        onDragLeave={(event) => {
          // Only when the pointer truly leaves the box — dragging across a
          // child fires leave on the parent otherwise, and the wash flickers.
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
        }}
        onDrop={(event) => {
          if (!attach || !enabled) return;
          const paths = [...event.dataTransfer.files]
            .map((file) => attach.pathOf(file))
            .filter((path): path is string => path !== null);
          if (paths.length === 0) return;
          event.preventDefault();
          setDropping(false);
          void addFiles(paths);
        }}
        title={
          known && !mayDirect
            ? denialReason ??
              "Only participants with direction.submit can send direction. Ask a Mission Admin for Contributor access."
            : undefined
        }
        data-testid={known && !mayDirect ? "composer-no-capability" : undefined}
      >
        {/* The dock names its whole target before a word is typed (D-124): the
            lane and conversation as one quiet eyebrow on the box's own edge,
            where the foot's mono note used to hide it. */}
        {contextNote && (
          <span className="composer-target" data-testid="composer-target">
            {contextNote}
          </span>
        )}
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
          onPaste={(event) => {
            if (!attach) return;
            // Only a clipboard actually carrying an image is intercepted; a
            // pasted paragraph is words and must stay words (D-152).
            const hasImage = [...event.clipboardData.items].some((item) =>
              item.type.startsWith("image/")
            );
            if (!hasImage) return;
            event.preventDefault();
            void pasteImage();
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
        {/* What the next direction will carry (D-150). Above the words, where
            the reading order matches the sending order, and each image says
            its own name rather than showing a thumbnail the box has no room
            for. */}
        {attachments.length > 0 && (
          <div className="composer-attachments" data-testid="composer-attachments">
            {attachments.map((image) => (
              <span className="composer-attachment" key={image.artifactId}>
                {image.form === "image" ? (
                  <ImageGlyph className="composer-attachment-glyph" />
                ) : (
                  <DocumentGlyph className="composer-attachment-glyph" />
                )}
                <span className="composer-attachment-name">{image.label}</span>
                {/* Both are stated rather than hidden (D-151): a person should
                    know their photo was converted or scaled, not find out. */}
                {image.convertedFrom !== null && (
                  <span
                    className="composer-attachment-note"
                    title={`Converted from ${image.convertedFrom} — the agent cannot read that format`}
                  >
                    from {image.convertedFrom}
                  </span>
                )}
                {image.resized && (
                  <span className="composer-attachment-note" title="Scaled down before sending">
                    resized
                  </span>
                )}
                {/* A staged file is a different promise from an inlined one:
                    the agent has to open it, so the interface says so rather
                    than implying it was read (D-153). */}
                {image.form === "file" && (
                  <span
                    className="composer-attachment-note"
                    title="Placed in the workspace — the agent opens it with its own tools"
                  >
                    in workspace
                  </span>
                )}
                <button
                  className="composer-attachment-remove"
                  aria-label={`Remove ${image.label}`}
                  disabled={sending}
                  onClick={() =>
                    setAttachments((held) =>
                      held.filter((candidate) => candidate.artifactId !== image.artifactId)
                    )
                  }
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="composer-foot" ref={footRef}>
          {attach && (
            <button
              className="chip-button"
              disabled={!enabled || attaching || !room}
              onClick={() => void addImage()}
              title={
                attachments.length >= MAX_DIRECTION_ATTACHMENTS
                  ? `A direction may carry ${MAX_DIRECTION_ATTACHMENTS} files.`
                  : "Attach an image or PDF"
              }
              data-testid="attach-image"
            >
              <ImageGlyph className="chip-glyph" />
              {attaching ? "Attaching" : "Attach"}
            </button>
          )}
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
                <div className="chip-menu policy-menu" data-testid="policy-menu">
                  {/* The question, then the answers (D-117, the owner's shape,
                      named from Codex's picker): one row per profile — glyph,
                      name, one line of meaning — the current one checked, and
                      the dangerous one wearing the warn tone whole: glyph,
                      name, and meaning as one word. Choosing it still opens
                      the warning. */}
                  <p className="policy-head">How should Claude Code's actions be approved?</p>
                  {PERMISSION_PROFILES.map((option) => {
                    const unsupervised = option.id === "dont_ask";
                    const withheld = unsupervised && !policy.maySetUnsupervised;
                    const active = option.id === policy.profile;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        className={unsupervised ? "policy-row policy-row-danger" : "policy-row"}
                        role="menuitemradio"
                        aria-checked={active}
                        disabled={withheld || settingProfile}
                        title={withheld ? "Only a Mission Admin can set Don't ask." : undefined}
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
                      >
                        <span className="policy-glyph">
                          <PolicyGlyph profile={option.id} />
                        </span>
                        <span className="policy-words">
                          <span className="policy-row-name">{option.label}</span>
                          <span className="policy-row-desc">{PROFILE_MEANINGS[option.id]}</span>
                        </span>
                        {active && (
                          <svg
                            className="policy-check"
                            viewBox="0 0 20 20"
                            width="16"
                            height="16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M4 10.5l4 4 8-9" />
                          </svg>
                        )}
                        {withheld && <span className="chip-menu-note">Mission Admin only</span>}
                      </button>
                    );
                  })}
                  {/* Not a sixth row, deliberately: a mode that turns the
                      asking off cannot keep the record (D-115). */}
                  <p className="chip-menu-foot" data-testid="policy-no-bypass">
                    There is no bypass — the harness always asks; a profile changes who answers,
                    from the next turn.
                  </p>
                </div>
              )}
            </span>
          )}

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
                <li>File edits, shell commands — everything the harness asks about</li>
              </ul>
            </div>
            <div className="confirm-field">
              <span className="field-label">Still yours, whatever the profile</span>
              <ul className="confirm-facts">
                <li>Every grant is recorded, Stop always works, and the server still decides who may act</li>
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
