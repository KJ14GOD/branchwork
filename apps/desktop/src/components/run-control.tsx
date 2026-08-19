import { useCallback, useEffect, useRef, useState } from "react";
import type { MissionDetailResponse } from "@novus/contracts";
import { novus } from "../bridge";
import { liveRunProcess } from "./derive";
import { GatedAction } from "./gated";
import { commandItems, type CommandItem } from "./workspace-config";

/**
 * The Run control (DESIGN.md#component-behavior). One compact control beside
 * the evidence toggle — never a toolbar and never a second navigation.
 *
 * Its menu lists only what the project declared. A command Novus merely
 * inferred is marked as a suggestion and opens the setup dialog instead of
 * running, because a proposal is not an instruction (D-040). Every declared
 * command is a `workspace.command` request the server authorizes again: a
 * remote controller may invoke the commands this project wrote down and
 * nothing else (D-042).
 *
 * While a run command is alive the control collapses to that command's name
 * with Stop, so the room says what is running without growing a toolbar.
 */

type Proposal =
  | { kind: "unread" }
  | { kind: "reading" }
  | { kind: "read"; items: CommandItem[] }
  | { kind: "refused"; message: string };

function MenuChevron() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

const DENIAL = "Invoking a command this project declared needs the workspace.command capability.";

