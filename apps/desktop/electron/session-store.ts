import { app, safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Session credential custody. The token lives only in the Electron main
 * process; at rest it is encrypted with the operating system's credential
 * store (Keychain on macOS) via safeStorage. The renderer never sees it,
 * and if OS encryption is unavailable the token is kept in memory only —
 * never written in plaintext.
 */
export class SessionStore {
  private inMemory: string | null = null;

  private get filePath(): string {
    return join(app.getPath("userData"), "session.bin");
  }

  load(): string | null {
    if (this.inMemory) return this.inMemory;
    try {
      if (!existsSync(this.filePath) || !safeStorage.isEncryptionAvailable()) return null;
      const token = safeStorage.decryptString(readFileSync(this.filePath));
      this.inMemory = token;
      return token;
    } catch {
      return null;
    }
  }

  save(token: string): void {
    this.inMemory = token;
    if (!safeStorage.isEncryptionAvailable()) return; // memory-only fallback
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, safeStorage.encryptString(token), { mode: 0o600 });
  }

  clear(): void {
    this.inMemory = null;
    try {
      rmSync(this.filePath, { force: true });
    } catch {
      /* already gone */
    }
  }
}
