import { useEffect, useRef, useState } from "react";
import { truncateLabel } from "../format";
import { tabsBeside, type OpenTab, type WorkingSet } from "./working-set";

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
  onCloseMany,
  onNew
}: {
  tabs: OpenTab[];
  activeId: string | null;
  labelOf: (tab: OpenTab) => string;
  projectOf: (tab: OpenTab) => string;
  onSelect: (tab: OpenTab) => void;
  onClose: (tab: OpenTab) => void;
  onCloseMany: (ids: string[]) => void;
  onNew: () => void;
}) {
  // The tab's menu (D-251), where a right click lands: close this one, the
  // others, the ones to its left, the ones to its right — the browser's own
  // vocabulary, so nobody has to learn it.
  const [menu, setMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
    };
  }, [menu]);
  const set: WorkingSet = { tabs, activeId };
  const beside = menu ? tabsBeside(set, menu.tabId) : null;
  const menuTab = menu ? (tabs.find((tab) => tab.id === menu.tabId) ?? null) : null;
  const closeIds = (ids: string[]) => {
    setMenu(null);
    if (ids.length > 0) onCloseMany(ids);
  };

  // Tabs of one project sit together under its name, said once (D-251): a
  // run of neighbours sharing a project is one group with one label, so the
  // strip says which rooms belong together instead of repeating a name that
  // was cut to eleven characters on every tab.
  const groups: { key: string; project: string; tabs: OpenTab[] }[] = [];
  for (const tab of tabs) {
    const last = groups[groups.length - 1];
    if (last && last.key === tab.projectKey) last.tabs.push(tab);
    else groups.push({ key: tab.projectKey, project: projectOf(tab), tabs: [tab] });
  }

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
        {groups.map((group, at) => (
          <span key={`${group.key}:${at}`} className="mission-tab-group" data-project={group.key} data-testid="mission-tab-group">
            <span className="mission-tab-group-label" title={group.project} data-testid="mission-tab-group-label">
              {truncateLabel(group.project, 14)}
            </span>
            {group.tabs.map((tab) => {
              const label = labelOf(tab);
              const active = tab.id === activeId;
              return (
                <span
                  key={tab.id}
                  ref={active ? selectedRef : undefined}
                  className={active ? "mission-tab active" : "mission-tab"}
                  data-testid="mission-tab"
                  data-active={active}
                  data-project={tab.projectKey}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setMenu({ tabId: tab.id, x: event.clientX, y: event.clientY });
                  }}
                >
                  <button
                    role="tab"
                    aria-selected={active}
                    className="mission-tab-open"
                    onClick={() => onSelect(tab)}
                    title={`${label} — ${group.project}`}
                    data-testid="mission-tab-open"
                  >
                    <span className="mission-tab-name">{truncateLabel(label, 18)}</span>
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
          </span>
        ))}
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
      {menu && menuTab && beside && (
        <div
          className="chip-menu tab-menu"
          role="menu"
          style={{ left: Math.min(menu.x, window.innerWidth - 220), top: Math.min(menu.y, window.innerHeight - 160) }}
          onMouseDown={(event) => event.stopPropagation()}
          data-testid="tab-menu"
        >
          <button className="chip-menu-row" role="menuitem" onClick={() => closeIds([menuTab.id])} data-testid="tab-menu-close">
            Close
          </button>
          <button className="chip-menu-row" role="menuitem" disabled={beside.others.length === 0} onClick={() => closeIds(beside.others)} data-testid="tab-menu-close-others">
            Close others
          </button>
          <button className="chip-menu-row" role="menuitem" disabled={beside.left.length === 0} onClick={() => closeIds(beside.left)} data-testid="tab-menu-close-left">
            Close to the left
          </button>
          <button className="chip-menu-row" role="menuitem" disabled={beside.right.length === 0} onClick={() => closeIds(beside.right)} data-testid="tab-menu-close-right">
            Close to the right
          </button>
        </div>
      )}
    </div>
  );
}
