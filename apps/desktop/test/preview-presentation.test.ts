import { describe, expect, it } from "vitest";
import {
  PreviewStatusSchema,
  WorkspaceProcessSchema,
  type PreviewStatus,
  type WorkspaceProcess
} from "@novus/contracts";
import { previewPresentation, processWord } from "../src/components/preview";

/**
 * What the preview surface says (D-098), pinned pure. Every fixture is parsed
 * through the contract schema, so a shape this suite invents cannot drift
 * from the wire. The rule under test is the honesty split: the process owns
 * the head's word in the runtime vocabulary (D-045), the page owns the panel,
 * and a page that loaded never promotes the process's word — readiness is
 * declared, not inferred from a render.
 */

function status(overrides: Partial<PreviewStatus> = {}): PreviewStatus {
  return PreviewStatusSchema.parse({
    workstreamId: "wst_lane",
    url: "http://localhost:4173/",
    origin: "http://localhost:4173",
    processId: "prc_app000000000",
    processName: "dev",
    phase: "ready",
    detail: null,
    ...overrides
  });
}

function process(overrides: Partial<WorkspaceProcess> = {}): WorkspaceProcess {
  return WorkspaceProcessSchema.parse({
    processId: "prc_app000000000",
    workstreamId: "wst_lane",
    kind: "run",
    name: "dev",
    command: "node server.js",
    state: "running",
    readiness: "ready",
    ending: null,
    startedByLogin: "kartik",
    previewUrl: "http://localhost:4173/",
    port: 4173,
    exitCode: null,
    failureReason: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    ...overrides
  });
}

describe("the head's state word is the process's own", () => {
  it("uses the runtime vocabulary, not a new one", () => {
    expect(processWord(process({ state: "starting", readiness: "pending" }))).toBe("starting");
    expect(processWord(process())).toBe("running");
    expect(processWord(process({ readiness: "unreachable" }))).toBe("running, not answering");
    expect(processWord(process({ state: "exited", exitCode: 0 }))).toBe("exited 0");
    expect(processWord(process({ state: "failed", exitCode: 1 }))).toBe("exited 1");
    expect(processWord(process({ state: "stopped", ending: "cancelled" }))).toBe("stopped");
    expect(processWord(null)).toBe("stopped");
  });

  it("a loaded page does not promote a starting process — readiness is declared, not inferred", () => {
    const view = previewPresentation(
      status({ phase: "ready" }),
      process({ state: "starting", readiness: "pending" })
    );
    expect(view.word).toBe("starting");
    expect(view.panel).toBeNull();
  });
});

describe("the panel is the page's own state, with only the correct next action", () => {
  it("shows no panel while the page is on screen", () => {
    expect(previewPresentation(status({ phase: "loading" }), process()).panel).toBeNull();
    expect(previewPresentation(status({ phase: "ready" }), process()).panel).toBeNull();
  });

  it("a page that did not answer offers a reload — unless the app is still starting, where waiting is the action", () => {
    const failed = previewPresentation(
      status({ phase: "unreachable", detail: "ERR_CONNECTION_REFUSED" }),
      process()
    );
    expect(failed.panel?.title).toBe("The page did not answer.");
    expect(failed.panel?.detail).toBe("ERR_CONNECTION_REFUSED");
    expect(failed.panel?.action).toBe("reload");

    const starting = previewPresentation(
      status({ phase: "unreachable", detail: "ERR_CONNECTION_REFUSED" }),
      process({ state: "starting", readiness: "pending" })
    );
    expect(starting.panel?.action).toBeNull();
  });

  it("a crashed page offers a reload with the reason", () => {
    const view = previewPresentation(
      status({ phase: "crashed", detail: "The preview's own page process ended (oom)." }),
      process()
    );
    expect(view.panel?.action).toBe("reload");
    expect(view.panel?.detail).toContain("oom");
  });

  it("a stopped app says so in the process's words and offers running it again", () => {
    const view = previewPresentation(status({ phase: "stopped", detail: "The app was stopped." }), null);
    expect(view.word).toBe("stopped");
    expect(view.panel?.title).toBe("The app was stopped.");
    expect(view.panel?.action).toBe("run_again");
  });

  it("a stopped preview beside a live process reporting an address offers reopening, not rerunning", () => {
    const view = previewPresentation(
      status({ phase: "stopped", detail: "The app exited with code 0." }),
      process({ processId: "prc_fresh00000000" })
    );
    expect(view.panel?.action).toBe("reopen");
  });

  it("a refused open shows the refusal with the honest way forward", () => {
    const refused = previewPresentation(null, null, "Nothing running in this workspace reports that address.");
    expect(refused.panel?.title).toBe("This preview could not open.");
    expect(refused.panel?.action).toBe("run_again");

    const reopenable = previewPresentation(null, process(), "Something transient.");
    expect(reopenable.panel?.action).toBe("reopen");
  });
});
