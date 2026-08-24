import { useEffect, useState } from "react";
import type { Connector, ConnectorsResponse } from "@novus/contracts";
import { novus } from "../bridge";

/**
 * Lent accounts (D-217): the person's own claude.ai connectors, and their own
 * On/Off per connector. Lending is the person's standing machine-local choice
 * — not a mission's Admin's — so it lives in first-run and in Settings, both
 * reading and writing through the same bridge.
 */

const SERVICE = (name: string): string => name.replace(/^claude\.ai /, "");

const STATE_WORDS: Record<Connector["state"], { text: string; warn: boolean }> = {
  connected: { text: "Signed in", warn: false },
  needs_auth: { text: "Needs sign-in in the terminal", warn: true },
  failed: { text: "Not reachable", warn: true },
  unknown: { text: "", warn: false }
};

export function useConnectors(): {
  data: ConnectorsResponse | null;
  setLent: (name: string, lent: boolean) => void;
} {
  const [data, setData] = useState<ConnectorsResponse | null>(null);
  useEffect(() => {
    let live = true;
    void novus()
      .connectors.list()
      .then((result) => {
        if (live) setData(result.ok ? result.value : { installed: false, connectors: [] });
      });
    return () => {
      live = false;
    };
  }, []);
  const setLent = (name: string, lent: boolean) => {
    // Optimistic: the toggle answers at once, the disk write confirms.
    setData((prev) =>
      prev
        ? { ...prev, connectors: prev.connectors.map((c) => (c.name === name ? { ...c, lent } : c)) }
        : prev
    );
    void novus()
      .connectors.setLent(name, lent)
      .then((result) => {
        if (result.ok) setData(result.value);
      });
  };
  return { data, setLent };
}

/** A connector's own row: the service, its sign-in state in words, and one
 *  On/Off. Only a connected account can be lent — an account the CLI cannot
 *  reach has nothing to hand a turn. */
export function ConnectorRows({
  connectors,
  onSetLent
}: {
  connectors: Connector[];
  onSetLent: (name: string, lent: boolean) => void;
}) {
  return (
    <>
      {connectors.map((connector) => {
        const words = STATE_WORDS[connector.state];
        const lendable = connector.state === "connected";
        return (
          <div className="settings-card-row" data-testid={`connector-${SERVICE(connector.name)}`} key={connector.name}>
            <div className="settings-card-words">
              <span className="settings-card-title">{SERVICE(connector.name)}</span>
              {words.text && (
                <span className={words.warn ? "settings-card-desc tone-warn" : "settings-card-desc"}>
                  {words.text}
                </span>
              )}
            </div>
            <div className="settings-card-trailing">
              {lendable ? (
                <div className="settings-theme" role="group" aria-label={`Lend ${SERVICE(connector.name)}`}>
                  {[true, false].map((value) => (
                    <button
                      key={String(value)}
                      className={connector.lent === value ? "segment-tab active" : "segment-tab"}
                      aria-pressed={connector.lent === value}
                      onClick={() => onSetLent(connector.name, value)}
                      data-testid={`lend-${SERVICE(connector.name)}-${value ? "on" : "off"}`}
                    >
                      {value ? "Lent" : "Off"}
                    </button>
                  ))}
                </div>
              ) : (
                <span className="settings-card-value tone-warn">unavailable</span>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}
