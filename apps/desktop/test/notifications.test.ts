import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNotifier, loadNotificationPrefs } from "../electron/notifications";

/**
 * The notifier's whole promise is its gating (D-180): silent while the
 * window is focused, silent when its switch is off, and a click goes back
 * to the mission that asked. The OS notification itself is injected.
 */

function harness(overrides?: { focused?: boolean }) {
  const shown: { title: string; body: string; onClick: () => void }[] = [];
  const opened: string[] = [];
  const notifier = createNotifier({
    userDataPath: mkdtempSync(join(tmpdir(), "novus-notif-")),
    isFocused: () => overrides?.focused ?? false,
    show: (title, body, onClick) => shown.push({ title, body, onClick }),
    open: (missionId) => opened.push(missionId),
    missionWords: (missionId) =>
      missionId === "msn_lost" ? Promise.reject(new Error("gone")) : Promise.resolve("ship the thing")
  });
  return { notifier, shown, opened };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the notifier", () => {
  it("speaks with the mission's own words, and its click goes back", async () => {
    const { notifier, shown, opened } = harness();
    notifier.notify({ kind: "turn_completed", missionId: "msn_1" });
    await settle();
    expect(shown).toHaveLength(1);
    expect(shown[0].title).toBe("Turn completed");
    expect(shown[0].body).toBe("ship the thing");
    shown[0].onClick();
    expect(opened).toEqual(["msn_1"]);
  });

  it("stays silent while the window is focused — a watcher needs no echo", async () => {
    const { notifier, shown } = harness({ focused: true });
    notifier.notify({ kind: "needs_you", missionId: "msn_1" });
    await settle();
    expect(shown).toHaveLength(0);
  });

  it("each moment has its own switch, and off means silent", async () => {
    const { notifier, shown } = harness();
    notifier.setPrefs({ turns: false, needsYou: true });
    notifier.notify({ kind: "turn_completed", missionId: "msn_1" });
    notifier.notify({ kind: "turn_failed", missionId: "msn_1" });
    notifier.notify({ kind: "needs_you", missionId: "msn_2" });
    await settle();
    expect(shown).toHaveLength(1);
    expect(shown[0].title).toBe("Claude Code needs you");
  });

  it("a mission whose words cannot be fetched still notifies, plainly", async () => {
    const { notifier, shown } = harness();
    notifier.notify({ kind: "turn_failed", missionId: "msn_lost" });
    await settle();
    expect(shown).toHaveLength(1);
    expect(shown[0].title).toBe("Turn failed");
    expect(shown[0].body).toBe("");
  });

  it("preferences persist machine-locally and survive a reload", () => {
    const dir = mkdtempSync(join(tmpdir(), "novus-notif-prefs-"));
    const notifier = createNotifier({
      userDataPath: dir,
      isFocused: () => true,
      show: () => undefined,
      open: () => undefined,
      missionWords: () => Promise.resolve(null)
    });
    notifier.setPrefs({ turns: false, needsYou: true });
    expect(loadNotificationPrefs(dir)).toEqual({ turns: false, needsYou: true });
  });
});
