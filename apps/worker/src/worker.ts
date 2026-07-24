import {SessionEventSchema} from "@novus/contracts"


function appendSession(scheme: SessionEventSchema): string{

}


const event = SessionEventSchema.parse({
    id: "event-1",
    sessionId: "session-1",
    sequence: 0,
    actorId: "agent-1",
    occurredAt: new Date().toISOString(),
    type: "run.progress",
    payload: {
      runId: "run-1",
      message: "Reading repository",
    },
});


console.log(event); 
console.log(secondEvent);