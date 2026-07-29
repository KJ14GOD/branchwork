/**
 * The package's public surface, which is the store and nothing else.
 *
 * There were module-level `appendEvent` and `getSessionEvents` helpers here,
 * backed by a store opened lazily on first use. Nothing called them, and had
 * anything started to they would have opened a second connection to the same
 * database file as the store the worker already constructs and injects —
 * two writers competing for one write lock inside a single process, for no
 * gain over the store the caller was handed. Every caller takes its store as a
 * parameter, which is also what lets a test hand it an in-memory one. A
 * convenience that quietly disagrees with that is not a convenience.
 */
export {
  defaultDatabasePath,
  InMemorySessionEventStore,
  MEMORY_DATABASE,
  SessionEventStore,
  type SessionEventListener,
  type SessionEventStoreOptions,
} from "./event-store.ts";
