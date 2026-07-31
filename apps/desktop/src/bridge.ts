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

export type TreeEntry = {
  name: string;
  path: string;
  kind: "directory" | "file" | "symlink" | "other";
};

export type FileContent =
  | { kind: "text"; content: string; truncated: boolean }
  | { kind: "binary" };

export type FsBridge = {
  list: (repositoryPath: string, relativePath: string) => Promise<TreeEntry[]>;
  read: (repositoryPath: string, relativePath: string) => Promise<FileContent>;
  /**
   * Tells the main process a repository is legitimately open, before any
   * list/read call naming it will be honored. Called once per successful
   * session open/resume — main refuses fs-list/fs-read for any path that was
   * never registered this way, so the renderer naming an arbitrary
   * repositoryPath is not enough on its own to read outside a session that
   * was actually opened.
   */
  registerRepository: (repositoryPath: string) => void;
};

/**
 * Whether this window was launched to host (the default — spawn a worker,
 * own repositories) or to join (spawn nothing, read someone else's session
 * through an invite). A join launch may carry the invite link it was
 * started with.
 */
export type LaunchDescriptor = {
  mode: "host" | "join";
  invite: string | null;
};

export type NovusBridge = {
  launch: () => Promise<LaunchDescriptor>;
  /** Null in a joining window, which has no worker of its own. */
  workerUrl: () => Promise<string | null>;
  /** Null in a joining window — its credential is the pasted invite token. */
  accessToken: () => Promise<string | null>;
  pickDirectory: () => Promise<string | null>;
  terminal: TerminalBridge;
  fs: FsBridge;
};

declare global {
  interface Window {
    novus?: NovusBridge;
  }
}

/** Present only inside the Electron shell; absent when served in a browser. */
export const bridge = (): NovusBridge | null => window.novus ?? null;
