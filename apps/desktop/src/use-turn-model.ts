import { useCallback, useState } from "react";

/**
 * Which model handles the next turn.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * INTEGRATION SEAM — read this before wiring anything to it.
 *
 * This hook owns the *choice* and nothing else. It deliberately does not talk
 * to the worker, because the route it would talk to does not exist yet:
 * `POST /sessions/:id/turns` currently accepts `{ goal }` and the worker picks
 * its model from `FixedModelRouter`, built once at boot from
 * `NOVUS_MODEL_PROVIDER` / `NOVUS_MODEL`. A per-turn model is being built in a
 * parallel slice against `apps/worker`, and inventing a request shape here
 * would mean guessing at a contract that slice owns.
 *
 * So the seam is explicit rather than implied:
 *
 *   1. `packages/contracts` grows an optional per-turn model on the turn
 *      request. Optional and additive, so an older client still parses.
 *   2. The worker's turn route reads it and routes accordingly.
 *   3. THEN, and only then: `session-tab.tsx` passes `turnModel.selected`
 *      into `ask()` / `direct()`, and `use-session-actions.ts` puts it in the
 *      JSON body. Both call sites carry a TODO pointing back here.
 *
 * Until step 3 lands, the control is honest about what it is: it remembers a
 * preference and shows it. It does not claim the run obeyed it — nothing in
 * the UI says "this turn ran on Opus" unless the run's own `run.started`
 * event says so, which it always has.
 * ─────────────────────────────────────────────────────────────────────────
 */

export type TurnModelId = "auto" | "opus" | "sonnet" | "fable";

export type TurnModelOption = {
  id: TurnModelId;
  /** What the picker shows. */
  label: string;
  /** One short phrase; the menu is a picker, not a benchmark table. */
  note: string;
  /**
   * The provider model id this choice means, for the routing slice to use
   * when the seam above closes. `null` for "auto", which is a request to let
   * Novus decide rather than a request for a specific model.
   *
   * Kept here rather than in the component so there is exactly one place to
   * correct when a model id changes.
   */
  modelId: string | null;
};

export const TURN_MODELS: readonly TurnModelOption[] = [
  { id: "auto", label: "Auto", note: "Novus decides", modelId: null },
  { id: "opus", label: "Opus", note: "Most capable", modelId: "claude-opus-5" },
  { id: "sonnet", label: "Sonnet", note: "Balanced", modelId: "claude-sonnet-5" },
  { id: "fable", label: "Fable", note: "Deepest reasoning", modelId: "claude-fable-5" },
];

const STORAGE_KEY = "novus.turn-model";

const isTurnModelId = (value: unknown): value is TurnModelId =>
  TURN_MODELS.some((model) => model.id === value);

const load = (): TurnModelId => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);

    return isTurnModelId(stored) ? stored : "auto";
  } catch {
    // Private mode, or a hostile storage policy. A preference that cannot be
    // remembered is not worth failing a render over.
    return "auto";
  }
};

export type TurnModelState = {
  selected: TurnModelId;
  option: TurnModelOption;
  select: (id: TurnModelId) => void;
};

/**
 * Held per tab, persisted app-wide.
 *
 * Per-tab state means switching tabs does not silently change what the tab
 * you were looking at is about to do; an app-wide persisted default means a
 * relaunch does not throw the preference away. A stored value this build does
 * not recognise falls back to "auto" rather than throwing — the same
 * defensive read `app.tsx` does for stored tabs.
 */
export const useTurnModel = (): TurnModelState => {
  const [selected, setSelected] = useState<TurnModelId>(load);

  const select = useCallback((id: TurnModelId) => {
    setSelected(id);

    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // Non-fatal — the choice just will not survive the next launch.
    }
  }, []);

  const option =
    TURN_MODELS.find((model) => model.id === selected) ?? TURN_MODELS[0]!;

  return { selected, option, select };
};
