import { useEffect, useState } from "react";

import type { EvidenceFacts } from "../components/workroom/evidence-inspector.tsx";
import { readComparison, readFiles } from "./joined-api.ts";

/**
 * What a joined window can honestly say about the work, read as the joiner.
 *
 * A joined window used to read `/events` and nothing else. That is enough to
 * watch a run and not nearly enough to agree a mission is finished: a teammate
 * could see that a patch tool completed and could not see what the session had
 * changed in total, and could not see whether anything had verified it. Being
 * asked to settle a mission on that is being asked to guess.
 *
 * Two reads, both the host's own: `/files` is the worker's projection of this
 * session's applied patches (the same numbers the changed-files panel and the
 * receipts use) and `/compare` carries the test counts per approach. Neither
 * is recomputed here — a renderer that derives its own evidence is a second
 * opinion that drifts, and the whole point of this panel is that everyone in
 * the room is looking at one set of facts.
 *
 * Refetched when `version` moves rather than on a timer, matching the hosting
 * window's `useFileChanges`: the caller passes something that changes when the
 * log does, so a quiet mission costs no requests.
 *
 * A relay join reads neither. That transport carries the event log outbound
 * and authorises nothing else, so there is no endpoint to ask.
 */

const NOTHING: EvidenceFacts = {
  verified: null,
  testsRun: 0,
  testsPassed: 0,
  files: [],
  contested: [],
  risks: [],
};

export type JoinedEvidence = {
  facts: EvidenceFacts;
  /**
   * Whether there is anything worth drawing a panel for.
   *
   * False on a mission that has changed nothing and run nothing, where an
   * evidence panel would be three headings over empty space — the placeholder
   * this app has already been told to stop drawing.
   */
  any: boolean;
};

export const useJoinedEvidence = (
  endpoint: string | null,
  sessionId: string | null,
  token: string | null,
  relay: string | null,
  /** Anything that moves when the log does; the caller passes the event count. */
  version: number,
): JoinedEvidence => {
  const [facts, setFacts] = useState<EvidenceFacts>(NOTHING);

  useEffect(() => {
    if (!endpoint || !sessionId || !token || relay !== null) {
      setFacts(NOTHING);

      return;
    }

    const controller = new AbortController();
    const target = { endpoint, sessionId, token };

    void (async () => {
      const [files, comparison] = await Promise.all([
        readFiles(target, controller.signal),
        readComparison(target, controller.signal),
      ]);

      if (controller.signal.aborted) {
        return;
      }

      const attempts = comparison?.attempts ?? [];
      const testsRun = attempts.reduce(
        (total, attempt) => total + attempt.testsRun,
        0,
      );
      const testsPassed = attempts.reduce(
        (total, attempt) => total + attempt.testsPassed,
        0,
      );

      setFacts({
        // Null when nothing ran anywhere. Not false, which reads as failing,
        // and emphatically not true. The same three-way rule the worker
        // freezes onto `mission.completed`, so the panel a person finishes
        // from and the record of their finishing cannot disagree.
        verified: testsRun === 0 ? null : testsPassed === testsRun,
        testsRun,
        testsPassed,
        files: files?.files ?? [],
        contested: comparison?.contestedPaths ?? [],
        risks: [],
      });
    })();

    return () => {
      controller.abort();
    };
  }, [endpoint, sessionId, token, relay, version]);

  return {
    facts,
    any: facts.files.length > 0 || facts.testsRun > 0,
  };
};
