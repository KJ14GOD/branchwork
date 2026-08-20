import { useEffect, useMemo, useState } from "react";
import type { SetupProbeResponse } from "@novus/contracts";
import { novus } from "../bridge";
import { applyTheme, themePreference, THEME_CHOICES, type ThemePreference } from "../theme";
import { HumanMark } from "./identity";

/**
 * Settings as a place (D-174, re-dressed on sight to the Codex anatomy the
 * owner held up): a full-window takeover — never a floating box — with
 * Back to app and a search field over a grouped, icon-led nav on the left,
 * and card-grouped rows on the right: each row a title, a plain-words
 * description, and its control or value at the row's end. Search is real:
 * it filters every page's rows and shows the hits grouped by their page.
 *
 * The layer overlays the shell rather than replacing it, deliberately: the
 * preview's webview must never unmount (D-170), and an opaque fixed layer
 * covers everything without destroying anything.
 *
 * The standing rule is unchanged: every row states or controls something
 * that exists. A knob lands here the day its behavior does.
 */

type Page = "account" | "appearance" | "notifications" | "agents" | "machine" | "keyboard" | "about";

function PersonGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="5.2" r="2.7" />
      <path d="M2.8 13.6a5.4 5.4 0 0 1 10.4 0" />
    </svg>
  );
}

function SwatchGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="5.9" />
      <path d="M8 2.1v11.8M8 8l4.2-4.2" />
    </svg>
  );
}

function BellGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2.2a4 4 0 0 1 4 4c0 3 .8 4 1.6 4.7H2.4C3.2 10.2 4 9.2 4 6.2a4 4 0 0 1 4-4Z" />
      <path d="M6.6 13.4a1.5 1.5 0 0 0 2.8 0" />
    </svg>
  );
}

function AgentGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="10" height="7.5" rx="1.6" />
      <path d="M8 5V2.8M6 8.4h.01M10 8.4h.01" strokeLinecap="round" />
    </svg>
  );
}

function MachineGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="3.2" width="12" height="7.8" rx="1.2" />
      <path d="M5.5 13.8h5" strokeLinecap="round" />
    </svg>
  );
}

function KeysGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.8" y="4.2" width="12.4" height="7.6" rx="1.4" />
      <path d="M4.4 7h.01M7 7h.01M9.6 7h.01M12.2 7h.01M5 9.4h6" strokeLinecap="round" />
    </svg>
  );
}

function InfoGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="5.9" />
      <path d="M8 7.2v3.6M8 5v.01" />
    </svg>
  );
}

function BackGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9.8 3.2 5 8l4.8 4.8" />
    </svg>
  );
}

const NAV: { group: string; pages: { key: Page; label: string; glyph: () => React.ReactElement }[] }[] = [
  {
    group: "Personal",
    pages: [
      { key: "account", label: "Account", glyph: PersonGlyph },
      { key: "appearance", label: "Appearance", glyph: SwatchGlyph },
      { key: "notifications", label: "Notifications", glyph: BellGlyph },
      { key: "keyboard", label: "Keyboard", glyph: KeysGlyph }
    ]
  },
  {
    group: "This machine",
    pages: [
      { key: "agents", label: "Agents", glyph: AgentGlyph },
      { key: "machine", label: "Repositories", glyph: MachineGlyph }
    ]
  },
  {
    group: "Novus",
    pages: [{ key: "about", label: "About", glyph: InfoGlyph }]
  }
];

const PAGE_LABEL: Record<Page, string> = {
  account: "Account",
  appearance: "Appearance",
  notifications: "Notifications",
  agents: "Agents",
  machine: "Repositories",
  keyboard: "Keyboard",
  about: "About"
};

