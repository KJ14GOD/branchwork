import { describe, expect, it } from "vitest";
import { isSecretPath } from "../electron/secret-policy";

/**
 * The one credential-path policy (D-052).
 *
 * Every surface that can put a file's name or contents in front of somebody
 * asks this function, so what it answers is the whole protection. The cases
 * below are split three ways on purpose: what it must hide, what it must **not**
 * hide, and what it cannot see. The third group is the honest part — it is a
 * list of names, and a list of names has a boundary.
 *
 * No real credential appears anywhere in this file.
 */

describe("files that hold credentials", () => {
  it("recognises environment files in the dressings people actually use", () => {
    for (const path of [
      ".env",
      ".env.local",
      ".env.production",
      "apps/desktop/.env",
      "services/api/.env.staging"
    ]) {
      expect(isSecretPath(path), path).toBe(true);
    }
  });

  it("recognises registry and package-manager credentials", () => {
    for (const path of [".npmrc", ".pypirc", ".netrc", ".yarnrc.yml", "packages/ui/.npmrc"]) {
      expect(isSecretPath(path), path).toBe(true);
    }
  });

  it("recognises private keys by name and by extension", () => {
    for (const path of [
      "id_rsa",
      "id_ed25519",
      "deploy/id_ecdsa",
      "certs/server.pem",
      "certs/server.key",
      "bundle.p12",
      "bundle.pfx",
      "android/release.keystore",
      ".ssh/config"
    ]) {
      expect(isSecretPath(path), path).toBe(true);
    }
  });

  it("recognises git, cloud, and service-account credential stores", () => {
    for (const path of [
      ".git-credentials",
      ".aws/credentials",
      ".aws/config",
      "gcloud/application_default_credentials.json",
      "deploy/service-account.json",
      "deploy/service_account_prod.json",
      "config/credentials.yml",
      ".kube/config"
    ]) {
      expect(isSecretPath(path), path).toBe(true);
    }
  });

  it("judges a Windows-style path the same way", () => {
    expect(isSecretPath("apps\\api\\.env")).toBe(true);
  });
});

describe("files that only look like they do", () => {
  it("leaves templates visible, because their whole purpose is to be read", () => {
    for (const path of [
      ".env.example",
      ".env.sample",
      ".env.template",
      ".env.dist",
      ".env.defaults",
      "example.env",
      ".env.production.example"
    ]) {
      expect(isSecretPath(path), path).toBe(false);
    }
  });

  it("does not hide ordinary source that happens to share a word", () => {
    for (const path of [
      "src/credentials/index.ts",
      "src/credentials.ts",
      "docs/environment.md",
      "test/keys.test.ts",
      "src/keyboard.tsx",
      "README.md",
      "package.json",
      "src/env.ts"
    ]) {
      expect(isSecretPath(path), path).toBe(false);
    }
  });
});

describe("what this policy cannot see", () => {
  /**
   * Recorded as tests rather than as a comment, so that the day somebody widens
   * the patterns these fail loudly and the claim in PROGRESS.md gets revisited
   * with them. Each of these paths **does** hold a credential in the scenario
   * described, and this function says it does not.
   */
  it("cannot tell that an ordinary filename holds a credential", () => {
    expect(isSecretPath("notes.txt")).toBe(false);
    expect(isSecretPath("src/config.ts")).toBe(false);
    expect(isSecretPath("deploy/settings.yaml")).toBe(false);
  });

  it("cannot tell that a template was filled in with real values", () => {
    // Named `.env.example`, exempted by name, contents never consulted.
    expect(isSecretPath(".env.example")).toBe(false);
  });
});
