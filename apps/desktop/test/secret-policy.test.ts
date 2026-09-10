import { describe, expect, it } from "vitest";
import { isAttachmentPath, isSecretPath, redactShapes, redact } from "../electron/secret-policy";

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

/**
 * A staged attachment is never the mission's work (D-153).
 *
 * This is the second of two guards, and the one that does not depend on a file
 * existing. The first is `.git/info/exclude`, which makes git ignore the
 * directory; if that were missing or hand-edited, this is what still keeps a
 * person's own file out of a checkpoint — and therefore out of a mission
 * branch, and therefore out of a pull request. The consequence of being wrong
 * is somebody's private file published, which is why there are two.
 */
describe("what the checkpoint refuses to commit", () => {
  it("recognizes a staged attachment wherever the path came from", () => {
    expect(isAttachmentPath(".novus/attachments/art_abc-shot.png")).toBe(true);
    expect(isAttachmentPath("./.novus/attachments/art_abc-shot.png")).toBe(true);
    // Windows separators, since a status line is text and not a promise.
    expect(isAttachmentPath(".novus\\attachments\\art_abc-shot.png")).toBe(true);
    expect(isAttachmentPath(".novus/attachments")).toBe(true);
  });

  it("does not claim the project's own files", () => {
    // The prefix must be the directory, not a name that merely starts with it.
    expect(isAttachmentPath(".novus/attachments-of-mine.txt")).toBe(false);
    expect(isAttachmentPath("src/.novus/attachments/x.png")).toBe(false);
    expect(isAttachmentPath("novus/attachments/x.png")).toBe(false);
    expect(isAttachmentPath("README.md")).toBe(false);
  });
});

describe("values that announce themselves by shape (D-249)", () => {
  it("removes vendor-prefixed tokens wherever they appear", () => {
    const text = [
      "GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef012345",
      "fine: github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV",
      "openai sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD",
      "anthropic sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
      // Assembled at runtime: a literal in this shape trips GitHub's push
      // protection, which cannot tell a fixture from a key.
      `stripe sk_${"live_abcdefghijklmnopqrstuvwx"}`,
      "aws AKIAIOSFODNN7EXAMPLE",
      "slack xoxb-123456789012-abcdefghijkl",
      "google AIzaSyA1234567890abcdefghijklmnopqrstuv",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
    ].join("\n");
    const out = redactShapes(text);
    expect(out).not.toMatch(/ghp_|github_pat_|sk-proj|sk-ant|sk_live|AKIA|xoxb|AIza|eyJ/);
    expect(out.split("[redacted]").length - 1).toBe(9);
  });

  it("keeps the envelope and removes only the value in a header, a URL, and an assignment", () => {
    expect(redactShapes("Authorization: Bearer abc.def-ghi_jkl==")).toBe("Authorization: Bearer [redacted]");
    expect(redactShapes("postgres://novus:hunter2hunter2@127.0.0.1:5433/novus")).toBe(
      "postgres://novus:[redacted]@127.0.0.1:5433/novus"
    );
    expect(redactShapes('DATABASE_PASSWORD="correct horse"')).toBe('DATABASE_PASSWORD="[redacted]"');
    expect(redactShapes("api_key: 0123456789abcdef")).toBe("api_key: [redacted]");
  });

  it("removes a private key block whole, fences included", () => {
    const block = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n-----END OPENSSH PRIVATE KEY-----";
    expect(redactShapes(`before\n${block}\nafter`)).toBe("before\n[redacted]\nafter");
  });

  it("leaves ordinary text, digests, revisions, and near-misses alone", () => {
    const text = [
      "commit 7c71b48722e3aa278101fd3d94c40e07bef6930e",
      "sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "password_min_length=12",
      "the token count was 1,204 and the secret sauce is patience",
      "https://github.com/novus/demo-app/pull/1",
      "TOKEN_BUDGET=100000"
    ].join("\n");
    expect(redactShapes(text)).toBe(text);
  });

  it("runs behind the value pass, so both protections apply to one line", () => {
    const out = redact("key=held-value-1234 and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef012345", ["held-value-1234"]);
    expect(out).toBe("key=[redacted] and [redacted]");
  });

  it("does not see what has no shape: an AWS secret key, or a password in prose", () => {
    const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    expect(redactShapes(`aws_secret ${secret}`)).toBe(`aws_secret ${secret}`);
    expect(redactShapes("my password is hunter2hunter2, please")).toBe("my password is hunter2hunter2, please");
  });
});
