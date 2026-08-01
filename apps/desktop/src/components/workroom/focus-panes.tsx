import type { SessionEvent } from "@novus/contracts";

import { FileTree, FileViewer } from "../browse-panel.tsx";
import { TimelineView } from "../timeline-view.tsx";
import type { FileTreeState } from "../../use-file-tree.ts";

/**
 * The two escape hatches that need markup of their own.
 *
 * Both were permanent regions of a shell that drew every region on every
 * screen: the repository browser took the whole body in `mode: "browse"`, and
 * the event list was the centre column of the mission screen. Neither is what a
 * person opens the app to look at, and neither is going away — technical truth
 * stays inspectable, one deliberate interaction away.
 *
 * They live here rather than inline in `session-tab.tsx` so that file can be
 * what it claims to be: a container that derives the mission's state and
 * renders one screen.
 */

/** The file tree and the viewer, side by side. Read-only, as they always were. */
export const RepositoryPane = ({ state }: { state: FileTreeState }) => (
  <div className="focus__split">
    <FileTree state={state} />
    <FileViewer state={state} />
  </div>
);

export const EventLogPane = ({
  events,
  empty,
  disconnected,
  endpoint,
  busy,
  raw,
  grouped,
  highlighted,
  groupOverrides,
  onToggleGroup,
}: {
  events: readonly SessionEvent[];
  /**
   * Nothing has actually happened yet.
   *
   * Not `events.length === 0`, which is true for nobody: `session.created`
   * lands the instant a session opens, so the unfiltered log always holds at
   * least one row and this pane would otherwise show that single bare card
   * forever.
   */
  empty: boolean;
  disconnected: boolean;
  endpoint: string;
  busy: boolean;
  raw: boolean;
  /** Grouping is only ever applied to the unfiltered log — see timeline-view. */
  grouped: boolean;
  highlighted: number | null;
  groupOverrides: Map<number, boolean>;
  onToggleGroup: (key: number, currentlyOpen: boolean) => void;
}) => (
  <div className="timeline">
    {empty ? (
      <div className="empty empty--page">
        {disconnected ? (
          <>
            <p className="empty__title">No connection</p>
            <p className="empty__hint">
              The worker at {endpoint} is not answering. Reconnect from the
              command palette, or check that it is running.
            </p>
          </>
        ) : (
          <>
            <p className="empty__title">Nothing has run yet</p>
            <p className="empty__hint">
              Every command, patch and test the agent runs will appear here as
              it happens, with its arguments and its raw result.
            </p>
          </>
        )}
      </div>
    ) : (
      <TimelineView
        events={events as SessionEvent[]}
        busy={busy}
        raw={raw}
        highlighted={highlighted}
        groupOverrides={groupOverrides}
        onToggleGroup={onToggleGroup}
        group={grouped}
      />
    )}
  </div>
);
