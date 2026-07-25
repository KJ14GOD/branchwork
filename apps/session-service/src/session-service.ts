import {
  SessionEventDraftSchema,
  SessionEventSchema,
  type SessionEvent,
  type SessionEventDraft,
} from "@novus/contracts";

export type SessionEventListener = (event: SessionEvent) => void;

export class InMemorySessionEventStore {
  private readonly events: SessionEvent[] = [];
  private readonly listeners = new Set<SessionEventListener>();

  append(draftInput: SessionEventDraft): SessionEvent {
    const draft = SessionEventDraftSchema.parse(draftInput);
    const sequence = this.events.filter(
      (event) => event.sessionId === draft.sessionId,
    ).length;

    const event = SessionEventSchema.parse({
      ...draft,
      eventId: crypto.randomUUID(),
      sequence,
      occurredAt: new Date().toISOString(),
    });

    this.events.push(event);
    for (const listener of this.listeners) {
      listener(event);
    }

    return event;
  }

  list(sessionId: string): SessionEvent[] {
    return this.events.filter((event) => event.sessionId === sessionId);
  }

  subscribe(listener: SessionEventListener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }
}

const defaultEventStore = new InMemorySessionEventStore();

export const appendEvent = (draft: SessionEventDraft): SessionEvent =>
  defaultEventStore.append(draft);

export const getSessionEvents = (sessionId: string): SessionEvent[] =>
  defaultEventStore.list(sessionId);
