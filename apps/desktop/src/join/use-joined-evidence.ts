import { useEffect, useState } from "react";

import type { SessionFilesResponse } from "@novus/contracts/protocol";

import { readEvidence, readFiles, type MissionEvidence } from "./joined-api.ts";

/**
 * What a joined window can honestly say about the work, read as the joiner.
 *
 * A joined window used to read `/events` and nothing else. That is enough to
 * watch a run and not nearly enough to agree a mission is finished: a teammate
 * could see that a patch tool completed and could not see what the session had
 * changed in total, and could not see whether anything had verified it. Being
 * asked to settle a mission on that is being asked to guess.
 *
 * Two reads, both the host's own, and neither of them recomputed here.
 * `/files` is the worker's projection of this session's applied patches — the
 * same numbers the changed-files panel and the receipts use. `/evidence` is
 * the *same function* `POST /complete` freezes onto the log, so the panel a
 * person finishes from and the record of their finishing cannot disagree: not
 * because two computations are kept in step, but because there is one.
 *
 * That guarantee is why this hook stopped summing `/compare`'s test counts.
 * Those attempts are the baseline plus every fork, they carry no sequence to
 * notice a green check that predates the last edit, and they count tests where
 * the receipt counts build, typecheck and lint as well. The panel and the
 * record disagreed in both directions, and nothing on screen said so.
 *
 * Refetched when `version` moves rather than on a timer, matching the hosting
 * window's `useFileChanges`: the caller passes something that changes when the
 * log does, so a quiet mission costs no requests.
 *
 * A relay join reads neither. That transport carries the event log outbound
 * and authorises nothing else, so there is no endpoint to ask.
 */

const NO_FILES: SessionFilesResponse = {
  files: [],
  additions: 0,
  deletions: 0,
};

export type JoinedEvidence = {
  files: SessionFilesResponse;
  /** Null until the worker has answered, and when it refused. */
  verdict: MissionEvidence | null;
  /**
   * Whether there is anything worth drawing a panel for.
   *
   * False on a mission that has changed nothing and run nothing, where an
   * evidence panel would be two headings over empty space — the placeholder
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
  const [files, setFiles] = useState<SessionFilesResponse>(NO_FILES);
  const [verdict, setVerdict] = useState<MissionEvidence | null>(null);

  useEffect(() => {
    if (!endpoint || !sessionId || !token || relay !== null) {
      setFiles(NO_FILES);
      setVerdict(null);

      return;
    }

    const controller = new AbortController();
    const target = { endpoint, sessionId, token };

    void (async () => {
      const [changed, evidence] = await Promise.all([
        readFiles(target, controller.signal),
        readEvidence(target, controller.signal),
      ]);

      if (controller.signal.aborted) {
        return;
      }

      setFiles(changed ?? NO_FILES);
      setVerdict(evidence);
    })();

    return () => {
      controller.abort();
    };
  }, [endpoint, sessionId, token, relay, version]);

  return {
    files,
    verdict,
    any: files.files.length > 0 || (verdict?.checksRun ?? 0) > 0,
  };
};
