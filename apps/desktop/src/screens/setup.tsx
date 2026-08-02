import type { IpcAuthStatus } from "@novus/contracts";
import { novus } from "../bridge";

/**
 * First-run setup room (DESIGN.md, D-028). Only GitHub is interactive —
 * it is the only connection that exists. Claude Code and Codex render as
 * muted informational cards with zero affordance: they say when they
 * arrive, they never pretend to work.
 */
export function SetupSurface({ auth }: { auth: IpcAuthStatus }) {
  const waiting = auth.state === "waiting_for_browser";

  return (
    <main className="content">
      <div className="setup-drag" />
      <section className="setup" data-testid="setup">
        <h1>Set up Novus</h1>
        <p className="setup-sub">
          Novus signs in with GitHub and operates your team&apos;s coding agents in cloud
          workspaces. Connect your account to begin.
        </p>
        <div className="setup-cards">
          <div className="card">
            <div className="card-head">
              <span className="service-mark">GH</span>
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
              <span className="service-mark">CC</span>
              Claude Code
            </div>
            <div className="card-desc">Anthropic&apos;s coding agent.</div>
            <div className="card-status muted">Arrives when missions can run.</div>
          </div>

          <div className="card">
            <div className="card-head">
              <span className="service-mark">CX</span>
              Codex
            </div>
            <div className="card-desc">OpenAI&apos;s coding agent.</div>
            <div className="card-status muted">Arrives when missions can run.</div>
          </div>
        </div>
      </section>
    </main>
  );
}
