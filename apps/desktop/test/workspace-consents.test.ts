import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PreparedFile } from "@novus/contracts";
import {
  MAX_CONSENTED_PATHS,
  consentedFilePaths,
  loadFileConsents,
  recordFileConsents
} from "../electron/workspace-consents";

/**
 * The rules of the consent store, without a window.
 *
 * The ones that would be expensive to be wrong about: a refused path
 * remembered as if a person had approved it, one repository's consents
 * leaking into another's, a store that grows without bound, and a corrupted
 * file that takes forking down with it instead of merely forgetting.
 */

let dir: string;
let store: string;

const copied = (path: string): PreparedFile => ({ path, copied: true, refusedBecause: null });
const refused = (path: string): PreparedFile => ({
  path,
  copied: false,
  refusedBecause: "not ignored by git"
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "novus-consents-"));
  store = join(dir, "local-file-consents.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("recording consents", () => {
  it("remembers only the paths that were actually copied", () => {
    recordFileConsents(store, "repo-a", [copied(".env"), refused("secrets/key.pem"), copied(".env.local")]);
    expect(consentedFilePaths(store, "repo-a")).toEqual([".env", ".env.local"]);
  });

  it("writes nothing at all when nothing was copied", () => {
    recordFileConsents(store, "repo-a", [refused(".env")]);
    expect(() => readFileSync(store)).toThrow();
  });

  it("records a path once, however many times it is consented", () => {
    recordFileConsents(store, "repo-a", [copied(".env"), copied(".env")]);
    recordFileConsents(store, "repo-a", [copied(".env")]);
    expect(consentedFilePaths(store, "repo-a")).toEqual([".env"]);
  });

  it("keeps repositories apart", () => {
    recordFileConsents(store, "repo-a", [copied(".env")]);
    recordFileConsents(store, "repo-b", [copied("config/local.json")]);
    expect(consentedFilePaths(store, "repo-a")).toEqual([".env"]);
    expect(consentedFilePaths(store, "repo-b")).toEqual(["config/local.json"]);
    expect(consentedFilePaths(store, "repo-c")).toEqual([]);
  });

  it("evicts the oldest consent once the bound is reached, never the newest", () => {
    for (let index = 0; index < MAX_CONSENTED_PATHS + 10; index += 1) {
      recordFileConsents(store, "repo-a", [copied(`file-${index}`)]);
    }
    const paths = consentedFilePaths(store, "repo-a");
    expect(paths).toHaveLength(MAX_CONSENTED_PATHS);
    expect(paths[0]).toBe("file-10");
    expect(paths.at(-1)).toBe(`file-${MAX_CONSENTED_PATHS + 9}`);
  });

  it("re-consenting refreshes a path's place in the eviction order", () => {
    recordFileConsents(store, "repo-a", [copied("old"), copied("kept")]);
    recordFileConsents(store, "repo-a", [copied("old")]);
    expect(consentedFilePaths(store, "repo-a")).toEqual(["kept", "old"]);
  });

  it("keeps the store private to this user", () => {
    recordFileConsents(store, "repo-a", [copied(".env")]);
    expect(statSync(store).mode & 0o777).toBe(0o600);
  });
});

describe("loading consents", () => {
  it("survives a reload: what one process recorded, the next one lists", () => {
    recordFileConsents(store, "repo-a", [copied(".env"), copied(".env.local")]);
    // A fresh load reads only the file, exactly as a relaunched app would.
    expect(loadFileConsents(store)).toEqual({ "repo-a": [".env", ".env.local"] });
  });

  it("treats a missing store as empty", () => {
    expect(loadFileConsents(store)).toEqual({});
    expect(consentedFilePaths(store, "repo-a")).toEqual([]);
  });

  it("treats a malformed store as empty rather than refusing to fork", () => {
    for (const broken of ["{not json", '"a string"', "[]", "null"]) {
      writeFileSync(store, broken);
      expect(loadFileConsents(store)).toEqual({});
    }
  });

  it("drops entries it cannot use and keeps the rest", () => {
    writeFileSync(
      store,
      JSON.stringify({ "repo-a": [".env", 7, null, ""], "repo-b": "not-a-list", "repo-c": ["ok"] })
    );
    expect(loadFileConsents(store)).toEqual({ "repo-a": [".env"], "repo-c": ["ok"] });
  });

  it("recording over a malformed store starts clean instead of crashing", () => {
    writeFileSync(store, "{corrupt");
    recordFileConsents(store, "repo-a", [copied(".env")]);
    expect(consentedFilePaths(store, "repo-a")).toEqual([".env"]);
  });
});
