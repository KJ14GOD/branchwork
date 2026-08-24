import { afterEach, describe, expect, it } from "vitest";
import {
  CAPTURE_TOOL_FULL_NAME,
  CAPTURE_TOOL_NAME,
  DECLARE_RUN_TOOL_FULL_NAME,
  DECLARE_RUN_TOOL_NAME,
  PUSH_TOOL_FULL_NAME,
  PUSH_TOOL_NAME,
  grantBrowserSession,
  revokeBrowserSession,
  grantComputerSession,
  revokeComputerSession,
  mintToolGrant,
  registerCaptureTurn,
  resetCaptureEndpoint,
  type BrowserTool,
  type ComputerTool
} from "../electron/artifact-mcp";

/**
 * The `novus` capture endpoint (D-123), asked the way the real CLI asks —
 * over HTTP with the config's own bearer token — and the way an attacker
 * would: without the token, and without the routed approval's grant. The
 * rule under test is the two-key lock: the token names a live turn and
 * grants nothing; only an allow minted at the router lets one capture
 * happen, once.
 */

afterEach(() => {
  resetCaptureEndpoint();
});

const declareStub = async () => ({ text: "declared", isError: false });

async function rpc(
  url: string,
  token: string | null,
  method: string,
  params: unknown = {}
): Promise<{ status: number; body: { result?: { content?: { type?: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean; tools?: { name: string }[] }; error?: unknown } }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` })
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as never };
}

describe("the capture endpoint (D-123)", () => {
  it("answers the MCP handshake and lists all three tools, honestly described", async () => {
    const turn = await registerCaptureTurn("exe_alpha", async () => ({ text: "ok", isError: false }), async () => ({ text: "pushed", isError: false }), declareStub);
    const init = await rpc(turn.url, turn.token, "initialize", { protocolVersion: "2025-06-18" });
    expect(init.status).toBe(200);
    const listed = await rpc(turn.url, turn.token, "tools/list");
    expect(listed.body.result?.tools?.map((tool) => tool.name)).toEqual([
      "capture_screenshot",
      "push_branch",
      "declare_run_command",
      "browser_navigate",
      "browser_click",
      "browser_type",
      "browser_press",
      "browser_read",
      "computer_screenshot",
      "computer_move",
      "computer_click",
      "computer_type",
      "computer_key",
      "computer_scroll"
    ]);
    turn.release();
  });

  it("refuses a missing or wrong token, and a released turn's token", async () => {
    const turn = await registerCaptureTurn("exe_alpha", async () => ({ text: "ok", isError: false }), async () => ({ text: "pushed", isError: false }), declareStub);
    expect((await rpc(turn.url, null, "tools/list")).status).toBe(401);
    expect((await rpc(turn.url, "not-the-token", "tools/list")).status).toBe(401);
    turn.release();
    expect((await rpc(turn.url, turn.token, "tools/list")).status).toBe(401);
  });

  it("refuses a tool call without a standing grant — the token alone captures nothing", async () => {
    let captures = 0;
    const turn = await registerCaptureTurn(
      "exe_alpha",
      async () => {
        captures += 1;
        return { text: "captured", isError: false };
      },
      async () => ({ text: "pushed", isError: false }),
      declareStub
    );
    const called = await rpc(turn.url, turn.token, "tools/call", {
      name: "capture_screenshot",
      arguments: {}
    });
    expect(called.body.result?.isError).toBe(true);
    expect(called.body.result?.content?.[0]?.text).toContain("no approval stands");
    expect(captures).toBe(0);
    turn.release();
  });

  it("spends a grant exactly once: the allow captures, the replay is refused", async () => {
    let captures = 0;
    const turn = await registerCaptureTurn(
      "exe_alpha",
      async () => {
        captures += 1;
        return { text: "captured as art_x", isError: false };
      },
      async () => ({ text: "pushed", isError: false }),
      declareStub
    );
    mintToolGrant("exe_alpha", CAPTURE_TOOL_NAME);
    const first = await rpc(turn.url, turn.token, "tools/call", {
      name: "capture_screenshot",
      arguments: {}
    });
    expect(first.body.result?.isError).toBe(false);
    expect(first.body.result?.content?.[0]?.text).toContain("captured");
    const replay = await rpc(turn.url, turn.token, "tools/call", {
      name: "capture_screenshot",
      arguments: {}
    });
    expect(replay.body.result?.isError).toBe(true);
    expect(captures).toBe(1);
    turn.release();
  });

  it("never lets one turn's grant serve another turn's token", async () => {
    let alphaCaptures = 0;
    const alpha = await registerCaptureTurn(
      "exe_alpha",
      async () => {
        alphaCaptures += 1;
        return { text: "alpha", isError: false };
      },
      async () => ({ text: "pushed", isError: false }),
      declareStub
    );
    const beta = await registerCaptureTurn("exe_beta", async () => ({ text: "beta", isError: false }), async () => ({ text: "pushed", isError: false }), declareStub);
    mintToolGrant("exe_alpha", CAPTURE_TOOL_NAME);
    // Beta's token finds beta's turn, which has no grant.
    const crossed = await rpc(beta.url, beta.token, "tools/call", {
      name: "capture_screenshot",
      arguments: {}
    });
    expect(crossed.body.result?.isError).toBe(true);
    expect(alphaCaptures).toBe(0);
    alpha.release();
    beta.release();
  });

  it("reports a capture failure as the tool's own error, in the handler's words", async () => {
    const turn = await registerCaptureTurn(
      "exe_alpha",
      async () => ({ text: "Capture refused: No preview is open.", isError: true }),
      async () => ({ text: "pushed", isError: false }),
      declareStub
    );
    mintToolGrant("exe_alpha", CAPTURE_TOOL_NAME);
    const called = await rpc(turn.url, turn.token, "tools/call", {
      name: "capture_screenshot",
      arguments: {}
    });
    expect(called.body.result?.isError).toBe(true);
    expect(called.body.result?.content?.[0]?.text).toContain("No preview is open");
    turn.release();
  });

  it("exports the router's own names for the tools, so the grant hook and the config cannot drift", () => {
    expect(CAPTURE_TOOL_FULL_NAME).toBe("mcp__novus__capture_screenshot");
    expect(PUSH_TOOL_FULL_NAME).toBe("mcp__novus__push_branch");
    expect(DECLARE_RUN_TOOL_FULL_NAME).toBe("mcp__novus__declare_run_command");
  });

  it("keeps the two tools' grants apart: a capture allow pushes nothing (D-140)", async () => {
    let pushes = 0;
    const turn = await registerCaptureTurn(
      "exe_alpha",
      async () => ({ text: "captured", isError: false }),
      async () => {
        pushes += 1;
        return { text: "pushed", isError: false };
      },
      declareStub
    );
    mintToolGrant("exe_alpha", CAPTURE_TOOL_NAME);
    const crossed = await rpc(turn.url, turn.token, "tools/call", {
      name: "push_branch",
      arguments: {}
    });
    expect(crossed.body.result?.isError).toBe(true);
    expect(crossed.body.result?.content?.[0]?.text).toContain("no approval stands");
    expect(pushes).toBe(0);
    turn.release();
  });

  it("spends a push grant exactly once through the same two-key lock (D-140)", async () => {
    let pushes = 0;
    const turn = await registerCaptureTurn(
      "exe_alpha",
      async () => ({ text: "captured", isError: false }),
      async () => {
        pushes += 1;
        return { text: "Pushed novus/m-x at abcd1234.", isError: false };
      },
      declareStub
    );
    mintToolGrant("exe_alpha", PUSH_TOOL_NAME);
    const first = await rpc(turn.url, turn.token, "tools/call", { name: "push_branch", arguments: {} });
    expect(first.body.result?.isError).toBe(false);
    expect(first.body.result?.content?.[0]?.text).toContain("Pushed");
    const replay = await rpc(turn.url, turn.token, "tools/call", { name: "push_branch", arguments: {} });
    expect(replay.body.result?.isError).toBe(true);
    expect(pushes).toBe(1);
    turn.release();
  });

  it("keeps the declare grant apart and hands the tool its arguments (D-156)", async () => {
    const seen: unknown[] = [];
    const turn = await registerCaptureTurn(
      "exe_alpha",
      async () => ({ text: "captured", isError: false }),
      async () => ({ text: "pushed", isError: false }),
      async (input) => {
        seen.push(input);
        return { text: 'Declared run command "serve" in .novus/settings.toml.', isError: false };
      }
    );
    // A capture allow declares nothing.
    mintToolGrant("exe_alpha", CAPTURE_TOOL_NAME);
    const crossed = await rpc(turn.url, turn.token, "tools/call", {
      name: "declare_run_command",
      arguments: { name: "serve", command: "python3 -m http.server" }
    });
    expect(crossed.body.result?.isError).toBe(true);
    expect(seen).toHaveLength(0);
    // Its own allow does, once, with the arguments intact.
    mintToolGrant("exe_alpha", DECLARE_RUN_TOOL_NAME);
    const declared = await rpc(turn.url, turn.token, "tools/call", {
      name: "declare_run_command",
      arguments: { name: "serve", command: "python3 -m http.server 8123 --bind 127.0.0.1", port: 8123 }
    });
    expect(declared.body.result?.isError).toBe(false);
    expect(declared.body.result?.content?.[0]?.text).toContain("Declared run command");
    expect(seen).toEqual([
      { name: "serve", command: "python3 -m http.server 8123 --bind 127.0.0.1", port: 8123 }
    ]);
    const replay = await rpc(turn.url, turn.token, "tools/call", {
      name: "declare_run_command",
      arguments: { name: "serve", command: "x" }
    });
    expect(replay.body.result?.isError).toBe(true);
    expect(seen).toHaveLength(1);
    turn.release();
  });
});


describe("the fenced browser's turn session (D-218)", () => {
  it("refuses a browser action with no session, drives once granted, refuses again once revoked", async () => {
    const drives: string[] = [];
    const browser = async (tool: BrowserTool) => {
      drives.push(tool);
      return { text: `did ${tool}`, isError: false };
    };
    const turn = await registerCaptureTurn(
      "exe_browse",
      async () => ({ text: "shot", isError: false }),
      async () => ({ text: "pushed", isError: false }),
      declareStub,
      browser
    );

    // No session: refused, and the driver was never touched.
    const before = await rpc(turn.url, turn.token, "tools/call", { name: "browser_click", arguments: { x: 1, y: 2 } });
    expect(before.body.result?.isError).toBe(true);
    expect(drives).toEqual([]);

    // Granted (as the router does on a person's first allow): it drives, and
    // a second action rides the same session — one approval, many actions.
    grantBrowserSession("exe_browse");
    const clicked = await rpc(turn.url, turn.token, "tools/call", { name: "browser_click", arguments: { x: 1, y: 2 } });
    expect(clicked.body.result?.isError).toBe(false);
    const typed = await rpc(turn.url, turn.token, "tools/call", { name: "browser_type", arguments: { text: "hi" } });
    expect(typed.body.result?.isError).toBe(false);
    expect(drives).toEqual(["browser_click", "browser_type"]);

    // Revoked (a person's mid-turn cut-off): refused again, sticky.
    revokeBrowserSession("exe_browse");
    const after = await rpc(turn.url, turn.token, "tools/call", { name: "browser_click", arguments: { x: 3, y: 4 } });
    expect(after.body.result?.isError).toBe(true);
    // A re-grant cannot undo a cut-off within the turn.
    grantBrowserSession("exe_browse");
    const stillOff = await rpc(turn.url, turn.token, "tools/call", { name: "browser_click", arguments: { x: 5, y: 6 } });
    expect(stillOff.body.result?.isError).toBe(true);
    expect(drives).toEqual(["browser_click", "browser_type"]);

    turn.release();
  });
});


describe("raw computer use's turn session (D-218)", () => {
  it("shares the browser's session shape but is a separate grant — one never opens the other", async () => {
    const browserCalls: string[] = [];
    const computerCalls: string[] = [];
    const turn = await registerCaptureTurn(
      "exe_mac",
      async () => ({ text: "shot", isError: false }),
      async () => ({ text: "pushed", isError: false }),
      declareStub,
      async (tool: BrowserTool) => {
        browserCalls.push(tool);
        return { text: "browsed", isError: false };
      },
      async (tool: ComputerTool) => {
        computerCalls.push(tool);
        return { text: `did ${tool}`, isError: false };
      }
    );

    // No computer session: refused, driver untouched.
    const before = await rpc(turn.url, turn.token, "tools/call", { name: "computer_click", arguments: { x: 1, y: 2 } });
    expect(before.body.result?.isError).toBe(true);
    expect(computerCalls).toEqual([]);

    // A BROWSER grant does not open the Mac — separate sessions.
    grantBrowserSession("exe_mac");
    const stillOff = await rpc(turn.url, turn.token, "tools/call", { name: "computer_click", arguments: { x: 1, y: 2 } });
    expect(stillOff.body.result?.isError).toBe(true);
    expect(computerCalls).toEqual([]);

    // The computer grant drives, and covers several acts on one approval.
    grantComputerSession("exe_mac");
    expect((await rpc(turn.url, turn.token, "tools/call", { name: "computer_screenshot", arguments: {} })).body.result?.isError).toBe(false);
    expect((await rpc(turn.url, turn.token, "tools/call", { name: "computer_click", arguments: { x: 1, y: 2 } })).body.result?.isError).toBe(false);
    expect(computerCalls).toEqual(["computer_screenshot", "computer_click"]);

    // A cut-off is sticky for the turn, and cannot be re-opened.
    revokeComputerSession("exe_mac");
    expect((await rpc(turn.url, turn.token, "tools/call", { name: "computer_click", arguments: { x: 3, y: 4 } })).body.result?.isError).toBe(true);
    grantComputerSession("exe_mac");
    expect((await rpc(turn.url, turn.token, "tools/call", { name: "computer_click", arguments: { x: 5, y: 6 } })).body.result?.isError).toBe(true);
    expect(computerCalls).toEqual(["computer_screenshot", "computer_click"]);

    turn.release();
  });

  it("hands a screenshot's pixels to the agent as an image block, so it is not blind", async () => {
    const turn = await registerCaptureTurn(
      "exe_eyes",
      async () => ({ text: "shot", isError: false }),
      async () => ({ text: "pushed", isError: false }),
      declareStub,
      undefined,
      async (tool: ComputerTool) =>
        tool === "computer_screenshot"
          ? { text: "Screenshot of the 1440x900 screen.", isError: false, image: "QUJD" }
          : { text: `did ${tool}`, isError: false }
    );
    grantComputerSession("exe_eyes");

    const shot = await rpc(turn.url, turn.token, "tools/call", { name: "computer_screenshot", arguments: {} });
    expect(shot.body.result?.isError).toBe(false);
    const blocks = shot.body.result?.content ?? [];
    // Image first, so a model reading the first block sees the screen; the
    // sentence rides second. Without this the agent got only the words and
    // clicked blind (D-218 amended).
    expect(blocks[0]?.type).toBe("image");
    expect(blocks[0]?.data).toBe("QUJD");
    expect(blocks[0]?.mimeType).toBe("image/png");
    expect(blocks[1]?.type).toBe("text");

    // A non-screenshot action carries no image — only its word.
    const click = await rpc(turn.url, turn.token, "tools/call", { name: "computer_click", arguments: { x: 1, y: 2 } });
    expect((click.body.result?.content ?? []).some((b) => b.type === "image")).toBe(false);

    turn.release();
  });
});
