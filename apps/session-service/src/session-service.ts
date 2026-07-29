import type { SessionEvent, SessionEventDraft } from "@novus/contracts";

import { SessionEventStore } from "./event-store.ts";

export {
  defaultDatabasePath,
  InMemorySessionEventStore,
  MEMORY_DATABASE,
  SessionEventStore,
  type SessionEventListener,
  type SessionEventStoreOptions,
} from "./event-store.ts";

/**
 * Opened on first use rather than at import.
 *
 * Importing this package should not create a database file — the desktop, the
 * tests and the demo all import it, and only one caller wants the durable log.
 */
let defaultEventStore: SessionEventStore | undefined;

const store = (): SessionEventStore => {
  defaultEventStore ??= new SessionEventStore();

  return defaultEventStore;
};

export const appendEvent = (draft: SessionEventDraft): SessionEvent =>
  store().append(draft);

export const getSessionEvents = (sessionId: string): SessionEvent[] =>
  store().list(sessionId);
