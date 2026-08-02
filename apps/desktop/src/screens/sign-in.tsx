import type { IpcAuthStatus } from "@novus/contracts";
import { novus } from "../bridge";

export function SignIn({ auth }: { auth: IpcAuthStatus }) {
  const waiting = auth.state === "waiting_for_browser";
  return (
    <>
      <header className="topbar">
        <span className="brand">Novus</span>
        <span className="spacer" />
      </header>
      <main className="content">
        <section className="signin" data-testid="sign-in">
          <h1>Novus</h1>
          <p>One shared mission room for the work your coding agents produce.</p>
          <div>
            <button
              className="btn btn-primary"
              disabled={waiting}
              onClick={() => novus().auth.start()}
              data-testid="sign-in-button"
            >
              Sign in with GitHub
            </button>
          </div>
          {waiting && (
            <div className="signin-status" data-testid="waiting" aria-live="polite">
              <span className="status-dot active" />
              Finish signing in from your browser. This screen will continue on its own.
            </div>
          )}
          {auth.state === "failed" && (
            <div className="signin-error" role="alert" data-testid="sign-in-error">
              {auth.message}
            </div>
          )}
        </section>
      </main>
    </>
  );
}
