export type TerminalBridge = {
  create: (options: {
    cwd?: string | undefined;
    cols: number;
    rows: number;
  }) => Promise<string>;
  write: (id: string, data: string) => void;
  resize: (id: string, cols: number, rows: number) => void;
  dispose: (id: string) => void;
  onData: (id: string, handler: (data: string) => void) => () => void;
  onExit: (id: string, handler: (exitCode: number) => void) => () => void;
};

export type NovusBridge = {
  workerUrl: () => Promise<string>;
  accessToken: () => Promise<string>;
  pickDirectory: () => Promise<string | null>;
  terminal: TerminalBridge;
};

declare global {
  interface Window {
    novus?: NovusBridge;
  }
}

/** Present only inside the Electron shell; absent when served in a browser. */
export const bridge = (): NovusBridge | null => window.novus ?? null;
