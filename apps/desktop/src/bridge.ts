import type { NovusBridge } from "@novus/contracts";

export type { NovusBridge };

declare global {
  interface Window {
    novus: NovusBridge;
  }
}

export const novus = (): NovusBridge => window.novus;
