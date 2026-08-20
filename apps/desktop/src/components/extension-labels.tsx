import { useEffect, useMemo, useRef, useState } from "react";
import {
  EXTENSION_LABEL_NAME_MAX,
  MAX_LABELS_PER_EXTENSION,
  type ExtensionLabel,
  type ExtensionLabelColor,
  type ExtensionSource,
  type MissionDetailResponse
} from "@novus/contracts";
import { novus } from "../bridge";

/**
 * Extension labels (D-195): the tag half of the collection/tag split.
 *
 * An extension's **collection** is its origin — repository or machine — which
 * is intrinsic, exclusive, and rendered by the group it sits in. A **label**
 * is the other half: a team's own word, many per extension, named and
 * coloured by people, and organizational only — no label changes what a turn
 * is handed.
 *
 * The picker is Linear's: one field that filters and creates, arrow keys and
 * Enter, Escape to close, selection toggling in place without the popover
 * shutting. Editing a label — its name, its colour, its removal — happens on
 * the label's own row rather than in a settings screen somewhere else, so the
 * vocabulary is maintained where it is used.
 */

const COLORS: ExtensionLabelColor[] = [
  "red",
  "orange",
  "yellow",
  "green",
  "cyan",
  "blue",
  "magenta",
  "grey"
];

/** The labels one extension wears, resolved from the mission's own two lists. */
export function labelsFor(
  detail: MissionDetailResponse,
  source: ExtensionSource,
  name: string
): ExtensionLabel[] {
  const ids = new Set(
    detail.extensionLabelAssignments
      .filter((entry) => entry.source === source && entry.name === name)
      .map((entry) => entry.labelId)
  );
  return detail.extensionLabels.filter((label) => ids.has(label.labelId));
}

export function LabelChip({ label }: { label: ExtensionLabel }) {
  return (
    <span
      className={`extension-label label-${label.color}`}
      data-testid="extension-label"
      data-label={label.name}
    >
      {label.name}
    </span>
  );
}

/**
 * One extension's labels, and the control that changes them. The chips are
 * the row's own words; the control is a quiet `+` that appears with the row
 * and opens the picker beneath it.
 */
