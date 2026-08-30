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
/**
 * The Codex allowlist (D-230, corrected the morning after): taken from the
 * installed CLI's own `model/list` answer (app-server, 0.145.0) — ids,
 * display names, per-model reasoning efforts, and speed tiers verbatim —
 * after the first list shipped from stale knowledge and the owner caught it
 * on sight. The live-codex probe asserts this list against `model/list`, so
 * vendor drift fails a run instead of lying in a menu.
 */
export const CODEX_MODELS = [
  { id: "gpt-5.6-sol", label: "GPT-5.6-Sol", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], speeds: ["fast"] },
  { id: "gpt-5.6-terra", label: "GPT-5.6-Terra", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], speeds: ["fast"] },
  { id: "gpt-5.6-luna", label: "GPT-5.6-Luna", efforts: ["low", "medium", "high", "xhigh", "max"], speeds: ["fast"] },
  { id: "gpt-5.5", label: "GPT-5.5", efforts: ["low", "medium", "high", "xhigh"], speeds: ["fast"] },
  { id: "gpt-5.4", label: "GPT-5.4", efforts: ["low", "medium", "high", "xhigh"], speeds: ["fast"] },
  { id: "gpt-5.4-mini", label: "GPT-5.4-Mini", efforts: ["low", "medium", "high", "xhigh"], speeds: [] }
] as const;

/** Which harness a model belongs to (D-230): the model chip is the harness
 *  picker, so the harness is derived, never a second control that must agree. */
export const HARNESSES = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" }
] as const;
export const HarnessIdSchema = z.enum(["claude-code", "codex"]);
export type HarnessId = z.infer<typeof HarnessIdSchema>;

/** One allowlist across harnesses; a value outside it never reaches a CLI. */
export const ModelIdSchema = z.enum([
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-5",
  "claude-haiku-4-5-20251001",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini"
]);
export type ModelId = z.infer<typeof ModelIdSchema>;

export function harnessOf(model: string): HarnessId {
  return (CODEX_MODELS as readonly { id: string }[]).some((entry) => entry.id === model)
    ? "codex"
    : "claude-code";
}

/** The effort universe across harnesses. `ultra` is Codex's own top rung
 *  ("maximum reasoning with automatic task delegation", per model/list) and
 *  exists on no Claude model — which is why the offered list is per-model
 *  (`effortsFor`), never this universe raw. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export const EffortSchema = z.enum(EFFORTS);
export type Effort = (typeof EFFORTS)[number];

/** What a Claude model accepts — the list verified live against the CLI
 *  (PROGRESS.md, 2026-08-02), which never included `ultra`. */
export const CLAUDE_EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** The efforts this exact model advertises (D-230): Codex per its own
 *  `model/list` answer, Claude per the verified flag list. The composer
 *  offers exactly this, and the runner clamps to it. */
export function effortsFor(model: string): readonly Effort[] {
  const codex = (CODEX_MODELS as readonly { id: string; efforts: readonly string[] }[]).find(
    (entry) => entry.id === model
  );
  return codex ? (codex.efforts as readonly Effort[]) : CLAUDE_EFFORTS;
}

/** The speed tiers this model offers (D-230): Codex's `priority` tier reads
 *  as `fast` ("1.5x speed, increased usage" — the vendor's own words);
 *  everything else has none, and no chip renders where none exist. */
export const SPEEDS = ["standard", "fast"] as const;
export const SpeedSchema = z.enum(SPEEDS);
export type Speed = (typeof SPEEDS)[number];
export function speedsFor(model: string): readonly Speed[] {
  const codex = (CODEX_MODELS as readonly { id: string; speeds: readonly string[] }[]).find(
    (entry) => entry.id === model
  );
  return codex && codex.speeds.includes("fast") ? SPEEDS : ["standard"];
}

export const DEFAULT_MODEL: ModelId = "claude-fable-5";
export const DEFAULT_CODEX_MODEL: ModelId = "gpt-5.6-sol";
export const DEFAULT_EFFORT: Effort = "high";
export const DEFAULT_SPEED: Speed = "standard";

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
