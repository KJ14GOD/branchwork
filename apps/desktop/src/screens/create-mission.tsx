import { useEffect, useRef, useState } from "react";
import type { Mission } from "@novus/contracts";
import { novus } from "../bridge";

export function CreateMissionDialog({
  onClose,
  onCreated
}: {
  onClose: () => void;
  onCreated: (mission: Mission) => void;
}) {
  const [goal, setGoal] = useState("");
  const [criteria, setCriteria] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const goalRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    goalRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async () => {
    setSaving(true);
    setError(null);
    const result = await novus().missions.create({ goal, successCriteria: criteria });
    setSaving(false);
    if (result.ok) {
      onCreated(result.value);
      return;
    }
    setError(
      result.code === "offline"
        ? "Can't reach Novus. Your mission wasn't created — try again when you're back online."
        : result.message
    );
  };

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="New mission" data-testid="create-dialog">
        <h2>New mission</h2>
        <div className="field">
          <label className="field-label" htmlFor="mission-goal">Goal</label>
          <input
            id="mission-goal"
            ref={goalRef}
            className="input"
            placeholder="What should this mission accomplish?"
            value={goal}
            maxLength={500}
            onChange={(e) => setGoal(e.target.value)}
            data-testid="goal-input"
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="mission-criteria">Success criteria</label>
          <textarea
            id="mission-criteria"
            className="textarea"
            placeholder="How will the team know it's done?"
            value={criteria}
            maxLength={5000}
            onChange={(e) => setCriteria(e.target.value)}
            data-testid="criteria-input"
          />
        </div>
        {error && (
          <div className="inline-error" role="alert" data-testid="create-error">
            {error}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--s-2)" }}>
          <button className="btn btn-text" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={saving || goal.trim().length === 0 || criteria.trim().length === 0}
            data-testid="create-submit"
          >
            Create mission
          </button>
        </div>
      </div>
    </div>
  );
}
