import {
  SessionEventDraftSchema,
  SessionEventSchema,
  type SessionEvent,
  type SessionEventDraft,
} from "@novus/contracts";

export class InMemorySessionEventStore {
  private readonly events: SessionEvent[] = [];

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

    return event;
  }

  list(sessionId: string): SessionEvent[] {
    return this.events.filter((event) => event.sessionId === sessionId);
  }
}

const defaultEventStore = new InMemorySessionEventStore();

export const appendEvent = (draft: SessionEventDraft): SessionEvent =>
  defaultEventStore.append(draft);

export const getSessionEvents = (sessionId: string): SessionEvent[] =>
  defaultEventStore.list(sessionId);