/** The room's real keys — the ones the code binds, nothing aspirational. */
const KEYS: { keys: string; does: string }[] = [
  { keys: "⌘K", does: "Open the command palette" },
  { keys: "⌘T", does: "Start a mission in the selected project" },
  { keys: "⌘1 – ⌘9", does: "Open the selected project's missions" },
  { keys: "⌘B", does: "Show or hide the projects rail" },
  { keys: "⌘J", does: "Show or hide the terminal dock" },
  { keys: "⌘E", does: "Show or hide the evidence panel" },
  { keys: "⌘F", does: "Find in the conversation" },
  { keys: "⌘,", does: "Open the theme control" },
  { keys: "G then C", does: "Open the Changes section" },
  { keys: "G then V", does: "Open the Verification section" },
  { keys: "G then A", does: "Open All files" },
  { keys: "R", does: "Request control of the lane" },
  { keys: "Esc", does: "Close the open dialog, find bar, or look" }
];

function CardRow({
  title,
  description,
  trailing,
  testid
}: {
  title: string;
  description?: string;
  trailing?: React.ReactNode;
  testid?: string;
}) {
  return (
    <div className="settings-card-row" data-testid={testid}>
      <div className="settings-card-words">
        <span className="settings-card-title">{title}</span>
        {description && <span className="settings-card-desc">{description}</span>}
      </div>
      {trailing && <div className="settings-card-trailing">{trailing}</div>}
    </div>
  );
}

function Card({ heading, children }: { heading?: string; children: React.ReactNode }) {
  return (
    <section className="settings-section">
      {heading && <h3 className="settings-section-heading">{heading}</h3>}
      <div className="settings-card">{children}</div>
    </section>
  );
}

