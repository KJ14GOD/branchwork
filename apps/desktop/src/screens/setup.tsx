import { useEffect, useState, type CSSProperties } from "react";
import { siClaudecode, siGithub } from "simple-icons";
import codexIcon from "../assets/codex-icon.png";
import type { HarnessProbe, IpcAuthStatus, SetupProbeResponse } from "@novus/contracts";
import { novus } from "../bridge";
import { ConnectorRows, useConnectors } from "../components/connectors";
import { applyTheme, themePreference, THEME_CHOICES, type ThemePreference } from "../theme";

function Glyph({ path, title }: { path: string; title: string }) {
  return (
    <svg className="card-glyph" viewBox="0 0 24 24" role="img" aria-label={title} fill="currentColor">
      <path d={path} />
    </svg>
  );
}

/** An observed fact arrives like a probe writing its finding: character by
 *  character, in the mono voice. The text is in the accessibility tree whole
 *  — only the paint is staggered — and reduced-motion shows it at once. */
function TypedFact({ text, testid }: { text: string; testid?: string }) {
  return (
    <span className="connected typed" aria-label={text} data-testid={testid} key={text}>
      {Array.from(text).map((character, at) => (
        <span key={at} aria-hidden="true" style={{ "--char": at } as CSSProperties}>
          {character}
        </span>
      ))}
    </span>
  );
}

function harnessStatus(probe: HarnessProbe | null): { text: string; muted: boolean } {
  if (!probe) return { text: "Checking this Mac…", muted: true };
  if (!probe.installed) return { text: "Not found on this Mac.", muted: true };
  if (probe.account) return { text: `✓ ${probe.account}`, muted: false };
  // Installed but the account state is unknowable — never claim "not signed in".
  return { text: `✓ Installed${probe.version ? ` · ${probe.version}` : ""}`, muted: false };
}

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
  // Two steps: connect, then — only when there is something to lend — the
  // accounts page (D-217). A person can always skip straight to the room.
  const [step, setStep] = useState<"connect" | "lend">("connect");
  const { data: connectors, setLent } = useConnectors();

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
  // The lend page is offered only when the CLI is here and holds at least one
  // account — an empty page would be a control over nothing (prohibited
  // pattern 11).
  const hasAccounts = (connectors?.connectors.length ?? 0) > 0;

  if (step === "lend") {
    return (
      <LendSurface
        connectors={connectors?.connectors ?? []}
        onSetLent={setLent}
        onFinished={onFinished}
      />
    );
  }

  return (
    <main className="content">
      <div className="setup-drag" />
      <section className="setup" data-testid="setup">
        <h1>Set up Novus</h1>
        {/* Cloud execution stays future-tense until it exists (D-028); what
            runs today is a harness on this Mac. Once connected, the sentence
            turns to the person — the room is ready and says so (D-148). */}
        <p className="setup-sub">
          {connected
            ? `Ready when you are, ${auth.user.login}. Cloud workspaces arrive later.`
            : "Your coding agents, under command — GitHub for identity, running on this Mac. Cloud workspaces arrive later."}
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
              {connected && <TypedFact text={`✓ Connected as ${auth.user.login}`} testid="github-connected" />}
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
              {claude.muted ? <span>{claude.text}</span> : <TypedFact text={claude.text} />}
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <img className="card-glyph card-glyph-bitmap" src={codexIcon} alt="Codex" />
              Codex
            </div>
            <div className="card-desc">OpenAI&apos;s coding agent. Cloud runs arrive with missions.</div>
            <div className={codex.muted ? "card-status muted" : "card-status"}>
              {codex.muted ? <span>{codex.text}</span> : <TypedFact text={codex.text} />}
            </div>
          </div>
        </div>

        <div className="setup-row">
          <div>
            <div className="setup-row-label">Theme</div>
            <div className="setup-row-desc">Light, dark, or follow the system.</div>
          </div>
          <div className="segment" role="group" aria-label="Theme">
            {THEME_CHOICES.map((option) => (
              <button
                key={option.value}
                className={theme === option.value ? "segment-tab active" : "segment-tab"}
                aria-pressed={theme === option.value}
                onClick={() => pickTheme(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {/* The door is always on the page (D-148): a person should see where
            this ends from the moment it starts. It unlocks when GitHub is
            connected; it never appears out of nowhere. When the person's own
            accounts are lendable, the door leads to that page first (D-217);
            otherwise it finishes. */}
        <div className="setup-finish">
          <button
            className="btn btn-primary"
            onClick={() => (hasAccounts ? setStep("lend") : onFinished())}
            disabled={!connected}
            data-testid="finish-setup"
          >
            {hasAccounts ? "Next" : "Finish setup"}
          </button>
        </div>
      </section>
    </main>
  );
}

/**
 * Lend your accounts (D-217): the second first-run page, shown only when
 * Claude Code on this Mac holds account connectors. Each is off until the
 * person lends it; lending is their own standing choice, and the same rows
 * live on Settings → Agents afterward. Minimalist by the owner's direction —
 * one card, one On/Off per row, a way past.
 */
function LendSurface({
  connectors,
  onSetLent,
  onFinished
}: {
  connectors: import("@novus/contracts").Connector[];
  onSetLent: (name: string, lent: boolean) => void;
  onFinished: () => void;
}) {
  return (
    <main className="content">
      <div className="setup-drag" />
      <section className="setup" data-testid="setup-lend">
        <h1>Lend your accounts</h1>
        <p className="setup-sub">
          Let the agent use your own Claude connectors on the turns this Mac runs. Each stays yours —
          it only ever acts when you approve, and only you can answer. Change these any time in Settings.
        </p>

        <div className="settings-card">
          <ConnectorRows connectors={connectors} onSetLent={onSetLent} />
        </div>

        <div className="setup-finish">
          <button className="btn btn-text" onClick={onFinished} data-testid="lend-skip">
            Skip for now
          </button>
          <button className="btn btn-primary" onClick={onFinished} data-testid="lend-finish">
            Finish setup
          </button>
        </div>
      </section>
    </main>
  );
}
