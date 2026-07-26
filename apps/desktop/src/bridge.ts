export type NovusBridge = {
  workerUrl: () => Promise<string>;
  pickDirectory: () => Promise<string | null>;
};

declare global {
  interface Window {
    novus?: NovusBridge;
  }
}

/** Present only inside the Electron shell; absent when served in a browser. */
export const bridge = (): NovusBridge | null => window.novus ?? null;
