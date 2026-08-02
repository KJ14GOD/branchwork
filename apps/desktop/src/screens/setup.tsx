import { useEffect, useState } from "react";
import { siClaudecode, siGithub } from "simple-icons";
import codexIcon from "../assets/codex-icon.png";
import type { HarnessProbe, IpcAuthStatus, SetupProbeResponse } from "@novus/contracts";
import { novus } from "../bridge";
import { applyTheme, themePreference, type ThemePreference } from "../theme";

function Glyph({ path, title }: { path: string; title: string }) {
  return (
    <svg className="card-glyph" viewBox="0 0 24 24" role="img" aria-label={title} fill="currentColor">
      <path d={path} />
    </svg>
  );
}

function harnessStatus(probe: HarnessProbe | null): { text: string; muted: boolean } {
  if (!probe) return { text: "Checking this Mac…", muted: true };
  if (!probe.installed) return { text: "Not found on this Mac.", muted: true };
  if (probe.account) return { text: `✓ ${probe.account}`, muted: false };
  // Installed but the account state is unknowable — never claim "not signed in".
  return { text: `✓ Installed${probe.version ? ` · ${probe.version}` : ""}`, muted: false };
}

const THEMES: { value: ThemePreference; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" }
];

/**
 * First-run setup room (DESIGN.md, D-028/D-029). GitHub connects for real;
 * the harness cards report observed local facts about this machine. Cloud
 * execution stays future-tense until it exists.
 */
export function SetupSurface({
  auth,
  onFinished
}: {
  auth: IpcAuthStatus;
  onFinished: () => void;
}) {
  const waiting = auth.state === "waiting_for_browser";
  const connected = auth.state === "signed_in";
  const [probe, setProbe] = useState<SetupProbeResponse | null>(null);
  const [theme, setTheme] = useState<ThemePreference>(themePreference());

  useEffect(() => {
    novus().setup.probe().then((result) => {
      if (result.ok) setProbe(result.value);
    });
  }, []);

  const pickTheme = (value: ThemePreference) => {
    applyTheme(value);
    setTheme(value);
  };

  const claude = harnessStatus(probe?.claudeCode ?? null);
  const codex = harnessStatus(probe?.codex ?? null);

  return (
    <main className="content">
      <div className="setup-drag" />
      <section className="setup" data-testid="setup">
        <h1>Set up Novus</h1>
        <p className="setup-sub">
          Novus signs in with GitHub and operates your team&apos;s coding agents in cloud
          workspaces.
        </p>

        <div className="setup-cards">
          <div className="card">
            <div className="card-head">
              <Glyph path={siGithub.path} title="GitHub" />
              GitHub
            </div>
            <div className="card-desc">Your identity, your repositories, your pull requests.</div>
            <div className="card-status">
              {auth.state === "signed_out" && (
                <button className="btn btn-primary" onClick={() => novus().auth.start()} data-testid="sign-in-button">
                  Connect
                </button>
              )}
              {waiting && (
                <span data-testid="waiting" aria-live="polite">
                  Finish in your browser — this screen continues on its own.
                </span>
              )}
              {connected && (
                <span className="connected" data-testid="github-connected">
                  ✓ Connected as {auth.user.login}
                </span>
              )}
              {auth.state === "failed" && (
                <span className="card-error" role="alert" data-testid="sign-in-error">
                  {auth.message}&nbsp;
                  <button className="btn btn-text" onClick={() => novus().auth.start()}>
                    Try again
                  </button>
                </span>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <Glyph path={siClaudecode.path} title="Claude Code" />
              Claude Code
            </div>
            <div className="card-desc">Anthropic&apos;s coding agent. Cloud runs arrive with missions.</div>
            <div className={claude.muted ? "card-status muted" : "card-status"}>
              <span className={claude.muted ? undefined : "connected"}>{claude.text}</span>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <img className="card-glyph card-glyph-bitmap" src={codexIcon} alt="Codex" />
              Codex
            </div>
            <div className="card-desc">OpenAI&apos;s coding agent. Cloud runs arrive with missions.</div>
            <div className={codex.muted ? "card-status muted" : "card-status"}>
              <span className={codex.muted ? undefined : "connected"}>{codex.text}</span>
            </div>
          </div>
        </div>

        <div className="setup-row">
          <div>
            <div className="setup-row-label">Theme</div>
            <div className="setup-row-desc">Light, dark, or follow the system.</div>
          </div>
          <div className="segment" role="group" aria-label="Theme">
            {THEMES.map((option) => (
              <button
                key={option.value}
                className="btn btn-secondary"
                aria-pressed={theme === option.value}
                onClick={() => pickTheme(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {connected && (
          <div className="setup-finish">
            <button className="btn btn-primary" onClick={onFinished} data-testid="finish-setup">
              Finish setup
            </button>
          </div>
        )}
      </section>
    </main>
  );
}
