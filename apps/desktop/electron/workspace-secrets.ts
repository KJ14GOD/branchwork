import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Custody of the project's secret values (D-041).
 *
 * A value lives in operating-system-backed storage on the machine that supplied
 * it, keyed by repository and variable name, at mode 0600. It is never written
 * to the control plane, never crosses the renderer bridge, never enters an
 * event, a diff, a transcript, or a log. What leaves this module is a *name*;
 * a value leaves only into the environment of a project command that the
 * configuration explicitly selected it for.
 *
 * If the operating system offers no encryption, nothing is written at all —
 * a plaintext secret on disk is worse than an unprepared workspace, and an
 * unprepared workspace is a state the product already knows how to say.
 */

/** The operating system's credential store, injectable so the store's rules
 *  are testable without an Electron app. */
export interface SecretCrypto {
  available(): boolean;
  encrypt(plaintext: string): Buffer;
  decrypt(ciphertext: Buffer): string;
}

interface SafeStorageShape {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(ciphertext: Buffer): string;
}

/**
 * Loaded on demand rather than imported: a static `import ... from "electron"`
 * would drag the whole Electron runtime into every import of this module,
 * including the tests of everything that depends on it.
 */
export function osCrypto(): SecretCrypto {
  const load = (): SafeStorageShape => {
    const { safeStorage } = require("electron") as { safeStorage: SafeStorageShape };
    return safeStorage;
  };
  return {
    available: () => {
      try {
        return load().isEncryptionAvailable();
      } catch {
        return false;
      }
    },
    encrypt: (plaintext) => load().encryptString(plaintext),
    decrypt: (ciphertext) => load().decryptString(ciphertext)
  };
}

export interface SecretStore {
  /** The variable names this machine has supplied for a repository. */
  suppliedNames(repositoryKey: string): string[];
  /** Values for the named variables, and only those. */
  values(repositoryKey: string, names: readonly string[]): Record<string, string>;
  /** Every value held for a repository — used to redact process output, never
   *  to populate an environment. */
  allValues(repositoryKey: string): string[];
  put(repositoryKey: string, name: string, value: string): void;
  forget(repositoryKey: string, name: string): void;
}

/** Bounds a single value, so a pasted file cannot become a multi-megabyte
 *  keychain entry, and the whole set, so redaction stays cheap. */
const MAX_VALUE_LENGTH = 8_000;
const MAX_NAMES = 100;

export function fileSecretStore(directory: string, crypto: SecretCrypto = osCrypto()): SecretStore {
  const fileFor = (repositoryKey: string): string =>
    // The repository key is a local identifier; hashing it keeps the filename
    // from carrying anything about the machine into a backup or a screenshot.
    join(directory, `${createHash("sha256").update(repositoryKey).digest("hex").slice(0, 32)}.bin`);

  const read = (repositoryKey: string): Record<string, string> => {
    const path = fileFor(repositoryKey);
    try {
      if (!existsSync(path) || !crypto.available()) return {};
      const parsed: unknown = JSON.parse(crypto.decrypt(readFileSync(path)));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out: Record<string, string> = {};
      for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "string") out[name] = value;
      }
      return out;
    } catch {
      // An unreadable store is an empty one: the workspace is then honestly
      // unprepared rather than half-configured with stale values.
      return {};
    }
  };

  const write = (repositoryKey: string, values: Record<string, string>): void => {
    if (!crypto.available()) return; // never a plaintext fallback
    mkdirSync(directory, { recursive: true });
    writeFileSync(fileFor(repositoryKey), crypto.encrypt(JSON.stringify(values)), { mode: 0o600 });
  };

  return {
    suppliedNames: (repositoryKey) => Object.keys(read(repositoryKey)).sort(),
    values: (repositoryKey, names) => {
      const held = read(repositoryKey);
      const selected: Record<string, string> = {};
      for (const name of names) {
        const value = held[name];
        if (typeof value === "string") selected[name] = value;
      }
      return selected;
    },
    allValues: (repositoryKey) => Object.values(read(repositoryKey)),
    put: (repositoryKey, name, value) => {
      const held = read(repositoryKey);
      if (held[name] === undefined && Object.keys(held).length >= MAX_NAMES) {
        throw new Error("This machine already holds as many values as Novus keeps for one repository.");
      }
      held[name] = value.slice(0, MAX_VALUE_LENGTH);
      write(repositoryKey, held);
    },
    forget: (repositoryKey, name) => {
      const held = read(repositoryKey);
      if (held[name] === undefined) return;
      delete held[name];
      write(repositoryKey, held);
    }
  };
}

/** A store that holds nothing, for a machine where the operating system offers
 *  no credential encryption. Named rather than implicit so the caller can say
 *  why a secret is missing. */
export function emptySecretStore(): SecretStore {
  return {
    suppliedNames: () => [],
    values: () => ({}),
    allValues: () => [],
    put: () => {
      throw new Error("This operating system offers no credential storage, so Novus will not hold a secret.");
    },
    forget: () => undefined
  };
}