export function RunControl({
  detail,
  onSetup,
  onOpenPreview,
  previewOpen = false
}: {
  detail: MissionDetailResponse;
  /** Opens the bounded setup dialog. Owned by the shell, because the state
   *  line opens the same dialog. */
  onSetup: () => void;
  /** Opens the preview surface in the room (D-098). Owned by the shell,
   *  because the tab it opens sits on the room's working row. */
  onOpenPreview: (url: string) => void;
  /** True while the preview tab is already on the working row — the tab is
   *  then the way back, and a second door reads as a broken first one. */
  previewOpen?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [proposal, setProposal] = useState<Proposal>({ kind: "unread" });
  const [note, setNote] = useState<string | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const missionId = detail.mission.missionId;
  // The lane the detail was computed for — the room's active approach. Every
  // verb here names it, so a command runs in the lane on screen (D-080).
  const workstreamId = detail.workstream?.workstreamId;
  const declared = detail.workspace?.declared ?? [];
  const running = liveRunProcess(detail);
  const previewUrl = running?.previewUrl ?? null;

  /**
   * What the project declared, as the *runner* published it (D-043).
   *
   * Read from the mission rather than from this machine's disk, which is what
   * makes the menu work for a participant who is not at the host machine: they
   * have no worktree to inspect, and `workspace.command` is a capability they
   * may genuinely hold. Suggestions still come from a local inspection, because
   * a suggestion is a reading of a project and only the machine holding it can
   * make one — and a suggestion never runs from here anyway.
   */
  const read = useCallback(async () => {
    setProposal((previous) => (previous.kind === "read" ? previous : { kind: "reading" }));
    const result = await novus().workspace.inspect(missionId, workstreamId);
    setProposal(
      result.ok
        ? { kind: "read", items: commandItems(result.value, declared) }
        : declared.length > 0
          ? { kind: "read", items: commandItems(null, declared) }
          : { kind: "refused", message: result.message }
    );
  }, [missionId, workstreamId, declared]);

  useEffect(() => {
    setProposal({ kind: "unread" });
    setOpen(false);
    setNote(null);
  }, [missionId]);

  useEffect(() => {
    if (!open && note === null) return;
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setNote(null);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      setNote(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, note]);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setNote(null);
    void read();
  };

  const invoke = async (item: CommandItem) => {
    setOpen(false);
    const result = await novus().workspace.command({
      missionId,
      ...(workstreamId ? { workstreamId } : {}),
      kind: item.kind,
      name: item.name
    });
    setNote(result.ok ? null : result.message);
  };

  const stop = async (name: string) => {
    const result = await novus().workspace.stop({
      missionId,
      ...(workstreamId ? { workstreamId } : {}),
      name
    });
    setNote(result.ok ? null : result.message);
  };

  // Opens the preview inside the room (D-098). The main process validates the
  // address against the workstream's own live processes before any view
  // exists, so there is still no path here for an arbitrary address to reach
  // one; the external-browser bridge (D-045) lives on the surface itself as
  // "Open in browser".

  return (
    <span className="run-control" ref={wrapRef}>
      {running ? (
        /* One quiet pill (D-161): the command's own name and port in mono,
           the way in while the preview is not already open — the tab is the
           way back once it is — and Stop as a word, not a second button box
           shouting beside the corner's icons. */
        <span className="run-live" data-testid="run-live">
          <span className="mono run-live-name" title={running.command}>
            {running.name}
            {running.port === null ? "" : ` :${running.port}`}
          </span>
          {/* Only when the process itself reported one: the room never invents
              an address for something that never said it had one. */}
          {previewUrl !== null && !previewOpen && (
            <button className="btn btn-text" onClick={() => onOpenPreview(previewUrl)} data-testid="open-preview">
              Preview
            </button>
          )}
          <GatedAction
            capability="workspace.command"
            capabilities={detail.capabilities}
            denialReason={DENIAL}
            holderLogin={detail.control.holderLogin}
            onClick={() => void stop(running.name)}
            variant="text"
            label="Stop"
            testid="stop-run"
          >
            Stop
          </GatedAction>
        </span>
      ) : (
        <button
          className={open ? "btn btn-secondary run-trigger active" : "btn btn-secondary run-trigger"}
          onClick={toggle}
          aria-haspopup="menu"
          aria-expanded={open}
          data-testid="run-control"
        >
          Run
          <MenuChevron />
        </button>
      )}

      {open && (
        <div className="run-menu" role="menu" aria-label="Run a command this project declared" data-testid="run-menu">
          {proposal.kind === "reading" && <p className="run-menu-note">Reading the project…</p>}
          {proposal.kind === "refused" && (
            <p className="inline-error run-menu-note" role="alert" data-testid="run-menu-error">
              {proposal.message}
            </p>
          )}
          {proposal.kind === "read" && proposal.items.length === 0 && (
            <p className="run-menu-note" data-testid="run-menu-empty">
              This project has not said how to install, run, or verify itself.
            </p>
          )}
          {proposal.kind === "read" &&
            proposal.items.map((item) => (
              <span className="run-menu-item" role="none" key={`${item.kind}:${item.name ?? "setup"}`}>
                {item.suggested ? (
                  // A suggestion never runs from here: it goes to the dialog,
                  // where a person confirms it and it becomes declared.
                  <button
                    className="btn btn-text"
                    role="menuitem"
                    onClick={() => {
                      setOpen(false);
                      onSetup();
                    }}
                    data-testid="run-suggested"
                  >
                    <span className="run-item-label">{item.label}</span>
                    <span className="mono run-item-command">{item.command}</span>
                    <span className="run-item-note">suggested</span>
                  </button>
                ) : (
                  <GatedAction
                    capability="workspace.command"
                    capabilities={detail.capabilities}
                    denialReason={DENIAL}
                    holderLogin={detail.control.holderLogin}
                    onClick={() => void invoke(item)}
                    variant="text"
                    label={`${item.label} — ${item.command}`}
                    testid="run-item"
                  >
                    <span className="run-item-label">{item.label}</span>
                    <span className="mono run-item-command">{item.command}</span>
                    {item.isDefault && <span className="run-item-note">default</span>}
                  </GatedAction>
                )}
              </span>
            ))}

          <div className="run-menu-foot" role="none">
            <button
              className="btn btn-text"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onSetup();
              }}
              data-testid="run-menu-setup"
            >
              Set up workspace…
            </button>
          </div>
        </div>
      )}

      {note && !open && (
        <p className="run-note inline-error" role="alert" data-testid="run-note">
          {note}
          <button className="btn btn-text" onClick={() => setNote(null)}>
            Dismiss
          </button>
        </p>
      )}
    </span>
  );
}
