import { useCallback, useEffect, useMemo, useState } from "react";
import type { WorkspaceFile } from "@novus/contracts";
import { novus } from "../bridge";
import { tokenizeLines } from "./highlight";
import { Markdown } from "./markdown";

/**
 * One file, as its own tab in the room (D-048).
 *
 * It is a sibling of the room's own tab rather than something layered inside
 * one, because that is what it is: another thing you are looking at, at the
 * same level, switched between the same way. While a file tab is selected the
 * mission's own header is not shown at all — the title, the state line, and the
 * authority row are answers about the mission, and repeating them above a
 * source file is chrome the reader did not ask for and cannot act on. Switching
 * back to the room's tab brings all of it back untouched.
 *
 * The composer stays. Reading a file is not a reason to stop being able to
 * direct, and it is very often the reason to start.
 */

type Load =
  | { kind: "loading" }
  | { kind: "read"; file: WorkspaceFile }
  | { kind: "refused"; message: string };

type Mode = "preview" | "edit";

const isMarkdown = (path: string): boolean => /\.mdx?$/i.test(path);

function extensionOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function CopyGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5.75" y="5.75" width="8.5" height="8.5" rx="1.5" />
      <path d="M10.25 5.75v-2a1.5 1.5 0 0 0-1.5-1.5h-5a1.5 1.5 0 0 0-1.5 1.5v5a1.5 1.5 0 0 0 1.5 1.5h2" />
    </svg>
  );
}

/** Highlighted source with its line numbers. Memoised on the text, because
 *  tokenising a 60KB file on every keystroke elsewhere in the room is work
 *  nobody asked for. */
function Source({ text, extension }: { text: string; extension: string }) {
  const lines = useMemo(() => tokenizeLines(text, extension), [text, extension]);
  return (
    <div className="code" data-testid="file-source-view">
      <div className="code-gutter" aria-hidden="true">
        {lines.map((_line, at) => (
          <span key={at}>{at + 1}</span>
        ))}
      </div>
      <pre className="code-body mono">
        {lines.map((line, at) => (
          <div className="code-line" key={at}>
            {line.length === 0 ? (
              "\n"
            ) : (
              <>
                {line.map((token, position) => (
                  <span key={position} className={`tok-${token.kind}`}>
                    {token.text}
                  </span>
                ))}
                {"\n"}
              </>
            )}
          </div>
        ))}
      </pre>
    </div>
  );
}

export function FileView({
  missionId,
  workstreamId,
  path,
  onAddContext
}: {
  missionId: string;
  /** The lane whose worktree holds the file — the room's active approach (D-080). */
  workstreamId?: string;
  path: string;
  /** Pins this file onto the composer's next send (D-182). */
  onAddContext?: () => void;
}) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [mode, setMode] = useState<Mode>("preview");
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const read = useCallback(async () => {
    setLoad({ kind: "loading" });
    const result = await novus().workspace.readFile({
      missionId,
      ...(workstreamId ? { workstreamId } : {}),
      path
    });
    setLoad(result.ok ? { kind: "read", file: result.value } : { kind: "refused", message: result.message });
    setDraft(null);
    setSaveError(null);
  }, [missionId, workstreamId, path]);

  useEffect(() => {
    setMode(isMarkdown(path) ? "preview" : "edit");
    void read();
  }, [read, path]);

  const file = load.kind === "read" ? load.file : null;
  const body = draft ?? file?.text ?? "";
  const dirty = draft !== null && draft !== (file?.text ?? "");
  const readable = file !== null && file.text !== null && !file.binary;

  const save = async () => {
    if (draft === null || saving) return;
    setSaving(true);
    setSaveError(null);
    const result = await novus().workspace.writeFile({
      missionId,
      ...(workstreamId ? { workstreamId } : {}),
      path,
      text: draft
    });
    setSaving(false);
    if (!result.ok) {
      setSaveError(result.message);
      return;
    }
    await read();
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      setSaveError("This machine would not let Novus write to the clipboard.");
    }
  };

  return (
    <section className="file-view" aria-label={path} data-testid="file-view" data-path={path}>
      {/* The path as a chip where the content starts, with the one action a
          reader reaches for first. */}
      <header className="file-head">
        <span className="file-chip mono" title={path}>
          {path}
        </span>
        {(readable || file?.image !== null && file?.image !== undefined) && file && (
          <span className="file-meta">{humanBytes(file.bytes)}</span>
        )}
        <span className="head-spacer" />

        {onAddContext && (
          <button
            className="btn btn-text"
            onClick={onAddContext}
            title={`Pin ${path} onto your next message`}
            data-testid="file-add-to-chat"
          >
            Add to chat
          </button>
        )}

        {isMarkdown(path) && readable && (
          <span className="file-modes" role="group" aria-label="How to show this file">
            <button
              className={mode === "preview" ? "segment-tab active" : "segment-tab"}
              aria-pressed={mode === "preview"}
              onClick={() => setMode("preview")}
              data-testid="file-preview"
            >
              Preview
            </button>
            <button
              className={mode === "edit" ? "segment-tab active" : "segment-tab"}
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

        {readable && (
          <button
            className="icon-button"
            onClick={() => void copy()}
            aria-label={`Copy ${path}`}
            title={copied ? "Copied" : "Copy the file's contents"}
            data-testid="file-copy"
            data-copied={copied ? "true" : "false"}
          >
            <CopyGlyph />
          </button>
        )}
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
        {file?.image !== null && file?.image !== undefined && (
          <div className="file-scroll file-image-pane">
            <img className="file-image" src={file.image} alt={path} data-testid="file-image" />
          </div>
        )}
        {file?.binary === true && file.image === null && (
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
        {readable &&
          (isMarkdown(path) && mode === "preview" ? (
            <div className="file-scroll">
              <Markdown source={body} />
            </div>
          ) : isMarkdown(path) ? (
            <textarea
              className="file-editor mono"
              value={body}
              spellCheck={false}
              onChange={(event) => setDraft(event.target.value)}
              aria-label={`${path} source`}
              data-testid="file-source"
            />
          ) : (
            <div className="file-scroll">
              <Source text={body} extension={extensionOf(path)} />
            </div>
          ))}
      </div>
    </section>
  );
}
