import { useCallback, useEffect, useState } from "react";
import type { WorkspaceFile } from "@novus/contracts";
import { novus } from "../bridge";
import { Markdown } from "./markdown";

/**
 * One file, taking the room's canvas (D-048).
 *
 * It replaces the trace rather than sitting beside it, because a file is read
 * at full measure or not at all — a column of code in a third of the window is
 * the generic-IDE shape the product refuses, and a person opening a file has
 * said what they want to look at. Closing it returns the trace exactly as it
 * was; nothing about the mission stops while a file is open.
 *
 * Markdown gets **Preview** and **Edit**, because a project's documentation is
 * the file people most often open and most often want to fix a line of.
 * Everything else is shown as its source. Preview never produces HTML from the
 * file's content (see `markdown.tsx`).
 */

type Load =
  | { kind: "loading" }
  | { kind: "read"; file: WorkspaceFile }
  | { kind: "refused"; message: string };

type Mode = "preview" | "edit";

const isMarkdown = (path: string): boolean => /\.mdx?$/i.test(path);

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileView({
  missionId,
  path,
  onClose
}: {
  missionId: string;
  path: string;
  onClose: () => void;
}) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [mode, setMode] = useState<Mode>("preview");
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const read = useCallback(async () => {
    setLoad({ kind: "loading" });
    const result = await novus().workspace.readFile({ missionId, path });
    setLoad(result.ok ? { kind: "read", file: result.value } : { kind: "refused", message: result.message });
    setDraft(null);
    setSaveError(null);
  }, [missionId, path]);

  useEffect(() => {
    setMode(isMarkdown(path) ? "preview" : "edit");
    void read();
  }, [read, path]);

  const file = load.kind === "read" ? load.file : null;
  const body = draft ?? file?.text ?? "";
  const dirty = draft !== null && draft !== (file?.text ?? "");

  const save = async () => {
    if (draft === null || saving) return;
    setSaving(true);
    setSaveError(null);
    const result = await novus().workspace.writeFile({ missionId, path, text: draft });
    setSaving(false);
    if (!result.ok) {
      setSaveError(result.message);
      return;
    }
    await read();
  };

  return (
    <section className="file-view" aria-label={path} data-testid="file-view" data-path={path}>
      <header className="file-head">
        <span className="file-name mono" title={path}>
          {path}
        </span>
        {file && !file.binary && file.text !== null && (
          <span className="file-meta">{humanBytes(file.bytes)}</span>
        )}
        <span className="head-spacer" />

        {isMarkdown(path) && file?.text !== null && file?.binary === false && (
          <span className="segment file-modes" role="group" aria-label="How to show this file">
            <button
              className="btn btn-secondary"
              aria-pressed={mode === "preview"}
              onClick={() => setMode("preview")}
              data-testid="file-preview"
            >
              Preview
            </button>
            <button
              className="btn btn-secondary"
              aria-pressed={mode === "edit"}
              onClick={() => setMode("edit")}
              data-testid="file-edit"
            >
              Edit
            </button>
          </span>
        )}

        {dirty && (
          <button
            className="btn btn-primary"
            onClick={() => void save()}
            disabled={saving}
            data-testid="file-save"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        )}

        <button className="btn btn-text" onClick={onClose} data-testid="file-close">
          Close
        </button>
      </header>

      {saveError && (
        <p className="inline-error file-error" role="alert" data-testid="file-save-error">
          {saveError}
        </p>
      )}

      <div className="file-body">
        {load.kind === "loading" && <p className="quiet">Reading…</p>}
        {load.kind === "refused" && (
          <p className="inline-error" role="alert" data-testid="file-error">
            {load.message}
          </p>
        )}
        {file?.binary === true && (
          <p className="quiet" data-testid="file-binary">
            This file is not text — {humanBytes(file.bytes)} of it — so there is nothing here that could
            honestly show it.
          </p>
        )}
        {file?.truncated === true && (
          <p className="quiet" data-testid="file-too-large">
            This file is {humanBytes(file.bytes)}, which is larger than Novus shows in a pane. Open it in
            the terminal.
          </p>
        )}
        {file?.text !== null && file?.binary === false && (
          mode === "preview" && isMarkdown(path) ? (
            <div className="file-scroll">
              <Markdown source={body} />
            </div>
          ) : (
            <textarea
              className="file-editor mono"
              value={body}
              spellCheck={false}
              onChange={(event) => setDraft(event.target.value)}
              aria-label={`${path} source`}
              data-testid="file-source"
            />
          )
        )}
      </div>
    </section>
  );
}