export function SettingsDialog({
  user,
  onClose,
  onSignOut
}: {
  user: { login: string; name: string | null };
  onClose: () => void;
  onSignOut: () => void;
}) {
  const [page, setPage] = useState<Page>("account");
  const [query, setQuery] = useState("");
  const [preference, setPreference] = useState<ThemePreference>(() => themePreference());
  const [probe, setProbe] = useState<SetupProbeResponse | null>(null);
  const [repos, setRepos] = useState<
    { name: string; defaultBranch: string; onThisMachine: boolean }[] | null
  >(null);
  const [version, setVersion] = useState<{ app: string; electron: string } | null>(null);
  const [notif, setNotif] = useState<{ turns: boolean; needsYou: boolean } | null>(null);

  useEffect(() => {
    void novus().setup.probe().then((result) => setProbe(result.ok ? result.value : null));
    void novus().repos.localList().then((result) => setRepos(result.ok ? result.value : []));
    void novus().system.version().then((result) => setVersion(result.ok ? result.value : null));
    void novus().notifications.get().then((result) => setNotif(result.ok ? result.value : null));
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const choose = (next: ThemePreference) => {
    setPreference(next);
    applyTheme(next);
  };

  /** Every row, flat, for search: page → rows of (title, description). */
  const searchable = useMemo(() => {
    const rows: { page: Page; title: string; description: string }[] = [
      { page: "account", title: user.name ?? user.login, description: `Signed in with GitHub as ${user.login}` },
      { page: "account", title: "Sign out", description: "Leave this machine signed out" },
      { page: "appearance", title: "Theme", description: "Light, dark, or follow the system" },
      { page: "notifications", title: "Turn completions", description: "Tell me when a turn finishes while I am elsewhere" },
      { page: "notifications", title: "Needs you", description: "Tell me when the agent asks a question while I am elsewhere" },
      ...KEYS.map((entry) => ({ page: "keyboard" as Page, title: entry.keys, description: entry.does })),
      { page: "agents", title: "Claude Code", description: probe?.claudeCode.installed ? `${probe.claudeCode.version ?? "installed"}${probe.claudeCode.account ? ` · ${probe.claudeCode.account}` : ""}` : "not found on this machine" },
      { page: "agents", title: "Codex", description: probe?.codex.installed ? `${probe.codex.version ?? "installed"}${probe.codex.account ? ` · ${probe.codex.account}` : ""}` : "not found on this machine" },
      ...(repos ?? []).map((repo) => ({ page: "machine" as Page, title: repo.name, description: repo.onThisMachine ? repo.defaultBranch : "on another machine" })),
      { page: "about", title: "Novus", description: version?.app ?? "" },
      { page: "about", title: "Electron", description: version?.electron ?? "" }
    ];
    return rows;
  }, [user, probe, repos, version]);

  const needle = query.trim().toLowerCase();
  const hits = needle.length === 0
    ? []
    : searchable.filter(
        (row) =>
          row.title.toLowerCase().includes(needle) || row.description.toLowerCase().includes(needle)
      );

  const themeSegment = (
    <div className="settings-theme" role="group" aria-label="Theme">
      {THEME_CHOICES.map((choice) => (
        <button
          key={choice.value}
          className={choice.value === preference ? "segment-tab active" : "segment-tab"}
          aria-pressed={choice.value === preference}
          onClick={() => choose(choice.value)}
        >
          {choice.label}
        </button>
      ))}
    </div>
  );

  const agentTrailing = (facts: { installed: boolean; version: string | null; account: string | null } | undefined) =>
    facts === undefined ? (
      <span className="settings-card-value">…</span>
    ) : facts.installed ? (
      <span className="settings-card-value">
        {facts.version ?? "installed"}
        {facts.account ? ` · ${facts.account}` : ""}
      </span>
    ) : (
      <span className="settings-card-value tone-warn">not found</span>
    );

  return (
    <div className="settings-page-layer" role="dialog" aria-label="Settings" data-testid="settings-dialog">
      <div className="settings-drag-strip" aria-hidden="true" />
      <aside className="settings-side">
        <button className="settings-back" onClick={onClose} data-testid="settings-back">
          <BackGlyph />
          Back to app
        </button>
        <input
          className="settings-search"
          placeholder="Search settings…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          data-testid="settings-search"
        />
        {NAV.map((group) => (
          <div className="settings-group" key={group.group}>
            <span className="settings-group-label">{group.group}</span>
            {group.pages.map((entry) => (
              <button
                key={entry.key}
                className={entry.key === page && needle === "" ? "settings-nav-item active" : "settings-nav-item"}
                aria-current={entry.key === page && needle === ""}
                onClick={() => {
                  setQuery("");
                  setPage(entry.key);
                }}
                data-testid={`settings-page-${entry.key}`}
              >
                <entry.glyph />
                {entry.label}
              </button>
            ))}
          </div>
        ))}
      </aside>

      <main className="settings-main" data-testid="settings-pane">
        {needle !== "" ? (
          <>
            <h2 className="settings-page-title">Search</h2>
            {hits.length === 0 ? (
              <p className="settings-hint">Nothing matches "{query}".</p>
            ) : (
              <Card>
                {hits.map((hit, at) => (
                  <button
                    key={`${hit.page}-${at}`}
                    className="settings-card-row settings-hit"
                    onClick={() => {
                      setQuery("");
                      setPage(hit.page);
                    }}
                  >
                    <div className="settings-card-words">
                      <span className="settings-card-title">{hit.title}</span>
                      <span className="settings-card-desc">{hit.description}</span>
                    </div>
                    <span className="settings-card-value">{PAGE_LABEL[hit.page]}</span>
                  </button>
                ))}
              </Card>
            )}
          </>
        ) : page === "account" ? (
          <>
            <h2 className="settings-page-title">Account</h2>
            <Card heading="Identity">
              <div className="settings-card-row">
                <HumanMark login={user.login} name={user.name} />
                <div className="settings-card-words">
                  <span className="settings-card-title">{user.name ?? user.login}</span>
                  <span className="settings-card-desc">Signed in with GitHub as {user.login}</span>
                </div>
              </div>
              <CardRow
                title="Sign out"
                description="Leaves this machine signed out; missions and evidence stay on the record"
                trailing={
                  <button className="btn btn-secondary" onClick={onSignOut} data-testid="settings-sign-out">
                    Sign out
                  </button>
                }
              />
            </Card>
          </>
        ) : page === "appearance" ? (
          <>
            <h2 className="settings-page-title">Appearance</h2>
            <Card heading="Theme">
              <CardRow title="Theme" description="Light, dark, or follow the system" trailing={themeSegment} />
            </Card>
          </>
        ) : page === "notifications" ? (
          <>
            <h2 className="settings-page-title">Notifications</h2>
            <Card heading="While you are elsewhere">
              <CardRow
                title="Turn completions"
                description="A turn finished or failed — the work is ready to read. Silent while the window is focused."
                trailing={
                  notif === null ? (
                    <span className="settings-card-value">…</span>
                  ) : (
                    <div className="settings-theme" role="group" aria-label="Turn completions">
                      {[true, false].map((value) => (
                        <button
                          key={String(value)}
                          className={notif.turns === value ? "segment-tab active" : "segment-tab"}
                          aria-pressed={notif.turns === value}
                          onClick={() => {
                            const next = { ...notif, turns: value };
                            setNotif(next);
                            void novus().notifications.set(next);
                          }}
                          data-testid={`notif-turns-${value ? "on" : "off"}`}
                        >
                          {value ? "On" : "Off"}
                        </button>
                      ))}
                    </div>
                  )
}
              />
              <CardRow
                title="Needs you"
                description="The agent asked a question — nothing moves until somebody answers. Silent while the window is focused."
                trailing={
                  notif === null ? (
                    <span className="settings-card-value">…</span>
                  ) : (
                    <div className="settings-theme" role="group" aria-label="Needs you">
                      {[true, false].map((value) => (
                        <button
                          key={String(value)}
                          className={notif.needsYou === value ? "segment-tab active" : "segment-tab"}
                          aria-pressed={notif.needsYou === value}
                          onClick={() => {
                            const next = { ...notif, needsYou: value };
                            setNotif(next);
                            void novus().notifications.set(next);
                          }}
                          data-testid={`notif-needsYou-${value ? "on" : "off"}`}
                        >
                          {value ? "On" : "Off"}
                        </button>
                      ))}
                    </div>
                  )
}
              />
            </Card>
            <p className="settings-hint">Clicking a notification brings you back to the mission that asked.</p>
          </>
        ) : page === "agents" ? (
          <>
            <h2 className="settings-page-title">Agents</h2>
            <Card heading="On this machine">
              <CardRow
                title="Claude Code"
                description="Anthropic's coding agent, read from its own install"
                trailing={agentTrailing(probe?.claudeCode)}
              />
              <CardRow
                title="Codex"
                description="OpenAI's coding agent, read from its own install"
                trailing={agentTrailing(probe?.codex)}
              />
            </Card>
            <p className="settings-hint">The same probe the setup room runs — facts, never configuration on the agents' behalf.</p>
          </>
        ) : page === "machine" ? (
          <>
            <h2 className="settings-page-title">Repositories</h2>
            <Card heading="Local repositories">
              {repos === null ? (
                <CardRow title="Reading…" />
              ) : repos.length === 0 ? (
                <CardRow title="No local repositories yet" description="Add project puts one here" />
              ) : (
                repos.map((repo) => (
                  <CardRow
                    key={repo.name}
                    title={repo.name}
                    description={repo.onThisMachine ? `default branch ${repo.defaultBranch}` : undefined}
                    trailing={
                      repo.onThisMachine ? (
                        <span className="settings-card-value">on this Mac</span>
                      ) : (
                        <span className="settings-card-value tone-warn">on another machine</span>
                      )
                    }
                  />
                ))
              )}
            </Card>
            <p className="settings-hint">Workspaces are worktrees beside these; your own checkout is never touched.</p>
          </>
        ) : page === "keyboard" ? (
          <>
            <h2 className="settings-page-title">Keyboard</h2>
            <Card heading="The room">
              {KEYS.map((entry) => (
                <CardRow
                  key={entry.keys}
                  title={entry.does}
                  trailing={<span className="settings-key mono">{entry.keys}</span>}
                />
              ))}
            </Card>
          </>
        ) : (
          <>
            <h2 className="settings-page-title">About</h2>
            <Card heading="Build">
              <CardRow title="Novus" trailing={<span className="settings-card-value">{version?.app ?? "…"}</span>} />
              <CardRow title="Electron" trailing={<span className="settings-card-value">{version?.electron ?? "…"}</span>} />
            </Card>
            <p className="settings-hint">
              The multiplayer control plane for coding agents. Missions, evidence, and decisions live in the room; the record is the product.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