export function ExtensionLabels({
  detail,
  source,
  name,
  maySet,
  onChanged
}: {
  detail: MissionDetailResponse;
  source: ExtensionSource;
  name: string;
  maySet: boolean;
  onChanged: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const worn = labelsFor(detail, source, name);
  return (
    <span className="extension-labels" data-testid="extension-labels" data-extension={name}>
      {worn.map((label) => (
        <LabelChip key={label.labelId} label={label} />
      ))}
      {maySet && (
        <button
          className="extension-label-add"
          onClick={(event) => {
            event.stopPropagation();
            setPicking((open) => !open);
          }}
          aria-expanded={picking}
          title={`Label ${name}`}
          data-testid="extension-label-add"
          data-extension={name}
        >
          +
        </button>
      )}
      {picking && (
        <LabelPicker
          detail={detail}
          source={source}
          name={name}
          worn={worn}
          onClose={() => setPicking(false)}
          onChanged={onChanged}
        />
      )}
    </span>
  );
}

function LabelPicker({
  detail,
  source,
  name,
  worn,
  onClose,
  onChanged
}: {
  detail: MissionDetailResponse;
  source: ExtensionSource;
  name: string;
  worn: ExtensionLabel[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The label whose own row is open for editing, if any. */
  const [editing, setEditing] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const wornIds = useMemo(() => new Set(worn.map((label) => label.labelId)), [worn]);
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return detail.extensionLabels.filter((label) => label.name.toLowerCase().includes(needle));
  }, [detail.extensionLabels, query]);
  /** Typing a name nothing matches offers to make it — Linear's own move. */
  const creatable =
    query.trim().length > 0 &&
    !detail.extensionLabels.some((label) => label.name.toLowerCase() === query.trim().toLowerCase());
  const rows = creatable ? matches.length + 1 : matches.length;

  useEffect(() => {
    inputRef.current?.focus();
    const onDown = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [onClose]);

  const act = async (run: () => Promise<{ ok: boolean; message?: string }>) => {
    setBusy(true);
    setError(null);
    const result = await run();
    setBusy(false);
    if (!result.ok) {
      setError(result.message ?? "That did not work.");
      return;
    }
    onChanged();
  };

  const toggle = async (label: ExtensionLabel) => {
    const next = wornIds.has(label.labelId)
      ? worn.filter((entry) => entry.labelId !== label.labelId).map((entry) => entry.labelId)
      : [...worn.map((entry) => entry.labelId), label.labelId];
    if (next.length > MAX_LABELS_PER_EXTENSION) {
      setError(`An extension wears at most ${MAX_LABELS_PER_EXTENSION} labels.`);
      return;
    }
    await act(() =>
      novus().missions.setExtensionLabels({
        missionId: detail.mission.missionId,
        source,
        name,
        labelIds: next
      })
    );
  };

  const create = async () => {
    const wanted = query.trim();
    if (!wanted) return;
    // A new label takes the next colour in the list rather than asking twice:
    // naming it is the decision, and its colour is changed on its own row.
    const used = detail.extensionLabels.length;
    const created = await novus().missions.createExtensionLabel({
      missionId: detail.mission.missionId,
      name: wanted,
      color: COLORS[used % COLORS.length] as ExtensionLabelColor
    });
    if (!created.ok) {
      setError(created.message);
      return;
    }
    setQuery("");
    await act(() =>
      novus().missions.setExtensionLabels({
        missionId: detail.mission.missionId,
        source,
        name,
        labelIds: [...worn.map((entry) => entry.labelId), created.value.labelId].slice(
          0,
          MAX_LABELS_PER_EXTENSION
        )
      })
    );
  };

  return (
    <div className="label-picker" ref={boxRef} data-testid="label-picker">
      <input
        ref={inputRef}
        className="label-picker-field"
        value={query}
        maxLength={EXTENSION_LABEL_NAME_MAX}
        placeholder="Label…"
        disabled={busy}
        onChange={(event) => {
          setQuery(event.target.value);
          setCursor(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setCursor((at) => (rows === 0 ? 0 : (at + 1) % rows));
            return;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setCursor((at) => (rows === 0 ? 0 : (at - 1 + rows) % rows));
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            if (creatable && cursor === matches.length) {
              void create();
              return;
            }
            const target = matches[cursor];
            if (target) void toggle(target);
          }
        }}
        data-testid="label-picker-field"
      />
      <div className="label-picker-rows" role="listbox">
        {matches.map((label, index) => (
          <div key={label.labelId} className="label-picker-line">
            <button
              role="option"
              aria-selected={wornIds.has(label.labelId)}
              className={index === cursor ? "label-row selected" : "label-row"}
              disabled={busy}
              onMouseDown={(event) => {
                event.preventDefault();
                void toggle(label);
              }}
              data-testid="label-row"
              data-label={label.name}
            >
              <span className={`label-swatch label-${label.color}`} aria-hidden="true" />
              <span className="label-row-name">{label.name}</span>
              {wornIds.has(label.labelId) && <span className="label-row-check">✓</span>}
            </button>
            <button
              className="label-row-edit"
              disabled={busy}
              onMouseDown={(event) => {
                event.preventDefault();
                setEditing((open) => (open === label.labelId ? null : label.labelId));
              }}
              title={`Rename or recolour ${label.name}`}
              data-testid="label-row-edit"
              data-label={label.name}
            >
              ⋯
            </button>
            {editing === label.labelId && (
              <LabelEditor
                detail={detail}
                label={label}
                busy={busy}
                onDone={() => setEditing(null)}
                onAct={act}
              />
            )}
          </div>
        ))}
        {creatable && (
          <button
            role="option"
            aria-selected={false}
            className={cursor === matches.length ? "label-row selected" : "label-row"}
            disabled={busy}
            onMouseDown={(event) => {
              event.preventDefault();
              void create();
            }}
            data-testid="label-create"
          >
            <span className="label-row-name">Create “{query.trim()}”</span>
          </button>
        )}
        {matches.length === 0 && !creatable && (
          <p className="label-picker-empty">No labels yet. Type a word to make one.</p>
        )}
      </div>
      {error && (
        <p className="label-picker-error tone-danger" role="alert" data-testid="label-picker-error">
          {error}
        </p>
      )}
    </div>
  );
}

/** One label's own maintenance: its word, its colour, and its removal. */
function LabelEditor({
  detail,
  label,
  busy,
  onDone,
  onAct
}: {
  detail: MissionDetailResponse;
  label: ExtensionLabel;
  busy: boolean;
  onDone: () => void;
  onAct: (run: () => Promise<{ ok: boolean; message?: string }>) => Promise<void>;
}) {
  const [name, setName] = useState(label.name);
  return (
    <div className="label-editor" data-testid="label-editor" data-label={label.name}>
      <input
        className="label-picker-field"
        value={name}
        maxLength={EXTENSION_LABEL_NAME_MAX}
        disabled={busy}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          void onAct(() =>
            novus().missions.updateExtensionLabel({
              missionId: detail.mission.missionId,
              labelId: label.labelId,
              name: name.trim()
            })
          ).then(onDone);
        }}
        data-testid="label-editor-name"
      />
      <div className="label-editor-colors">
        {COLORS.map((color) => (
          <button
            key={color}
            className={
              color === label.color
                ? `label-swatch label-${color} chosen`
                : `label-swatch label-${color}`
            }
            disabled={busy}
            aria-label={color}
            onMouseDown={(event) => {
              event.preventDefault();
              void onAct(() =>
                novus().missions.updateExtensionLabel({
                  missionId: detail.mission.missionId,
                  labelId: label.labelId,
                  color
                })
              );
            }}
            data-testid="label-editor-color"
            data-color={color}
          />
        ))}
      </div>
      <button
        className="btn btn-text label-editor-delete"
        disabled={busy}
        onMouseDown={(event) => {
          event.preventDefault();
          void onAct(() =>
            novus().missions.deleteExtensionLabel({
              missionId: detail.mission.missionId,
              labelId: label.labelId
            })
          ).then(onDone);
        }}
        title={`Remove “${label.name}” everywhere it is worn`}
        data-testid="label-editor-delete"
      >
        Remove
      </button>
    </div>
  );
}
