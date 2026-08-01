import type { ProviderStatus } from "@novus/contracts/protocol";

import type { Theme } from "../../use-theme.ts";
import { ClaudeMark, GitHubMark, OpenAIMark, TerminalMark } from "./marks.tsx";

/**
 * What this machine can reach, said once, before anything else.
 *
 * Novus does not hold accounts and does not run a sign-in of its own. It does
 * not need to: Claude Code and Codex have each already done their own OAuth,
 * and the credential lives with them. `claude auth status` reports a Max plan;
 * `codex login status` reports a ChatGPT login; `gh auth status` reports the
 * GitHub account. This screen reads those and states what it found.
 *
 * That is also the honest answer to "can I use my subscription instead of API
 * credit" — the subscription is already connected, to the CLI, and driving the
 * CLI is what spends it. A Novus-branded sign-in button would be a second
 * login for an account that does not exist.
 *
 * `installed` and `connected` stay separate all the way to the screen, because
 * they fail differently and are fixed differently: one is an install, the
 * other is a sign-in. A single tick would tell somebody nothing about which of
 * the two they have to go and do.
 */

const MARKS: Record<string, (props: { size?: number }) => React.ReactElement> = {
  "claude-code": ClaudeMark,
  codex: OpenAIMark,
  github: GitHubMark,
  "novus-builtin": TerminalMark,
};

const NOTES: Record<string, string> = {
  "claude-code": "Anthropic's coding agent.",
  codex: "OpenAI's coding agent.",
  github: "Clone, push, and read required checks.",
  "novus-builtin": "Novus's own loop, for models with no harness.",
};

const ProviderCard = ({ provider }: { provider: ProviderStatus }) => {
  const Mark = MARKS[provider.id] ?? TerminalMark;

  return (
    <div className="provider">
      <span className="provider__mark" aria-hidden="true">
        <Mark size={20} />
      </span>
      <span className="provider__name">{provider.name}</span>
      <span className="provider__note">
        {NOTES[provider.id] ?? "A coding harness."}
      </span>

      <span
        className={
          provider.connected
            ? "provider__state provider__state--connected"
            : "provider__state provider__state--missing"
        }
      >
        {/*
          The provider's own words for what it is signed in as. "Max plan" and
          "API key — billed per token" are materially different facts, and a
          generic "Connected" would flatten the one thing somebody actually
          wants to know. The tick is drawn by `.provider__state--connected`;
          adding one here too is how the screen ended up with two.
        */}
        {provider.detail}
      </span>
    </div>
  );
};

const THEMES: { id: Theme; label: string }[] = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

export const SetupScreen = ({
  providers,
  loading,
  theme,
  onTheme,
  onRefresh,
  onDone,
}: {
  providers: readonly ProviderStatus[];
  loading: boolean;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  onRefresh: () => void;
  onDone: () => void;
}) => {
  const harnesses = providers.filter((provider) => provider.kind === "harness");
  const ready = harnesses.some((provider) => provider.connected);

  return (
    <div className="setup">
      <h1 className="setup__title">Set up Novus</h1>
      <p className="setup__lede">
        Novus coordinates the coding agents your team already uses. It runs them
        on the accounts they are signed in to — nothing to connect here, and no
        second login.
      </p>

      <div className="setup__providers">
        {providers.map((provider) => (
          <ProviderCard key={provider.id} provider={provider} />
        ))}
      </div>

      <div className="setup__rows">
        <div className="setup__row">
          <div>
            <div className="setup__row-label">Theme</div>
            <p className="setup__row-note">Choose light or dark.</p>
          </div>
          <div className="setup__row-control">
            <div className="themepick" role="group" aria-label="Theme">
              {THEMES.map((option) => (
                <button
                  className={
                    theme === option.id
                      ? "themepick__option themepick__option--selected"
                      : "themepick__option"
                  }
                  key={option.id}
                  type="button"
                  aria-pressed={theme === option.id}
                  onClick={() => onTheme(option.id)}
                >
                  <span
                    className={`themepick__preview themepick__preview--${option.id}`}
                    aria-hidden="true"
                  />
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="setup__row">
          <div>
            <div className="setup__row-label">Agents found</div>
            <p className="setup__row-note">
              {loading
                ? "Looking for installed harnesses…"
                : ready
                  ? "Novus will offer these when you start a workstream."
                  : // Not an error. A machine with no agent installed is a
                    // normal state, and the fix is a name of a thing to go and
                    // install rather than a red banner.
                    "No coding agent is signed in yet. Install Claude Code or Codex, sign in there, then refresh."}
            </p>
          </div>
          <div className="setup__row-control">
            <button className="button" type="button" onClick={onRefresh}>
              {loading ? "Checking…" : "Refresh"}
            </button>
          </div>
        </div>
      </div>

      <div className="setup__foot">
        <span className="setup__row-note">
          Novus never stores your provider credentials. They stay with the CLI
          that owns them.
        </span>
        <button className="button button--primary" type="button" onClick={onDone}>
          Continue
        </button>
      </div>

      <div className="setup__dots" aria-hidden="true">
        <span className="setup__dot setup__dot--active" />
        <span className="setup__dot" />
      </div>
    </div>
  );
};
