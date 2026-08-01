import { useCallback, useEffect, useState } from "react";

import {
  ProvidersResponseSchema,
  type ProviderStatus,
} from "@novus/contracts/protocol";

import { authorization } from "./access.ts";

/**
 * Which harnesses this machine can reach, and on whose account.
 *
 * Fetched rather than remembered. Somebody who steps out to run `claude auth
 * login` and comes back expects the screen to agree with them on the next
 * refresh, and a cached answer would tell them their fix did not work.
 */
export type ProvidersState = {
  providers: ProviderStatus[];
  loading: boolean;
  refresh: () => void;
};

export const useProviders = (
  endpoint: string,
  enabled: boolean,
): ProvidersState => {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;
    setLoading(true);

    void (async () => {
      try {
        const response = await fetch(`${endpoint}/providers`, {
          headers: await authorization(),
        });

        if (cancelled || !response.ok) {
          return;
        }

        const parsed = ProvidersResponseSchema.safeParse(await response.json());

        if (!cancelled && parsed.success) {
          setProviders(parsed.data.providers);
        }
      } catch {
        // An unreachable worker is already reported by the event stream's own
        // status. A setup screen that shouts about it twice is noise.
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [endpoint, enabled, nonce]);

  return { providers, loading, refresh };
};
