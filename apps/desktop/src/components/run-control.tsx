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
  onSetup
}: {
  detail: MissionDetailResponse;
  /** Opens the bounded setup dialog. Owned by the shell, because the state
   *  line opens the same dialog. */
  onSetup: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [proposal, setProposal] = useState<Proposal>({ kind: "unread" });
  const [note, setNote] = useState<string | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const missionId = detail.mission.missionId;
  const running = liveRunProcess(detail);
  const previewUrl = running?.previewUrl ?? null;

  // A closed menu asks the machine nothing. Inspecting executes nothing by
  // contract, but it still reads someone's disk, so it waits to be asked —
  // and then it asks every time, because the configuration lives in the branch
  // and a turn (or the setup dialog) may have just changed it. What was read
  // before stays on screen while the new answer arrives, so the menu never
  // blinks empty.
  const read = useCallback(async () => {
    setProposal((previous) => (previous.kind === "read" ? previous : { kind: "reading" }));
    const result = await novus().workspace.inspect(missionId);
    setProposal(
      result.ok ? { kind: "read", items: commandItems(result.value) } : { kind: "refused", message: result.message }
    );
  }, [missionId]);

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
    const result = await novus().workspace.command({ missionId, kind: item.kind, name: item.name });
    setNote(result.ok ? null : result.message);
  };

  const stop = async (name: string) => {
    const result = await novus().workspace.stop({ missionId, name });
    setNote(result.ok ? null : result.message);
  };

  const preview = (url: string) => {
    // Electron only hands https: addresses to the browser, so a local preview
    // has to be offered as an address rather than silently doing nothing.
    const opened = window.open(url, "_blank", "noopener");
    if (!opened) setNote(`Open ${url} in your browser — Novus can't open a local address for you.`);
  };

  return (
    <span className="run-control" ref={wrapRef}>
      {running ? (
        <span className="run-live" data-testid="run-live">
          <span className="status-dot active" />
          <span className="mono run-live-name" title={running.command}>
            {running.name}
            {running.port === null ? "" : ` :${running.port}`}
          </span>
          {/* Only when the process itself reported one: the room never invents
              an address for something that never said it had one. */}
          {previewUrl !== null && (
            <button className="btn btn-text" onClick={() => preview(previewUrl)} data-testid="open-preview">
              Open preview
            </button>
          )}
          <GatedAction
            capability="workspace.command"
            capabilities={detail.capabilities}
            denialReason={DENIAL}
            holderLogin={detail.control.holderLogin}
            onClick={() => void stop(running.name)}
            variant="secondary"
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
