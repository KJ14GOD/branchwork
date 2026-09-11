import { useEffect, useMemo, useState } from "react";
import type { DictationSettings, SetupProbeResponse, Diagnostics, UpdateStatus } from "@novus/contracts";
import { novus } from "../bridge";
import { focusQuietly } from "./dialog";
import { applyTheme, themePreference, THEME_CHOICES, type ThemePreference } from "../theme";
import { currentThemeFile, listThemes, parseThemeFile, removeTheme, saveTheme, themeFileOf, type CustomTheme } from "../themes";
import { layout, setLayout, type Layout } from "../layout";
import { forgetHabits, habitWords, setNoticing, undo as undoHabit, useHabits, type HabitKey } from "../habits";
import { ClaudeGlyph } from "./identity";
import {
  BINDING_ACTIONS,
  chordFromEvent,
  chordLabel,
  chordRefusal,
  isOverridden,
  resetBinding,
  setBinding,
  useKeybindings,
  type BindingAction
} from "../keybindings";
import { HumanMark } from "./identity";
import { ConnectorRows, useConnectors } from "./connectors";

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

type Page = "account" | "appearance" | "layout" | "notifications" | "agents" | "voice" | "machine" | "keyboard" | "about";

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

function LayoutGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <rect x="2.2" y="2.7" width="11.6" height="10.6" rx="1.6" />
      <path d="M6.4 2.7v10.6M6.4 9.2h7.4" />
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

function MicGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5.6" y="1.9" width="4.8" height="7.2" rx="2.4" />
      <path d="M3.8 7.4a4.2 4.2 0 0 0 8.4 0M8 11.6v2M6 13.9h4" />
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
      { key: "layout", label: "Layout", glyph: LayoutGlyph },
      { key: "notifications", label: "Notifications", glyph: BellGlyph },
      { key: "keyboard", label: "Keyboard", glyph: KeysGlyph }
    ]
  },
  {
    group: "This machine",
    pages: [
      { key: "agents", label: "Agents", glyph: AgentGlyph },
      { key: "voice", label: "Voice", glyph: MicGlyph },
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
  layout: "Layout",
  notifications: "Notifications",
  agents: "Agents",
  voice: "Voice",
  machine: "Repositories",
  keyboard: "Keyboard",
  about: "About"
};

/** The keys that stay themselves: a range, the room's modal letters, and the
 *  platform's own Esc. Everything that is one ⌘ chord is rebindable and lives
 *  in the bindings registry instead (D-177's recorded revisit). */
const FIXED_KEYS: { keys: string; does: string }[] = [
  { keys: "⌘1 – ⌘9", does: "Open the selected project's missions" },
  { keys: "G then C", does: "Open the Changes section" },
  { keys: "G then V", does: "Open the Verification section" },
  { keys: "G then A", does: "Open All files" },
  { keys: "R", does: "Request control of the lane" },
  { keys: "Esc", does: "Close the open dialog, find bar, or look" }
];

function PencilGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9.7 3.6l2.7 2.7L5.9 12.8l-3.3.6.6-3.3zM11.6 1.7l2.7 2.7" />
    </svg>
  );
}

function TrashGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.8 4.4h10.4M6.2 4.4V2.9h3.6v1.5M4.2 4.4l.7 8.7h6.2l.7-8.7M6.6 7v3.7M9.4 7v3.7" />
    </svg>
  );
}

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

