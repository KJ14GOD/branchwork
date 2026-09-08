import type { RunnerEvent } from "@novus/contracts";
import type { HarnessResult } from "./harness-stream";

/** The third adapter makes D-230's shared boundary explicit (D-246).
 * Native transports stay behind this interface; permission policy, event
 * attribution and git checkpoints belong to the execution supervisor. */
export interface HarnessEventStream {
  end(): RunnerEvent[];
  readonly sessionId: string | null;
  readonly resumed: boolean;
  readonly result: HarnessResult | null;
}

export interface HarnessWire {
  decision(requestId: string, allow: boolean, message?: string): boolean;
  unsupported(requestId: string, subtype: string): boolean;
  interrupt(): boolean;
  steer(text: string): boolean;
}

export interface HarnessProcessOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  spawnError: string | null;
}

export interface HarnessAdapter {
  run(): Promise<{ stream: HarnessEventStream; outcome: HarnessProcessOutcome }>;
}
