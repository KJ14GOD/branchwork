import { useEffect, useRef } from "react";
import { truncateLabel } from "../format";
import type { OpenTab } from "./working-set";

/**
 * The open missions, across the top of the window.
 *
 * This strip is the *working set* (see working-set.ts), not a second list of
 * missions: it carries only the rooms this person has open, which is why it is
 * a window-level strip above the rail and the room rather than a row inside the
 * room. The row D-055 removed was inside the room and drew `project.missions` —
 * every mission of one project, in the same order and with the same labels as
 * the rail beside it. Nothing here repeats the rail: a project with nine
 * missions and none of them open shows nothing at all.
 *
 * The file tabs (D-048) stay where they were, *inside* the selected mission and
 * only while a file is open, so the two never read as one control.
 */
export function MissionTabs({
  tabs,
  activeId,
  labelOf,
  projectOf,
  onSelect,
  onClose,
  onNew
}: {
  tabs: OpenTab[];
  activeId: string | null;
  labelOf: (tab: OpenTab) => string;
  projectOf: (tab: OpenTab) => string;
  onSelect: (tab: OpenTab) => void;
  onClose: (tab: OpenTab) => void;
  onNew: () => void;
}) {

  // The room you are reading has to be visible in the strip that says which
  // room you are reading. In a narrow window, or after a relaunch restored more
  // tabs than fit, the selected one can start out past the edge — and narrowing
  // the window is exactly the moment it would go past one.
  const selectedRef = useRef<HTMLSpanElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const show = () => selectedRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    show();
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(show);
    observer.observe(element);
    return () => observer.disconnect();
  }, [activeId, tabs.length]);

  return (
    <div className="mission-strip" data-testid="mission-strip">
      <div
        ref={scrollRef}
        className="mission-strip-scroll"
        role="tablist"
        aria-label="Open missions"
      >
        {tabs.map((tab) => {
          const label = labelOf(tab);
          const project = projectOf(tab);
          const active = tab.id === activeId;
          return (
            <span
              key={tab.id}
              ref={active ? selectedRef : undefined}
              className={active ? "mission-tab active" : "mission-tab"}
              data-testid="mission-tab"
              data-active={active}
              data-project={tab.projectKey}
            >
              <button
                role="tab"
                aria-selected={active}
                className="mission-tab-open"
                onClick={() => onSelect(tab)}
                title={`${label} — ${project}`}
                data-testid="mission-tab-open"
              >
                <span className="mission-tab-name">{truncateLabel(label, 18)}</span>
                {/* Always, not only when two projects are open: a tab that
                    gains and loses its project label as siblings come and go is
                    a tab whose meaning changes without it changing (D-066). */}
                <span className="mission-tab-project">{truncateLabel(project, 14)}</span>
              </button>
              <button
                className="mission-tab-close"
                onClick={() => onClose(tab)}
                aria-label={`Close ${label}`}
                title={`Close ${label}`}
                data-testid="mission-tab-close"
              >
                ×
              </button>
            </span>
          );
        })}
        {/* Directly after the last tab, inside the scroller: it makes the next
            one, so it belongs where the next one will be (D-066). */}
        <button
          className="mission-tab-new"
          onClick={onNew}
          aria-label="New mission"
          title="New mission (⌘T)"
          data-testid="strip-new-mission"
        >
          +
        </button>
      </div>
    </div>
  );
}
