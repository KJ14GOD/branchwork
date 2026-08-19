/**
 * Product policy the wire carries but does not define: the permission-profile
 * tiering (D-115), the harness model allowlist verified live against the CLI,
 * and the evidence-claim sentences said wherever a capture is shown (D-122,
 * D-123). Shapes stay in index.ts; the choices a person or PRODUCT.md made
 * live here.
 */
import { z } from "zod";

/**
 * The lane's permission profile (D-115): Novus's own standing answer policy
 * for the harness's permission questions, chosen by a person who holds
 * `policy.set`, event-recorded, and pinned into each turn at dispatch — a
 * running turn keeps the profile it started under, and a change speaks from
 * the next turn.
 *
 * The wire never changes with it. Every profile runs under the same pinned
 * flags (D-062) with the stdio control channel open, so the harness always
 * asks and every act is still routed, recorded, and refusable; what a profile
 * changes is **who answers**. `manual` routes every question to the room —
 * the default, and exactly the pre-profile behaviour. `accept_edits` answers
 * the harness's file edits itself, on the record; a shell command and
 * everything else still reach a person. `auto` answers everything except a
 * shell command, which declares its targets nowhere (D-097) and stays a human
 * question. `dont_ask` answers everything, shell included, each grant still
 * recorded. `plan` answers **no** to every privileged act, with the reason on
 * the harness's own channel, and runs the CLI in its own plan mode so the
 * model proposes instead of thrashing.
 *
 * There is deliberately no `bypass` value: Claude's `bypassPermissions` turns
 * the asking off at the harness — no routing, no record, no scope enforcement
 * (D-097), no read-turn containment (D-095) — and every way of running
 * without the control channel is a way of running unsupervised (D-062).
 * `dont_ask` is the ceiling, and it keeps the record. No profile touches
 * server authorization: who may direct, stop, decide, or change the profile
 * itself is the capability model's, enforced server-side, whatever the lane's
 * profile says.
 */
export const PERMISSION_PROFILES = [
  { id: "plan", label: "Plan" },
  { id: "manual", label: "Ask every time" },
  { id: "accept_edits", label: "Accept edits" },
  { id: "auto", label: "Auto" },
  { id: "dont_ask", label: "Don't ask" }
] as const;

/** Written literally so the type stays a union of exact ids; a contract test
 *  asserts it never drifts from PERMISSION_PROFILES. */
export const PermissionProfileSchema = z.enum(["plan", "manual", "accept_edits", "auto", "dont_ask"]);
export type PermissionProfile = z.infer<typeof PermissionProfileSchema>;
export const DEFAULT_PERMISSION_PROFILE: PermissionProfile = "manual";

/** The one tier rule, judged here so the route and the renderer cannot
 *  disagree (the D-097 one-judge pattern): `dont_ask` hands the policy a
 *  person's whole answer, shell commands included, so setting it is Mission
 *  Admin's alone. Everything else `policy.set` grants is Operator territory. */
export const ADMIN_ONLY_PERMISSION_PROFILES: readonly PermissionProfile[] = ["dont_ask"];

// --- Harness selection ------------------------------------------------------
// The single allowlist for models. Each id is a real `--model` value verified
// live against the Claude Code CLI (PROGRESS.md, 2026-08-02). The renderer,
// the IPC boundary, and the execution adapter all read this one list; adding a
// value here without live verification is how a fictional model ships.

export const CLAUDE_MODELS = [
  { id: "claude-fable-5", label: "Fable 5" },
  { id: "claude-opus-5", label: "Opus 5" },
  { id: "claude-opus-4-8", label: "Opus 4.8" },
  { id: "claude-opus-4-7", label: "Opus 4.7" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" }
] as const;

/** Written literally so the type stays a union of exact ids; a contract test
 *  asserts it never drifts from CLAUDE_MODELS. */
export const ModelIdSchema = z.enum([
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-5",
  "claude-haiku-4-5-20251001"
]);
export type ModelId = z.infer<typeof ModelIdSchema>;

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const EffortSchema = z.enum(EFFORTS);
export type Effort = (typeof EFFORTS)[number];

export const DEFAULT_MODEL: ModelId = "claude-fable-5";
export const DEFAULT_EFFORT: Effort = "high";

/** The one honest claim a screenshot makes, said wherever one is shown
 *  (D-122). One copy, so the capture surface, the inspector, and the agent's
 *  own tool result can never drift apart. */
export const SCREENSHOT_CLAIM =
  "A screenshot proves what the preview displayed at this revision and time. It does not prove the application is correct.";

/** The recording's version of the same sentence (D-123). */
export const RECORDING_CLAIM =
  "A recording proves what the preview displayed and how it responded during this span. It does not prove the application is correct.";

/** The transcript's honest claim (D-173): a deterministic projection of one
 *  conversation's record, carried into another. It proves what was said, not
 *  that any of it was right. */
export const TRANSCRIPT_CLAIM =
  "A transcript is a projection of one conversation's record at the moment it was carried over. It proves what was said, not that any of it was correct.";

/** The standing warning at the capture controls: pixels are the application's
 *  own output, and Novus does not scan them (ARCHITECTURE.md#secret-placement). */
export const PIXELS_WARNING =
  "Captured pixels are the application's own output and may contain sensitive data. Novus redacts known secrets from text, never from pixels.";