/** The update channel's standing as one sentence (D-250), never a badge. */
function updateWords(status: UpdateStatus): string {
  const at = status.checkedAt ? new Date(status.checkedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;
  switch (status.state) {
    case "off":
      return "A development build never checks.";
    case "idle":
      return "Not checked yet.";
    case "checking":
      return "Checking GitHub Releases…";
    case "up_to_date":
      return at ? `Up to date · checked ${at}` : "Up to date";
    case "available":
      return `${status.available ?? "A newer build"} is available · downloading`;
    case "downloading":
      return `Downloading ${status.available ?? "a newer build"}${status.progress !== null ? ` · ${status.progress}%` : ""}`;
    case "ready":
      return `${status.available ?? "A newer build"} is downloaded · restart to update`;
    case "failed":
      return `Could not update: ${status.error ?? "the channel did not answer"}`;
    default:
      return "";
  }
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
  // The person's arrangement (D-257), read on open and written as it changes.
  const [arrangement, setArrangement] = useState<Layout>(() => layout());
  // What the room noticed and adopted (D-258), for the Habits card.
  const habitsState = useHabits();
  const adoptedHabits = (Object.entries(habitsState.adopted) as [HabitKey, { value: import("../habits").HabitValue; told: boolean }][]).filter(([, entry]) => entry);
  const segment = <K extends keyof Layout>(key: K, choices: [Layout[K], string][]) => (
    <div className="settings-theme" role="group" aria-label={String(key)}>
      {choices.map(([value, label]) => (
        <button
          key={String(value)}
          className={arrangement[key] === value ? "segment-tab active" : "segment-tab"}
          aria-pressed={arrangement[key] === value}
          onClick={() => setArrangement(setLayout({ [key]: value } as Partial<Layout>))}
          data-testid={`layout-${key}-${String(value)}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
  const [query, setQuery] = useState("");
  const [preference, setPreference] = useState<ThemePreference>(() => themePreference());
  // This machine's custom themes (D-254), re-read after an import or a removal.
  const [themes, setThemes] = useState<CustomTheme[]>(() => listThemes());
  const [themeNote, setThemeNote] = useState<string | null>(null);
  const importTheme = async () => {
    setThemeNote(null);
    const picked = await novus().system.importTheme();
    if (!picked.ok) {
      setThemeNote(picked.message);
      return;
    }
    if (picked.value === null) return;
    const read = parseThemeFile(picked.value.text);
    if (!read.ok) {
      setThemeNote(read.reason);
      return;
    }
    const saved = saveTheme(read.theme);
    setThemes(listThemes());
    choose(`custom:${saved.id}`);
  };
  const exportTheme = async () => {
    setThemeNote(null);
    const current = preference.startsWith("custom:") ? themes.find((theme) => `custom:${theme.id}` === preference) ?? null : null;
    const base = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    const text = current ? themeFileOf(current) : currentThemeFile(document.documentElement, base === "light" ? "Light" : "Dark", base);
    const written = await novus().system.exportTheme({ name: current?.name ?? (base === "light" ? "Light" : "Dark"), text });
    if (!written.ok) setThemeNote(written.message);
    else if (written.value) setThemeNote(`Saved to ${written.value.path}`);
  };
  const [probe, setProbe] = useState<SetupProbeResponse | null>(null);
  const [repos, setRepos] = useState<
    { name: string; defaultBranch: string; onThisMachine: boolean }[] | null
  >(null);
  const [version, setVersion] = useState<{ app: string; electron: string } | null>(null);
  // The update channel and the diagnostics (D-250): read while About is open,
  // and re-read every two seconds so a check or a download is watched.
  const [updates, setUpdates] = useState<UpdateStatus | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [updateNote, setUpdateNote] = useState<string | null>(null);
  useEffect(() => {
    if (page !== "about") return;
    let alive = true;
    const read = () => {
      void novus().system.updates().then((result) => {
        if (alive) setUpdates(result.ok ? result.value : null);
      });
      void novus().system.diagnostics().then((result) => {
        if (alive) setDiagnostics(result.ok ? result.value : null);
      });
    };
    read();
    const timer = window.setInterval(read, 2_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [page]);
  const [notif, setNotif] = useState<{ turns: boolean; needsYou: boolean } | null>(null);
  const { data: connectors, setLent } = useConnectors();
  const [computerUse, setComputerUse] = useState<boolean | null>(null);
  // Voice (D-240, D-241): what this Mac holds for dictation — the engines it
  // found, the two permissions, and the person's own preferences.
  const [voice, setVoice] = useState<DictationSettings | null>(null);
  const [voiceProblem, setVoiceProblem] = useState<string | null>(null);
  const [dictionaryDraft, setDictionaryDraft] = useState<string | null>(null);
  const [accessibility, setAccessibility] = useState<boolean | null>(null);
  const [screenRec, setScreenRec] = useState<boolean | null>(null);
  const bindings = useKeybindings();
  /** The action whose next chord is being recorded, if any. */
  const [recording, setRecording] = useState<BindingAction | null>(null);
  const [keyProblem, setKeyProblem] = useState<string | null>(null);

  useEffect(() => {
    void novus().setup.probe().then((result) => setProbe(result.ok ? result.value : null));
    void novus().repos.localList().then((result) => setRepos(result.ok ? result.value : []));
    void novus().system.version().then((result) => setVersion(result.ok ? result.value : null));
    void novus().notifications.get().then((result) => setNotif(result.ok ? result.value : null));
    void novus().computerUse.enabled().then((result) => setComputerUse(result.ok ? result.value.enabled : false));
    void novus().dictation.settings().then((result) => setVoice(result.ok ? result.value : null));
    void novus().computerUse.accessibility().then((result) => setAccessibility(result.ok ? result.value.trusted : false));
    void novus().computerUse.screenRecording().then((result) => setScreenRec(result.ok ? result.value.granted : false));
  }, []);

  useEffect(() => {
    const opener = document.activeElement;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      // Back to the opener, quietly (D-106): Esc is a dismissal, not
      // keyboard navigation, and must not ring the control it lands on.
      focusQuietly(opener);
    };
  }, [onClose]);

  // While a chord is being recorded every keydown belongs to the recording:
  // captured before the shell's own handler, so pressing the chord being
  // replaced does not also fire it. Esc cancels; a chord the registry refuses
  // says why in words and keeps listening.
  useEffect(() => {
    if (recording === null) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") {
        setRecording(null);
        setKeyProblem(null);
        return;
      }
      const chord = chordFromEvent(event);
      if (chord === null) {
        if (!["Meta", "Control", "Shift", "Alt"].includes(event.key)) {
          setKeyProblem("Hold ⌘ — a global key without it would eat plain typing.");
        }
        return;
      }
      const refusal = chordRefusal(recording, chord, bindings);
      if (refusal !== null) {
        setKeyProblem(refusal);
        return;
      }
      setBinding(recording, chord);
      setRecording(null);
      setKeyProblem(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, bindings]);

  // A recording must not outlive the page it started on.
  useEffect(() => {
    setRecording(null);
    setKeyProblem(null);
  }, [page]);

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
      { page: "layout", title: "Terminal docks", description: "Bottom, right, or left" },
      { page: "layout", title: "Density", description: "Comfortable or compact rows" },
      { page: "layout", title: "Home", description: "The board, or a quiet canvas" },
      { page: "notifications", title: "Turn completions", description: "Tell me when a turn finishes while I am elsewhere" },
      { page: "notifications", title: "Needs you", description: "Tell me when the agent asks a question while I am elsewhere" },
      ...BINDING_ACTIONS.map(({ action, does }) => ({
        page: "keyboard" as Page,
        title: chordLabel(bindings[action]),
        description: does
      })),
      ...FIXED_KEYS.map((entry) => ({ page: "keyboard" as Page, title: entry.keys, description: entry.does })),
      { page: "agents", title: "Claude Code", description: probe?.claudeCode.installed ? `${probe.claudeCode.version ?? "installed"}${probe.claudeCode.account ? ` · ${probe.claudeCode.account}` : ""}` : "not found on this machine" },
      { page: "agents", title: "Codex", description: probe?.codex.installed ? `${probe.codex.version ?? "installed"}${probe.codex.account ? ` · ${probe.codex.account}` : ""}` : "not found on this machine" },
      { page: "agents", title: "OpenCode", description: probe?.opencode?.error ?? probe?.opencode?.account ?? "Hosted and local models on this machine" },
      { page: "agents", title: "Let agents control this Mac", description: computerUse ? "on — agents may operate your screen" : "off — the safe default" },
      { page: "voice", title: "Speech recognition", description: voice?.engines?.speech.onDevice ? "on this Mac, on-device" : "not ready on this Mac" },
      { page: "voice", title: "Editor", description: voice?.engines?.editor.kind === "claude" ? "Claude Code refines each take" : voice?.engines?.editor.kind === "codex" ? "Codex refines each take" : "no coding agent CLI installed" },
      { page: "voice", title: "Microphone", description: voice?.microphone ?? "" },
      { page: "voice", title: "Final pass", description: voice?.refine === false ? "off — the words stand as heard" : "on — each take is refined against your repository's names" },
      { page: "voice", title: "Dictionary", description: "Names the recognizer should spell as you do" },
      ...(connectors?.connectors ?? []).map((c) => ({
        page: "agents" as Page,
        title: c.name.replace(/^claude\.ai /, ""),
        description: c.lent ? "lent to this machine's turns" : "your own account — off"
      })),
      ...(repos ?? []).map((repo) => ({ page: "machine" as Page, title: repo.name, description: repo.onThisMachine ? repo.defaultBranch : "on another machine" })),
      { page: "about", title: "Novus", description: version?.app ?? "" },
      { page: "about", title: "Electron", description: version?.electron ?? "" }
    ];
    return rows;
  }, [user, probe, repos, version, bindings, connectors, computerUse, voice]);

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
        ) : page === "layout" ? (
          <>
            <h2 className="settings-page-title">Layout</h2>
            <Card heading="The room">
              <CardRow title="Terminal docks" description="Where the terminal opens in the room" trailing={segment("dock", [["bottom", "Bottom"], ["right", "Right"], ["left", "Left"]])} />
              <CardRow title="Evidence panel" description="Which edge the panel stands against" trailing={segment("panel", [["right", "Right"], ["left", "Left"]])} />
              <CardRow title="Home" description="With no mission open: the board, or a quiet canvas" trailing={segment("home", [["board", "Board"], ["quiet", "Quiet"]])} />
            </Card>
            <Card heading="The shell">
              <CardRow title="Density" description="Row height and spacing" trailing={segment("density", [["comfortable", "Comfortable"], ["compact", "Compact"]])} />
              <CardRow title="Motion" description="Reduced motion is always honoured when the system asks for it" trailing={segment("motion", [["full", "Full"], ["reduced", "Reduced"]])} />
            </Card>
            <Card heading="Habits">
              <CardRow
                title="Notice what I do"
                description="Which evidence section you open first, whether you open the panel after a turn, whether you open the terminal on a run — adopted when it wins five of the last seven times, said once, undone in one click"
                trailing={
                  <div className="settings-theme" role="group" aria-label="Notice what I do">
                    {([true, false] as const).map((value) => (
                      <button
                        key={String(value)}
                        className={habitsState.noticing === value ? "segment-tab active" : "segment-tab"}
                        aria-pressed={habitsState.noticing === value}
                        onClick={() => setNoticing(value)}
                        data-testid={`habits-${value ? "on" : "off"}`}
                      >
                        {value ? "On" : "Off"}
                      </button>
                    ))}
                  </div>
                }
              />
              {adoptedHabits.length === 0 ? (
                <CardRow title="Nothing adopted yet" description="The room says so here, and under the tab strip, when it adopts something" testid="habits-none" />
              ) : (
                adoptedHabits.map(([key, entry]) => (
                  <CardRow
                    key={key}
                    title={habitWords(key, entry.value)}
                    trailing={
                      <button className="btn btn-text" onClick={() => undoHabit(key)} data-testid={`habit-undo-${key}`}>
                        Undo
                      </button>
                    }
                    testid={`habit-adopted-${key}`}
                  />
                ))
              )}
              <CardRow
                title="Forget what you noticed"
                description="Every observation, adoption, and undo — the switch stays as it is"
                trailing={
                  <button className="btn btn-secondary" onClick={() => forgetHabits()} data-testid="habits-forget">
                    Forget
                  </button>
                }
              />
            </Card>
            <p className="settings-hint">Remembered on this Mac. The rail and the panel are resized by dragging their edges, and remembered the same way. The state line, the composer and the baton keep their places whatever else moves.</p>
          </>
        ) : page === "appearance" ? (
          <>
            <h2 className="settings-page-title">Appearance</h2>
            <Card heading="Theme">
              <CardRow title="Theme" description="Light, dark, or follow the system" trailing={themeSegment} />
              {themes.map((theme) => (
                <CardRow
                  key={theme.id}
                  title={theme.name}
                  description={`Custom · over ${theme.base}`}
                  trailing={
                    <span className="settings-key-controls">
                      <button
                        className={preference === `custom:${theme.id}` ? "chip-button active" : "chip-button"}
                        aria-pressed={preference === `custom:${theme.id}`}
                        onClick={() => choose(`custom:${theme.id}`)}
                        data-testid={`theme-use-${theme.id}`}
                      >
                        {preference === `custom:${theme.id}` ? "In use" : "Use"}
                      </button>
                      <button
                        className="chip-button"
                        onClick={() => {
                          removeTheme(theme.id);
                          setThemes(listThemes());
                          if (preference === `custom:${theme.id}`) choose("dark");
                        }}
                        data-testid={`theme-remove-${theme.id}`}
                      >
                        Remove
                      </button>
                    </span>
                  }
                />
              ))}
              <CardRow
                title="Theme files"
                description="A theme is one JSON file: a name, a base of dark or light, and the colour tokens it changes. Nothing else — spacing, type and motion stay Novus's own."
                trailing={
                  <span className="settings-key-controls">
                    <button className="chip-button" onClick={() => void importTheme()} data-testid="theme-import">
                      Import theme…
                    </button>
                    <button className="chip-button" onClick={() => void exportTheme()} data-testid="theme-export">
                      Export current…
                    </button>
                  </span>
                }
              />
            </Card>
            {themeNote !== null && (
              <p className="settings-hint" data-testid="theme-note">
                {themeNote}
              </p>
            )}
            <Card heading="Kit">
              {/* The primitives every surface is built from, in the theme in
                  use (D-254): the reference a person can come back to, live. */}
              <div className="kit" data-testid="settings-kit">
                <div className="kit-row">
                  <span className="kit-label">Buttons</span>
                  <button className="btn btn-primary">Primary</button>
                  <button className="btn btn-secondary">Secondary</button>
                  <button className="btn btn-text">Text</button>
                  <button className="btn btn-secondary" disabled>Disabled</button>
                </div>
                <div className="kit-row">
                  <span className="kit-label">Chips</span>
                  <button className="chip-button"><ClaudeGlyph className="chip-glyph" />Fable 5.1</button>
                  <button className="chip-button">Effort · high</button>
                  <button className="chip-button">Permissions · Ask every time</button>
                  <button className="chip-button active">In use</button>
                </div>
                <div className="kit-row">
                  <span className="kit-label">Segments</span>
                  <div className="settings-theme" role="group" aria-label="Sample">
                    <button className="segment-tab active">On</button>
                    <button className="segment-tab">Off</button>
                  </div>
                </div>
                <div className="kit-row">
                  <span className="kit-label">State line</span>
                  <span className="state-line kit-inline">
                    <span className="state-name">Agent running</span>
                    <span className="state-detail">— writing the fake turn file</span>
                  </span>
                </div>
                <div className="kit-row">
                  <span className="kit-label">Rail rows</span>
                  <span className="kit-rail">
                    <span className="side-row side-child kit-inline">
                      <span className="side-name">Ship the session guard</span>
                      <span className="side-approaches tone-warn side-needs">needs your approval</span>
                    </span>
                    <span className="side-row side-session kit-inline">
                      <span className="side-name">write the fake turn file</span>
                      <span className="side-needs side-state"> · working</span>
                    </span>
                    <span className="side-row side-session kit-inline">
                      <span className="side-name">add tests</span>
                      <span className="side-unread" title="Finished since you last looked" />
                    </span>
                  </span>
                </div>
                <div className="kit-row">
                  <span className="kit-label">Words</span>
                  <span className="tone-warn">needs you</span>
                  <span className="quiet">· queued · 2</span>
                  <span className="inline-error kit-inline" role="presentation">1 mission is still working — stop it first.</span>
                </div>
                <div className="kit-row">
                  <span className="kit-label">Diff</span>
                  <span className="change-counts mono">
                    <span className="count-add">+3</span> <span className="count-del">−1</span>
                  </span>
                  <span className="mono">a4b1429b</span>
                </div>
                <div className="kit-row">
                  <span className="kit-label">Field</span>
                  <input className="settings-input kit-input" defaultValue="Direct Claude Code…" readOnly />
                </div>
              </div>
            </Card>
            <p className="settings-hint">Every surface is built from these. A theme changes their colours and nothing else.</p>
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
              <CardRow title="OpenCode" description={probe?.opencode?.error ?? "Provider login stays in OpenCode on this machine"} trailing={agentTrailing(probe?.opencode)} />
            </Card>
            {connectors !== null && connectors.connectors.length > 0 && (
              <Card heading="Lend your accounts">
                <ConnectorRows connectors={connectors.connectors} onSetLent={setLent} />
              </Card>
            )}
            <Card heading="Raw computer use">
              <CardRow
                title="Let agents control this Mac"
                description="Off by default. When on, an agent can move the mouse and type anywhere on your screen — never on Novus itself, only when you approve it for a turn, and you can stop it. It cannot turn this on; only you can."
                trailing={
                  computerUse === null ? (
                    <span className="settings-card-value">…</span>
                  ) : (
                    <div className="settings-theme" role="group" aria-label="Let agents control this Mac">
                      {[true, false].map((value) => (
                        <button
                          key={String(value)}
                          className={computerUse === value ? "segment-tab active" : "segment-tab"}
                          aria-pressed={computerUse === value}
                          onClick={() => {
                            setComputerUse(value);
                            void novus().computerUse.setEnabled(value);
                          }}
                          data-testid={`computer-use-${value ? "on" : "off"}`}
                        >
                          {value ? "On" : "Off"}
                        </button>
                      ))}
                    </div>
                  )
                }
              />
              {computerUse === true && accessibility === false && (
                <CardRow
                  title="Accessibility permission"
                  description="macOS must let Novus control the mouse and keyboard. Grant it, then it takes effect — the agent still only acts when you approve it."
                  trailing={
                    <button
                      className="btn btn-secondary"
                      onClick={() => {
                        void novus().computerUse.requestAccessibility();
                        // The grant lands when the person flips the OS switch;
                        // re-read shortly after so the row clears itself.
                        window.setTimeout(() => {
                          void novus().computerUse.accessibility().then((result) => setAccessibility(result.ok ? result.value.trusted : false));
                        }, 1200);
                      }}
                      data-testid="computer-use-accessibility"
                    >
                      Grant access
                    </button>
                  }
                />
              )}
              {computerUse === true && accessibility === true && (
                <CardRow
                  title="Accessibility permission"
                  description="Granted — the agent can operate this Mac when you approve it."
                  trailing={<span className="settings-card-value">granted</span>}
                />
              )}
              {computerUse === true && screenRec === false && (
                <CardRow
                  title="Screen recording permission"
                  description="Needed only for the agent's screenshots (so it can see the screen) — separate from Accessibility. Grant it to Novus, then restart the app."
                  trailing={
                    <button
                      className="btn btn-secondary"
                      onClick={() => {
                        void novus().computerUse.openScreenRecording();
                        window.setTimeout(() => {
                          void novus().computerUse.screenRecording().then((result) => setScreenRec(result.ok ? result.value.granted : false));
                        }, 1500);
                      }}
                      data-testid="computer-use-screen-recording"
                    >
                      Open settings
                    </button>
                  }
                />
              )}
              {computerUse === true && screenRec === true && (
                <CardRow
                  title="Screen recording permission"
                  description="Granted — the agent can take screenshots to see the screen."
                  trailing={<span className="settings-card-value">granted</span>}
                />
              )}
            </Card>
            <p className="settings-hint">
              A lent account acts only on the turns this Mac runs, only when you approve, and only you
              can answer its questions. Claude Code's own connectors — nothing is stored here.
            </p>
          </>
        ) : page === "voice" ? (
          <>
            <h2 className="settings-page-title">Voice</h2>
            <Card heading="Dictation">
              <CardRow
                title="Speech recognition"
                description={
                  voice === null
                    ? "Reading…"
                    : !voice.engines
                      ? "This Mac could not be read."
                      : !voice.engines.speech.helper
                        ? "This build of Novus has no speech helper beside it, so it cannot listen."
                        : !voice.engines.speech.available
                          ? `Speech recognition is not available for ${voice.engines.speech.locale ?? "this language"} on this Mac.`
                          : !voice.engines.speech.onDevice
                            ? `The on-device model for ${voice.engines.speech.locale ?? "this language"} is not installed. Turn on Dictation for it under System Settings → Keyboard.`
                            : "Apple's recognizer, on this Mac and only on this Mac: audio never leaves it. Your repository's names and your dictionary guide it."
                }
                testid="voice-speech"
                trailing={
                  voice === null || !voice.engines ? (
                    <span className="settings-card-value">…</span>
                  ) : voice.engines.speech.helper && voice.engines.speech.available && voice.engines.speech.onDevice ? (
                    <span className="settings-card-value">on-device · {voice.engines.speech.locale ?? "system language"}</span>
                  ) : (
                    <span className="settings-card-value tone-warn">not ready</span>
                  )
                }
              />
              {voice?.engines && voice.engines.speech.authorization !== "authorized" && (
                <CardRow
                  title="Speech recognition permission"
                  description={
                    voice.engines.speech.authorization === "denied"
                      ? "macOS has refused Novus speech recognition. Allow it under Privacy & Security → Speech Recognition."
                      : voice.engines.speech.authorization === "restricted"
                        ? "This Mac restricts speech recognition."
                        : "macOS asks the first time you dictate; you can ask now."
                  }
                  testid="voice-speech-permission"
                  trailing={
                    voice.engines.speech.authorization === "restricted" ? (
                      <span className="settings-card-value tone-warn">restricted</span>
                    ) : (
                      <button
                        className="btn btn-secondary"
                        onClick={() => {
                          void novus().dictation.requestAccess({ kind: "speech" }).then((result) => {
                            if (result.ok) setVoice(result.value);
                            else setVoiceProblem(result.message);
                          });
                        }}
                        data-testid="voice-speech-ask"
                      >
                        {voice.engines.speech.authorization === "denied" ? "Open settings" : "Allow"}
                      </button>
                    )
                  }
                />
              )}
              <CardRow
                title="Editor"
                description={
                  voice === null || !voice.engines
                    ? ""
                    : voice.engines.editor.kind === "claude"
                      ? "Claude Code, on your own login, refines each take against your repository's names — the fast model, no tools, nothing kept."
                      : voice.engines.editor.kind === "codex"
                        ? "Codex, on your own login, refines each take against your repository's names — read-only, nothing kept."
                        : "Install Claude Code or Codex to refine takes; without one the words stand as heard."
                }
                testid="voice-editor"
                trailing={
                  voice === null || !voice.engines ? (
                    <span className="settings-card-value">…</span>
                  ) : voice.engines.editor.kind === "none" ? (
                    <span className="settings-card-value tone-warn">none installed</span>
                  ) : (
                    <span className="settings-card-value">
                      {voice.engines.editor.kind === "claude" ? "Claude Code" : "Codex"}
                      {voice.engines.editor.model ? ` · ${voice.engines.editor.model}` : ""}
                    </span>
                  )
                }
              />
              <CardRow
                title="Microphone"
                description={
                  voice === null
                    ? ""
                    : voice.microphone === "granted"
                      ? "macOS allows Novus to listen. The microphone is open only while you dictate."
                      : voice.microphone === "denied"
                        ? "macOS has not allowed Novus. Allow it under Privacy & Security → Microphone, then relaunch Novus."
                        : voice.microphone === "restricted"
                          ? "This Mac restricts the microphone, so Novus cannot listen."
                          : "macOS will ask the first time you dictate; you can ask now."
                }
                testid="voice-microphone"
                trailing={
                  voice === null ? (
                    <span className="settings-card-value">…</span>
                  ) : voice.microphone === "granted" ? (
                    <span className="settings-card-value">granted</span>
                  ) : voice.microphone === "restricted" ? (
                    <span className="settings-card-value tone-warn">restricted</span>
                  ) : (
                    <button
                      className="btn btn-secondary"
                      onClick={() => {
                        void novus().dictation.requestAccess({ kind: "microphone" }).then((result) => {
                          if (result.ok) setVoice(result.value);
                          else setVoiceProblem(result.message);
                        });
                      }}
                      data-testid="voice-microphone-ask"
                    >
                      {voice.microphone === "denied" ? "Open settings" : "Allow"}
                    </button>
                  )
                }
              />
              <CardRow
                title="Final pass"
                description="After you stop, the take is refined against your repository's names, your dictionary, and the words already in the box, and every edit is checked against what you said. Off keeps the words as heard."
                trailing={
                  voice === null ? (
                    <span className="settings-card-value">…</span>
                  ) : (
                    <div className="settings-theme" role="group" aria-label="Final pass">
                      {[true, false].map((value) => (
                        <button
                          key={String(value)}
                          className={voice.refine === value ? "segment-tab active" : "segment-tab"}
                          aria-pressed={voice.refine === value}
                          onClick={() => {
                            setVoice({ ...voice, refine: value });
                            void novus().dictation.setPrefs({ refine: value }).then((result) => {
                              if (result.ok) setVoice(result.value);
                            });
                          }}
                          data-testid={`voice-refine-${value ? "on" : "off"}`}
                        >
                          {value ? "On" : "Off"}
                        </button>
                      ))}
                    </div>
                  )
                }
              />
            </Card>
            {voiceProblem !== null && (
              <p className="inline-error" role="alert" data-testid="voice-problem">
                {voiceProblem}
              </p>
            )}
            <Card heading="Your words">
              <div className="settings-card-block">
                <span className="settings-card-title">Dictionary</span>
                <span className="settings-card-desc">
                  Names the recognizer should spell as you do — people, products, identifiers. One per line, up to two hundred.
                </span>
                <textarea
                  className="settings-dictionary"
                  value={dictionaryDraft ?? voice?.dictionary.join("\n") ?? ""}
                  onChange={(event) => setDictionaryDraft(event.target.value)}
                  onBlur={() => {
                    if (dictionaryDraft === null) return;
                    const words = dictionaryDraft
                      .split("\n")
                      .map((word) => word.trim())
                      .filter((word) => word.length > 0)
                      .slice(0, 200);
                    void novus().dictation.setPrefs({ dictionary: words }).then((result) => {
                      if (result.ok) {
                        setVoice(result.value);
                        setDictionaryDraft(null);
                      }
                    });
                  }}
                  spellCheck={false}
                  aria-label="Dictionary"
                  data-testid="voice-dictionary"
                />
              </div>
            </Card>
            <p className="settings-hint">
              Audio never leaves this Mac. The transcript and the names above go only where your coding agent already sends its work, on your own account. No key is stored anywhere.
            </p>
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
            <Card heading="Chords">
              {BINDING_ACTIONS.map(({ action, does }) => (
                <CardRow
                  key={action}
                  title={does}
                  testid={`key-${action}`}
                  trailing={
                    recording === action ? (
                      <span className="settings-key mono settings-key-recording" data-testid="key-recording">
                        Press the new keys… Esc cancels
                      </span>
                    ) : (
                      <span className="settings-key-controls">
                        <span className="settings-key mono">{chordLabel(bindings[action])}</span>
                        <button
                          className="icon-button settings-key-action"
                          aria-label={`Rebind “${does}”`}
                          title="Rebind"
                          onClick={() => {
                            setRecording(action);
                            setKeyProblem(null);
                          }}
                          data-testid={`rebind-${action}`}
                        >
                          <PencilGlyph />
                        </button>
                        {isOverridden(action) ? (
                          <button
                            className="icon-button settings-key-action"
                            aria-label={`Reset “${does}” to its default key`}
                            title="Reset to default"
                            onClick={() => resetBinding(action)}
                            data-testid={`reset-${action}`}
                          >
                            <TrashGlyph />
                          </button>
                        ) : (
                          /* Keeps every row's chip on one column whether or
                             not the trash has anything to undo. */
                          <span className="settings-key-action-space" aria-hidden="true" />
                        )}
                      </span>
                    )
                  }
                />
              ))}
            </Card>
            {keyProblem !== null && (
              <p className="inline-error" role="alert" data-testid="key-problem">
                {keyProblem}
              </p>
            )}
            <Card heading="Fixed keys">
              {FIXED_KEYS.map((entry) => (
                <CardRow
                  key={entry.keys}
                  title={entry.does}
                  trailing={<span className="settings-key mono">{entry.keys}</span>}
                />
              ))}
            </Card>
            <p className="settings-hint">
              A chord holds ⌘ and lives on this machine. The trash returns a key you changed to what Novus ships.
            </p>
          </>
        ) : (
          <>
            <h2 className="settings-page-title">About</h2>
            <Card heading="Build">
              <CardRow title="Novus" trailing={<span className="settings-card-value">{version?.app ?? "…"}</span>} />
              <CardRow title="Electron" trailing={<span className="settings-card-value">{version?.electron ?? "…"}</span>} />
            </Card>
            <Card heading="Updates">
              <CardRow
                title="Standing"
                description={updates === null ? "…" : updateWords(updates)}
                trailing={
                  updates !== null && updates.packaged ? (
                    <span className="settings-key-controls">
                      {updates.state === "ready" ? (
                        <button
                          className="chip-button"
                          onClick={() => {
                            void novus().system.installUpdate().then((result) => {
                              if (!result.ok) setUpdateNote(result.message);
                            });
                          }}
                          data-testid="settings-updates-install"
                        >
                          Restart to update
                        </button>
                      ) : (
                        <button
                          className="chip-button"
                          disabled={updates.state === "checking" || updates.state === "downloading"}
                          onClick={() => {
                            setUpdateNote(null);
                            void novus().system.checkForUpdates().then((result) => {
                              if (result.ok) setUpdates(result.value);
                              else setUpdateNote(result.message);
                            });
                          }}
                          data-testid="settings-updates-check"
                        >
                          Check now
                        </button>
                      )}
                    </span>
                  ) : undefined
                }
              />
              {updates !== null && updates.packaged && (
                <CardRow
                  title="Check automatically"
                  description="At launch, then every six hours while Novus is open. A build downloads in the background and installs only when you restart for it."
                  trailing={
                    <div className="settings-theme" role="group" aria-label="Check automatically">
                      {[true, false].map((value) => (
                        <button
                          key={String(value)}
                          className={updates.automatic === value ? "segment-tab active" : "segment-tab"}
                          aria-pressed={updates.automatic === value}
                          onClick={() => {
                            void novus().system.setUpdatePrefs({ automatic: value }).then((result) => {
                              if (result.ok) setUpdates(result.value);
                            });
                          }}
                          data-testid={`settings-updates-automatic-${value ? "on" : "off"}`}
                        >
                          {value ? "On" : "Off"}
                        </button>
                      ))}
                    </div>
                  }
                />
              )}
            </Card>
            {updateNote !== null && (
              <p className="settings-hint" data-testid="settings-updates-note">
                {updateNote}
              </p>
            )}
            <p className="settings-hint" data-testid="settings-updates-state">
              {updates === null
                ? "…"
                : updates.packaged
                  ? `Builds come from GitHub Releases of ${updates.channel.repository}. The check sends the version you run and nothing else leaves this Mac.`
                  : `Builds come from GitHub Releases of ${updates.channel.repository}; only a packaged Novus checks.`}
            </p>
            <Card heading="Diagnostics">
              <CardRow
                title="Crash reports"
                description={diagnostics === null ? "…" : diagnostics.crashReports === 0 ? "None on this Mac" : `${diagnostics.crashReports} on this Mac`}
                trailing={
                  <button className="chip-button" onClick={() => void novus().system.openCrashReports()} data-testid="settings-diagnostics-crashes">
                    Open folder
                  </button>
                }
              />
              <CardRow
                title="Log"
                description={diagnostics === null ? "…" : `${Math.max(1, Math.round(diagnostics.logBytes / 1024))} KB, the main process's own record`}
                trailing={
                  <button className="chip-button" onClick={() => void novus().system.openLogs()} data-testid="settings-diagnostics-log">
                    Open folder
                  </button>
                }
              />
            </Card>
            <p className="settings-hint">Kept on this Mac and never uploaded. Send them along when you report a problem.</p>
            <p className="settings-hint">
              The multiplayer control plane for coding agents. Missions, evidence, and decisions live in the room; the record is the product.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
