import { useEffect, useRef, useState } from "react";
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  effortsFor,
  HARNESSES,
  harnessOf,
  type HarnessId,
  speedsFor,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  EFFORTS,
  MAX_DIRECTION_ATTACHMENTS,
  PERMISSION_PROFILES,
  type Capability,
  type Effort,
  type ModelId,
  type PermissionProfile,
  type DirectionContextRef,
  type PreparedAttachment,
  type Speed
} from "@novus/contracts";
import codexIcon from "../assets/codex-icon.png";
import { Dialog, focusQuietly } from "./dialog";
import { ClaudeGlyph, DocumentGlyph, ImageGlyph } from "./identity";
import { FileBadge } from "./file-badge";

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

/**
 * What each conversation's box holds while the app runs (D-215): the words
 * typed, the files attached, the paths held. Keyed by the conversation, so
 * switching chats swaps the box's contents rather than carrying them along —
 * a draft belongs to the conversation it was started in, and is there again
 * on return. In memory only: a relaunch starts every box empty, as it always
 * did, and an uploaded attachment a person never sent is simply unsent.
 */
interface Scratch {
  text: string;
  attachments: PreparedAttachment[];
  heldPaths: string[];
}
const scratchByKey = new Map<string, Scratch>();

const MODEL_IDS = [...CLAUDE_MODELS, ...CODEX_MODELS].map((model) => model.id);

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
  placeholderOverride,
  alongsideOffer,
  chatHarness,
  policy,
  onEmptySubmit,
  onSubmit,
  attach,
  pendingTranscripts,
  pendingContext,
  onRemoveContext,
  mention,
  slashCommands,
  terminal,
  onStop,
  scratchKey,
  onRemoveTranscript
}: {
  /** Null until the server has said what this viewer may do. The composer
   *  never guesses a capability it has not been told about. */
  capabilities: Capability[] | null;
  /** Why direction is refused, when the reason is not a missing role — a
   *  repository nothing can run needs its own sentence, not a lecture about
   *  capabilities the person may well hold. */
  denialReason?: string;
  isController: boolean;
  /** Overrides the state-derived placeholder — the ask-dialog is a question,
   *  not a room, and its placeholder is the question (D-077). */
  placeholderOverride?: string;
  /** Set while the workspace's turn belongs to another chat and this person
   *  holds the baton (D-095): sending then asks — queue behind the named
   *  running chat, or run this one alongside, read-only. Null keeps the
   *  ordinary immediate submit. */
  alongsideOffer?: { runningTitle: string | null } | null;
  /** Whose harness the chat on screen is (D-232) — the one its latest turn
   *  ran on — or null for a chat that has not run yet. Picking the other
   *  harness's model shows the swap sentence, and sending then starts a new
   *  chat carrying this one's transcript instead of crossing it. */
  chatHarness?: HarnessId | null;
  /** The lane's permission profile, worn on the foot beside model and effort
   *  (D-115) — visible to everyone who can read the composer, changeable by
   *  whoever the server says holds `policy.set`. Null hides the chip. */
  policy?: PolicyControl | null;
  /** Enter on an empty box. The room does nothing; the ask-dialog closes,
   *  because an empty ask is a dismissal (D-077). */
  onEmptySubmit?: () => void;
  /** Set while the conversation this composer addresses has a live turn
   *  (D-206): with the box empty, the send control becomes the stop square —
   *  the affordance every agent product has taught — and typing swaps it back
   *  to send, because a message typed mid-turn queues and steers. Never set
   *  for another chat's turn; stopping that from here would be a misfire. */
  onStop?: (() => void) | null;
  /** Which conversation this box belongs to (D-215). The box's words, files,
   *  and held paths are remembered under it while the app runs, so a switch
   *  to another chat leaves them here and a return finds them. Absent where
   *  the box belongs to nothing yet — the ask dialog — which remembers
   *  nothing. */
  scratchKey?: string;
  onSubmit: (input: {
    body: string;
    model: ModelId;
    effort: Effort;
    speed: Speed;
    alongside?: boolean;
    /** Opens the turn as Codex's reviewer over the uncommitted changes
     *  (D-231) — the / menu's review row, never typed words. */
    review?: boolean;
    /** The chosen model belongs to the other harness (D-232): start a new
     *  chat for it, carrying this chat's transcript, rather than crossing. */
    swap?: boolean;
    attachmentIds?: string[];
    /** Files chosen but not uploaded, because there was no mission to upload
     *  them to yet (D-201). The caller uploads them once there is one. */
    attachmentPaths?: string[];
  }) => Promise<SubmitOutcome>;
  /** Attaching an image (D-150). Absent where the surface cannot attach —
   *  a composer with no mission behind it yet. The verbs are the room's; the
   *  composer only holds what came back. */
  attach?: {
    pick: () => Promise<{ ok: true; path: string | null } | { ok: false; message: string }>;
    /**
     * Uploads the file and hands back the artifact the direction will carry.
     *
     * Absent where there is nothing to upload *to* — the ask dialog creates
     * the mission an attachment would belong to, so at the moment of picking
     * no mission exists (D-201). The composer then holds the chosen paths and
     * hands them to `onSubmit` as `attachmentPaths`, and whoever creates the
     * mission uploads them the instant there is one.
     */
    upload?: (path: string) => Promise<
      { ok: true; attachment: PreparedAttachment } | { ok: false; message: string }
    >;
    /** Whatever image the clipboard holds, or null when it holds none (D-152).
     *  Absent in the deferred case: the clipboard's bytes have no path to
     *  hold, and inventing a temporary file to make one is work for a later
     *  slice rather than a thing to fake here. */
    paste?: () => Promise<
      { ok: true; attachment: PreparedAttachment | null } | { ok: false; message: string }
    >;
    /** The path behind a dropped file, resolved by the bridge (D-152). */
    pathOf: (file: File) => string | null;
  };
  /** Transcripts the next direction will carry (D-173, restyled D-175): the
   *  chats picked on the draft canvas, worn here as chips beside the attached
   *  images — the box shows everything the send will carry, in one place.
   *  They upload at send, so these are named intentions, not artifacts yet. */
  pendingTranscripts?: { sessionId: string; title: string }[];
  /** Pinned references the next direction will carry (D-182): worktree files
   *  and checks, worn as chips beside the transcripts — the box's top edge is
   *  the one place everything a send carries is read before the words. */
  pendingContext?: DirectionContextRef[];
  onRemoveContext?: (index: number) => void;
  /** The @-mention (D-185): typing @ in the box offers the worktree's files;
   *  picking one pins it as a context chip and consumes the @query text.
   *  Absent where no worktree exists yet — the @ then stays an ordinary
   *  character, never a dead popover. */
  mention?: {
    search: (query: string) => Promise<string[]>;
    add: (path: string) => void;
  };
  /** The lane's enabled slash commands (D-187): typing / as the first
   *  character offers them; picking one inserts the full invocation the CLI
   *  registered for the composed command. Absent or empty, / stays an
   *  ordinary character — never a dead popover. */
  slashCommands?: { name: string; description: string | null; insert: string }[];
  /** Opens the person's own Claude session in the terminal dock with the
   *  typed command primed (D-199) — the road for the harness's terminal-only
   *  surfaces (/mcp and friends). Absent where no dock can exist. */
  terminal?: (query: string) => void;
  onRemoveTranscript?: (sessionId: string) => void;
}) {
  const scratch = scratchKey !== undefined ? scratchByKey.get(scratchKey) : undefined;
  const [textValue, setTextValue] = useState(scratch?.text ?? "");
  const [model, setModel] = useState<ModelId>(() => {
    const stored = localStorage.getItem("novus-model");
    return isModelId(stored) ? stored : DEFAULT_MODEL;
  });
  const [effort, setEffort] = useState<Effort>(() => {
    const stored = localStorage.getItem("novus-effort");
    return isEffort(stored) ? stored : DEFAULT_EFFORT;
  });
  // The speed tier (D-230): only a model that offers one renders the chip,
  // and switching to a model without it quietly returns to standard.
  const [speed, setSpeed] = useState<Speed>(() =>
    localStorage.getItem("novus-speed") === "fast" ? "fast" : "standard"
  );
  const [openMenu, setOpenMenu] = useState<"model" | "effort" | "speed" | "policy" | null>(null);
  /** Which provider's models the flyout shows (D-233). Opens on hover or
   *  click of a provider row; the chip's open resets it to the current
   *  model's own provider so the flyout starts where the person is. */
  const [providerOpen, setProviderOpen] = useState<HarnessId | null>(null);
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
      if (event.key !== "Escape") return;
      // The chip kept focus while its menu was open; dismissing is not
      // keyboard navigation, so the ring stays off (D-106).
      focusQuietly(document.activeElement);
      setOpenMenu(null);
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
  /** The active @-token (D-185): its start offset in the text and the query
   *  typed after it, or null while no mention is being written. */
  const [mentionToken, setMentionToken] = useState<{ start: number; query: string } | null>(null);
  const [mentionMatches, setMentionMatches] = useState<string[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);

  /**
   * The candidates for the token being typed, kept level with the typing.
   *
   * A trailing debounce was the obvious shape and the wrong one: it updates
   * the list only once the keys go quiet, so a fast burst leaves the popover
   * showing the first letter's answer for the whole burst and then jumps —
   * which reads as the feature being slow rather than as it waiting. The read
   * is a bounded git list, cheap enough to run per keystroke, so instead of
   * waiting this holds **one read in flight at a time**: the newest query
   * queues behind the one running, every older one is dropped, and an answer
   * is used only if it is still the query that is typed. Fast typing therefore
   * costs one read per round trip rather than one per keystroke, and the list
   * is never further behind than a single read.
   */
  const mentionQuery = mentionToken?.query ?? null;
  const typedQuery = useRef<string | null>(null);
  const readingQuery = useRef<string | null>(null);
  const queuedQuery = useRef<string | null>(null);
  useEffect(() => {
    typedQuery.current = mentionQuery;
    if (!mention || mentionQuery === null) {
      setMentionMatches([]);
      return;
    }
    const read = (query: string): void => {
      readingQuery.current = query;
      void mention.search(query).then((paths) => {
        readingQuery.current = null;
        // Only the answer to what is typed right now reaches the popover; an
        // answer overtaken while it was in flight is discarded, never shown.
        if (typedQuery.current === query) {
          setMentionMatches(paths.slice(0, 8));
          setMentionIndex(0);
        }
        const next = queuedQuery.current;
        queuedQuery.current = null;
        if (next !== null && next !== query && typedQuery.current === next) read(next);
      });
    };
    if (readingQuery.current !== null) {
      queuedQuery.current = mentionQuery;
      return;
    }
    read(mentionQuery);
  }, [mention, mentionQuery]);

  /** Finds the @-token the cursor is inside: an @ at the start or after
   *  whitespace, with no whitespace between it and the cursor. */
  const readMentionToken = (value: string, cursor: number): { start: number; query: string } | null => {
    const at = value.lastIndexOf("@", cursor - 1);
    if (at === -1) return null;
    if (at > 0 && !/\s/.test(value[at - 1] ?? "")) return null;
    const between = value.slice(at + 1, cursor);
    if (/\s/.test(between)) return null;
    return { start: at, query: between };
  };

  /** The active /-token (D-187): only a / opening the box starts one — a
   *  command is the direction, so mid-sentence slashes stay paths. */
  const [slashToken, setSlashToken] = useState<{ query: string } | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  // The lane's slash commands are Claude's dialect (D-230): Codex composes
  // none, so on a Codex model the rows are hidden rather than offered as
  // words that invoke nothing (D-232).
  const commandMatches =
    slashToken === null || !slashCommands || slashCommands.length === 0 || harnessOf(model) === "codex"
      ? []
      : slashCommands
          .filter((command) =>
            command.name.toLowerCase().includes(slashToken.query.toLowerCase())
          )
          .slice(0, 8);
  /** The chosen model is the other harness's (D-232): the send becomes a
   *  new chat carrying this one's transcript, and the box says so first. */
  const swapTo =
    chatHarness !== undefined && chatHarness !== null && harnessOf(model) !== chatHarness
      ? harnessOf(model)
      : null;
  const harnessName = (id: HarnessId): string => HARNESSES.find((entry) => entry.id === id)?.label ?? id;
  /** Codex's reviewer as a row (D-231): on a Codex model, / offers "Review
   *  uncommitted changes" — picking it sends, it never inserts words. */
  const reviewRow =
    slashToken !== null &&
    harnessOf(model) === "codex" &&
    "review".includes(slashToken.query.toLowerCase());
  /** One more row when a dock exists (D-199): whatever was typed, in the
   *  person's own session. It also keeps / alive where nothing matches, so a
   *  terminal-only command like /mcp is never a dead end. */
  const slashRows =
    slashToken === null
      ? 0
      : commandMatches.length + (reviewRow ? 1 : 0) + (terminal ? 1 : 0);

  const pickTerminal = (): void => {
    if (!terminal || slashToken === null) return;
    terminal(slashToken.query);
    setTextValue((value) => value.slice(1 + slashToken.query.length).trimStart());
    setSlashToken(null);
  };

  const readSlashToken = (value: string, cursor: number): { query: string } | null => {
    if (!value.startsWith("/")) return null;
    const between = value.slice(1, cursor);
    if (cursor < 1 || /\s/.test(between)) return null;
    return { query: between };
  };

  const pickSlashCommand = (insert: string): void => {
    if (slashToken === null) return;
    // The invocation replaces the /query; whatever followed it stays — the
    // person goes on typing the command's arguments.
    setTextValue((value) => `${insert} ${value.slice(1 + slashToken.query.length).trimStart()}`);
    setSlashToken(null);
    requestAnimationFrame(() => {
      const box = inputRef.current;
      if (box) {
        box.focus();
        box.setSelectionRange(insert.length + 1, insert.length + 1);
      }
    });
  };

  const pickMention = (path: string): void => {
    if (!mention || mentionToken === null) return;
    mention.add(path);
    // The chip is the reference; the @query it was typed as is consumed.
    const element = inputRef.current;
    const cursor = element?.selectionStart ?? mentionToken.start + 1 + mentionToken.query.length;
    setTextValue((value) => value.slice(0, mentionToken.start) + value.slice(cursor));
    setMentionToken(null);
    requestAnimationFrame(() => {
      const box = inputRef.current;
      if (box) {
        box.focus();
        box.setSelectionRange(mentionToken.start, mentionToken.start);
      }
    });
  };
  /** Images already uploaded and waiting to go with the next direction. They
   *  exist in the store the moment they are added, so a slow upload never
   *  delays the words — and abandoning the composer leaves an unattached
   *  artifact the sweep fails, never a half-sent direction. */
  const [attachments, setAttachments] = useState<PreparedAttachment[]>(scratch?.attachments ?? []);
  /** Files chosen where no mission exists to upload them to yet (D-201): held
   *  by path, shown as chips like any other, uploaded by whoever creates the
   *  mission. Named intentions, exactly as a pending transcript is. */
  const [heldPaths, setHeldPaths] = useState<string[]>(scratch?.heldPaths ?? []);
  // Written back on every change rather than on unmount, because a remount
  // keyed by conversation is exactly when unmount's own state is gone.
  useEffect(() => {
    if (scratchKey === undefined) return;
    if (textValue === "" && attachments.length === 0 && heldPaths.length === 0) scratchByKey.delete(scratchKey);
    else scratchByKey.set(scratchKey, { text: textValue, attachments, heldPaths });
  }, [scratchKey, textValue, attachments, heldPaths]);
  const [attaching, setAttaching] = useState(false);

  const carried = attachments.length + heldPaths.length;
  const room = carried < MAX_DIRECTION_ATTACHMENTS;

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
      let held = carried;
      let refusedOne: string | null = null;
      for (const path of paths) {
        if (held >= MAX_DIRECTION_ATTACHMENTS) {
          refusedOne = `A direction may carry ${MAX_DIRECTION_ATTACHMENTS} files; the rest were not attached.`;
          break;
        }
        // Nothing to upload to yet: hold the path and let the caller upload it
        // the moment the mission exists (D-201).
        if (!attach.upload) {
          held += 1;
          setHeldPaths((current) => [...current, path].slice(0, MAX_DIRECTION_ATTACHMENTS));
          continue;
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
    if (!attach?.paste || attaching || !room) return false;
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
      effort: effortsFor(model).includes(effort) ? effort : DEFAULT_EFFORT,
      speed: speedsFor(model).includes(speed) ? speed : "standard",
      alongside,
      ...(swapTo !== null ? { swap: true } : {}),
      attachmentIds: attachments.map((image) => image.artifactId),
      attachmentPaths: heldPaths
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
    setHeldPaths([]);
    // The box returns to one row: a composer that stays tall after sending is
    // a blank canvas, which the room is not (DESIGN.md prohibited pattern 9).
    if (inputRef.current) inputRef.current.style.height = "";
    setQueuedNote(
      outcome.queued ? (outcome.deferred ?? "Queued — applies at the next safe point") : null
    );
  };

  /** The review row's send (D-231): fixed words, flagged, no queue choice —
   *  a review is this chat's own turn and queues exactly as sending does. */
  const performReview = async () => {
    if (sending || !enabled) return;
    setSlashToken(null);
    setTextValue("");
    setPendingChoice(false);
    setSending(true);
    setError(null);
    setQueuedNote(null);
    const outcome = await onSubmit({
      body: "Review the uncommitted changes.",
      model,
      effort: effortsFor(model).includes(effort) ? effort : DEFAULT_EFFORT,
      speed: speedsFor(model).includes(speed) ? speed : "standard",
      review: true
    });
    setSending(false);
    if (!outcome.ok) {
      setError(outcome.message ?? "That direction did not go through.");
      return;
    }
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
        ? `Direct ${harnessName(harnessOf(model))}…`
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
        {/* What the next direction will carry (D-150, moved to the box's top
            edge in D-176): every chip — carried transcripts, then attached
            images — reads before the words it will travel with, the one place
            extra context joins the box. The D-124 target eyebrow is retired
            (D-176): the selected tab already names the conversation, and the
            box stays the same box everywhere. */}
        {(attachments.length > 0 ||
          heldPaths.length > 0 ||
          (pendingTranscripts?.length ?? 0) > 0 ||
          (pendingContext?.length ?? 0) > 0) && (
          <div className="composer-attachments" data-testid="composer-attachments">
            {pendingContext?.map((ref, index) => (
              <span
                className="composer-attachment"
                key={ref.kind === "file" ? `file:${ref.path}` : `check:${ref.checkId}`}
                data-testid="composer-context"
              >
                {ref.kind === "file" ? (
                  <FileBadge path={ref.path} />
                ) : (
                  <DocumentGlyph className="composer-attachment-glyph" />
                )}
                <span className="composer-attachment-name">
                  {ref.kind === "file" ? ref.path : `${ref.name} · ${ref.outcome}`}
                </span>
                {onRemoveContext && (
                  <button
                    className="composer-attachment-remove"
                    aria-label={`Remove ${ref.kind === "file" ? ref.path : ref.name}`}
                    disabled={sending}
                    onClick={() => onRemoveContext(index)}
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
            {pendingTranscripts?.map((transcript) => (
              <span
                className="composer-attachment"
                key={transcript.sessionId}
                data-testid="composer-transcript"
              >
                <DocumentGlyph className="composer-attachment-glyph" />
                <span className="composer-attachment-name">Transcript · {transcript.title}</span>
                {onRemoveTranscript && (
                  <button
                    className="composer-attachment-remove"
                    aria-label={`Remove the transcript of ${transcript.title}`}
                    disabled={sending}
                    onClick={() => onRemoveTranscript(transcript.sessionId)}
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
            {attachments.map((image) => (
              <span className="composer-attachment" key={image.artifactId}>
                {image.form === "image" ? (
                  <ImageGlyph className="composer-attachment-glyph" />
                ) : (
                  <DocumentGlyph className="composer-attachment-glyph" />
                )}
                <span className="composer-attachment-name">{image.label}</span>
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
            {heldPaths.map((path, index) => (
              <span
                className="composer-attachment"
                key={`held:${path}:${index}`}
                data-testid="composer-held-file"
              >
                <FileBadge path={path} />
                {/* The name alone: nothing is known about form, resizing, or
                    conversion until the file is prepared, and a chip that
                    guessed would be stating what nobody measured. */}
                <span className="composer-attachment-name">{path.split("/").pop() ?? path}</span>
                <button
                  className="composer-attachment-remove"
                  aria-label={`Remove ${path.split("/").pop() ?? path}`}
                  disabled={sending}
                  onClick={() => setHeldPaths((held) => held.filter((_, at) => at !== index))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {slashToken !== null && slashRows > 0 && (
          <div className="mention-popover" role="listbox" data-testid="slash-popover">
            {commandMatches.map((command, index) => (
              <button
                key={command.name}
                role="option"
                aria-selected={index === slashIndex}
                className={index === slashIndex ? "mention-row selected" : "mention-row"}
                // Mouse down, not click: a click blurs the textarea first and
                // the popover would be gone before it landed.
                onMouseDown={(event) => {
                  event.preventDefault();
                  pickSlashCommand(command.insert);
                }}
                data-testid="slash-row"
                data-command={command.name}
              >
                <span className="mono mention-path">/{command.name}</span>
                {command.description && (
                  <span className="mention-note">{command.description}</span>
                )}
              </button>
            ))}
            {reviewRow && (
              <button
                role="option"
                aria-selected={slashIndex === commandMatches.length}
                className={
                  slashIndex === commandMatches.length ? "mention-row selected" : "mention-row"
                }
                onMouseDown={(event) => {
                  event.preventDefault();
                  void performReview();
                }}
                data-testid="slash-review-row"
              >
                <span className="mono mention-path">/review</span>
                <span className="mention-note">Review uncommitted changes — Codex&apos;s reviewer</span>
              </button>
            )}
            {terminal && (
              <button
                role="option"
                aria-selected={slashIndex === commandMatches.length + (reviewRow ? 1 : 0)}
                className={
                  slashIndex === commandMatches.length + (reviewRow ? 1 : 0)
                    ? "mention-row selected"
                    : "mention-row"
                }
                onMouseDown={(event) => {
                  event.preventDefault();
                  pickTerminal();
                }}
                data-testid="slash-terminal-row"
              >
                <span className="mono mention-path">
                  {slashToken.query.length > 0 ? `claude "/${slashToken.query}"` : "claude"}
                </span>
                <span className="mention-note">Open in terminal — your own session</span>
              </button>
            )}
          </div>
        )}
        {mentionToken !== null && mentionMatches.length > 0 && (
          <div className="mention-popover" role="listbox" data-testid="mention-popover">
            {mentionMatches.map((path, index) => (
              <button
                key={path}
                role="option"
                aria-selected={index === mentionIndex}
                className={
                  index === mentionIndex ? "mention-row selected" : "mention-row"
                }
                // Mouse down, not click: a click blurs the textarea first and
                // the popover would be gone before it landed.
                onMouseDown={(event) => {
                  event.preventDefault();
                  pickMention(path);
                }}
                data-testid="mention-row"
              >
                <FileBadge path={path} />
                <span className="mono mention-path">{path}</span>
              </button>
            ))}
          </div>
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
            if (mention) {
              setMentionToken(
                readMentionToken(event.target.value, event.target.selectionStart ?? 0)
              );
            }
            if (slashCommands && slashCommands.length > 0) {
              const token = readSlashToken(
                event.target.value,
                event.target.selectionStart ?? 0
              );
              setSlashToken(token);
              if (token) setSlashIndex(0);
            }
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
            // The slash popover owns the keys while it is open (D-187), the
            // mention popover's exact grammar: Enter picks, never sends.
            if (slashToken !== null && slashRows > 0) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSlashIndex((index) => (index + 1) % slashRows);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setSlashIndex((index) => (index - 1 + slashRows) % slashRows);
                return;
              }
              if (event.key === "Enter" || event.key === "Tab") {
                event.preventDefault();
                const chosen = commandMatches[slashIndex];
                if (chosen) pickSlashCommand(chosen.insert);
                else if (reviewRow && slashIndex === commandMatches.length) void performReview();
                else pickTerminal();
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setSlashToken(null);
                return;
              }
            }
            // The mention popover owns the keys while it is open (D-185):
            // Enter picks, never sends, and Escape closes only it.
            if (mentionToken !== null && mentionMatches.length > 0) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setMentionIndex((index) => (index + 1) % mentionMatches.length);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setMentionIndex(
                  (index) => (index - 1 + mentionMatches.length) % mentionMatches.length
                );
                return;
              }
              if (event.key === "Enter" || event.key === "Tab") {
                event.preventDefault();
                pickMention(mentionMatches[mentionIndex]!);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setMentionToken(null);
                return;
              }
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
            if (event.key === "Escape" && pendingChoice) setPendingChoice(false);
          }}
          aria-label="Direct Claude Code"
          data-testid="composer-input"
        />
        {swapTo !== null && chatHarness && (
          /* One sentence on its own line, no buttons (D-232): the send itself
             is the act, and nothing opens until the person sends. Above the
             foot rather than in it — a sentence in the chip row crushed the
             chips and pushed the send control off the box. */
          <div className="composer-swap" data-testid="composer-swap">
            This chat is {harnessName(chatHarness)}&apos;s. Send starts a new {harnessName(swapTo)} chat with
            its transcript.
          </div>
        )}
        <div className="composer-foot" ref={footRef}>
          {attach && (
            <button
              className="chip-button"
              disabled={!enabled || attaching || !room}
              onClick={() => void addImage()}
              title={
                carried >= MAX_DIRECTION_ATTACHMENTS
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
              onClick={() => {
                setProviderOpen(harnessOf(model));
                setOpenMenu(openMenu === "model" ? null : "model");
              }}
              data-testid="model-chip"
            >
              {harnessOf(model) === "codex" ? (
                <img className="chip-glyph chip-glyph-bitmap" src={codexIcon} alt="" />
              ) : (
                <ClaudeGlyph className="chip-glyph" />
              )}
              {[...CLAUDE_MODELS, ...CODEX_MODELS].find((option) => option.id === model)?.label ?? model}
            </button>
            {openMenu === "model" && (
              /* Providers first, models in a flyout (D-233, owner-asked —
                 Codex's own picker shape): a provider row shows the vendor
                 mark, its name, and the current model where it is this
                 provider's; hovering or clicking it opens that provider's
                 models to the right. The chip stays the harness picker
                 (D-230): choosing a model chooses its harness. */
              <div className="chip-menu chip-menu-providers" role="menu" data-testid="model-menu">
                {HARNESSES.map((provider) => {
                  const models = provider.id === "codex" ? CODEX_MODELS : CLAUDE_MODELS;
                  const owns = harnessOf(model) === provider.id;
                  return (
                    <button
                      key={provider.id}
                      className={
                        providerOpen === provider.id ? "chip-menu-row provider-row open" : "chip-menu-row provider-row"
                      }
                      role="menuitem"
                      aria-haspopup="menu"
                      aria-expanded={providerOpen === provider.id}
                      data-testid={`provider-${provider.id}`}
                      onMouseEnter={() => setProviderOpen(provider.id)}
                      onClick={() => setProviderOpen(provider.id)}
                    >
                      {provider.id === "codex" ? (
                        <img className="chip-glyph chip-glyph-bitmap" src={codexIcon} alt="" />
                      ) : (
                        <ClaudeGlyph className="chip-glyph" />
                      )}
                      {provider.label}
                      <span className="chip-menu-note">
                        {owns ? (models.find((option) => option.id === model)?.label ?? "") : ""}
                        {" ›"}
                      </span>
                    </button>
                  );
                })}
                {providerOpen !== null && (
                  <div className="chip-submenu" role="menu" data-testid="model-submenu">
                    {(providerOpen === "codex" ? CODEX_MODELS : CLAUDE_MODELS).map((option) => (
                      <button
                        key={option.id}
                        className="chip-menu-row"
                        role="menuitem"
                        data-testid="model-option"
                        data-model={option.id}
                        onClick={() => {
                          setModel(option.id);
                          localStorage.setItem("novus-model", option.id);
                          setOpenMenu(null);
                        }}
                      >
                        {option.label}
                        {option.id === model && <span className="chip-menu-note">current</span>}
                      </button>
                    ))}
                  </div>
                )}
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
              Effort · {effortsFor(model).includes(effort) ? effort : DEFAULT_EFFORT}
            </button>
            {openMenu === "effort" && (
              <div className="chip-menu" role="menu" data-testid="effort-menu">
                {/* Exactly what THIS model advertises (D-230): ultra appears
                    only on the Codex models whose model/list names it. */}
                {effortsFor(model).map((option) => (
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

          {speedsFor(model).includes("fast") && (
            <span className="chip-wrap">
              {/* The vendor's own priority tier (D-230): "1.5x speed,
                  increased usage" — offered only where the model offers it,
                  never a dead control. */}
              <button
                className="chip-button"
                disabled={!enabled}
                aria-haspopup="menu"
                aria-expanded={openMenu === "speed"}
                onClick={() => setOpenMenu(openMenu === "speed" ? null : "speed")}
                data-testid="speed-chip"
              >
                <svg
                  className="chip-glyph"
                  viewBox="0 0 20 20"
                  width="14"
                  height="14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M11 3L5 11h4l-1 6 6-8h-4z" />
                </svg>
                Speed · {speed}
              </button>
              {openMenu === "speed" && (
                <div className="chip-menu" role="menu" data-testid="speed-menu">
                  {(["standard", "fast"] as const).map((option) => (
                    <button
                      key={option}
                      className="chip-menu-row"
                      role="menuitem"
                      onClick={() => {
                        setSpeed(option);
                        localStorage.setItem("novus-speed", option);
                        setOpenMenu(null);
                      }}
                    >
                      {option}
                      {option === "fast" && <span className="chip-menu-note">1.5x, more usage</span>}
                      {option === speed && <span className="chip-menu-note">current</span>}
                    </button>
                  ))}
                </div>
              )}
            </span>
          )}

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
                  <p className="policy-head">How should {harnessName(harnessOf(model))}&apos;s actions be approved?</p>
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

          {onStop && textValue.trim().length === 0 && !sending ? (
            /* The running turn's own control, in the send position (D-206):
               a filled square reads as stop everywhere, and it sits where the
               eye already is instead of only on the state line. Typing swaps
               it back to send — a message mid-turn queues and steers. */
            <button
              className="send-button"
              onClick={() => onStop()}
              aria-label="Stop the running turn"
              title="Stop the running turn"
              data-testid="composer-stop"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
                <rect x="4.5" y="4.5" width="15" height="15" rx="2.5" />
              </svg>
            </button>
          ) : (
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
          )}
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
