import { execFile } from "node:child_process";
import crossSpawn from "cross-spawn";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SetupProbeResponse, HarnessProbe } from "@novus/contracts";

/**
 * Read-only observation of harness CLIs on this machine (D-029). Everything
 * is best-effort: any failure degrades to "not found" / null, never a crash,
 * and nothing observed here is transmitted anywhere. Cloud executions use
 * org-provisioned credentials regardless (D-013).
 */

/** Computed per call, never at module load (D-222 amended twice): startup
 *  folds the login shell's PATH into process.env after modules import, so a
 *  load-time snapshot would freeze the bare Finder PATH and miss every
 *  version-manager install — exactly the staleness the fold-in exists to fix. */
const probePath = (): string =>
  [process.env.PATH ?? "", join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"].join(":");

function cliVersion(binary: string): Promise<string | null> {
  return new Promise((resolve) => {
    // cross-spawn, not execFile (D-229): on Windows the npm-installed CLI is
    // a .cmd shim CreateProcess cannot start directly, so a bare execFile
    // reports "not found" about a binary that is right there.
    const child = crossSpawn(binary, ["--version"], { env: { ...process.env, PATH: probePath() } });
    let out = "";
    const timer = setTimeout(() => child.kill(), 5000);
    child.stdout?.on("data", (chunk) => {
      out += String(chunk);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? (out.trim().split("\n")[0] ?? null) : null);
    });
  });
}

function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function parseClaudeCredentials(raw: string): string | null {
  const parsed = JSON.parse(raw) as { claudeAiOauth?: { subscriptionType?: string } };
  const plan = parsed.claudeAiOauth?.subscriptionType;
  return plan ? `${titleCase(plan)} plan` : "Signed in";
}

async function claudeAccount(): Promise<string | null> {
  try {
    return parseClaudeCredentials(readFileSync(join(homedir(), ".claude", ".credentials.json"), "utf8"));
  } catch {
    /* fall through: on macOS the credentials live in the Keychain */
  }
  if (process.platform !== "darwin") return null;
  return new Promise((resolve) => {
    execFile(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { timeout: 4000 },
      (error, stdout) => {
        if (error) return resolve(null);
        try {
          resolve(parseClaudeCredentials(stdout.trim()));
        } catch {
          resolve("Signed in");
        }
      }
    );
  });
}

function codexAccount(): string | null {
  try {
    const raw = readFileSync(join(homedir(), ".codex", "auth.json"), "utf8");
    const parsed = JSON.parse(raw) as { OPENAI_API_KEY?: string; tokens?: { id_token?: string } };
    const idToken = parsed.tokens?.id_token;
    if (idToken) {
      const payloadPart = idToken.split(".")[1];
      if (payloadPart) {
        const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as Record<
          string,
          unknown
        >;
        const auth = payload["https://api.openai.com/auth"] as { chatgpt_plan_type?: string } | undefined;
        if (auth?.chatgpt_plan_type) return `ChatGPT ${titleCase(auth.chatgpt_plan_type)}`;
      }
      return "ChatGPT login";
    }
    if (parsed.OPENAI_API_KEY) return "API key";
    return "Signed in";
  } catch {
    return null;
  }
}

export async function probeHarnesses(): Promise<SetupProbeResponse> {
  const [claudeVersion, codexVersion] = await Promise.all([cliVersion("claude"), cliVersion("codex")]);
  const claudeCode: HarnessProbe = {
    installed: claudeVersion !== null,
    version: claudeVersion,
    account: claudeVersion !== null ? await claudeAccount() : null
  };
  const codex: HarnessProbe = {
    installed: codexVersion !== null,
    version: codexVersion,
    account: codexVersion !== null ? codexAccount() : null
  };
  return { claudeCode, codex };
}
