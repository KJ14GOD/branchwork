#!/usr/bin/env node
// A protocol double. Files and process groups are real; model output is not.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const root = __dirname;
if (process.argv.includes("--version")) { console.log("1.18.29-test"); process.exit(0); }
const mode = fs.readFileSync(path.join(root, "mode"), "utf8");
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
fs.writeFileSync(path.join(root, "launch.json"), JSON.stringify({
  args: process.argv.slice(2), config, configHome: process.env.XDG_CONFIG_HOME,
  disableProject: process.env.OPENCODE_DISABLE_PROJECT_CONFIG, pid: process.pid
}));
let events;
let answer;
const send = (type, properties) => events?.write(`data: ${JSON.stringify({ type, properties })}\n\n`);
const info = { id: "msg_test", role: "assistant", sessionID: "ses_test" };
const reply = (res, value, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
const complete = () => {
  const final = { ...info, finish: "stop", time: { created: 1, completed: 2 }, cost: 0.002, tokens: { input: 100, output: 20, cache: { read: 5, write: 0 } } };
  const part = { id: "prt_speech", sessionID: "ses_test", messageID: "msg_test", type: "text", text: "Finished.", time: { end: 2 } };
  send("message.part.updated", { part });
  send("message.updated", { info: final });
  reply(answer, { info: final, parts: [part] });
};
const server = http.createServer(async (req, res) => {
  const wanted = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`;
  if (req.headers.authorization !== wanted) return reply(res, {}, 401);
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  fs.appendFileSync(path.join(root, "requests.jsonl"), JSON.stringify({ method: req.method, path: req.url, body }) + "\n");
  if (req.url === "/config") return reply(res, mode === "managed-allow" ? { ...config, permission: "allow" } : mode === "managed-agent" ? { ...config, agent: { rogue: { permission: "allow" } } } : config);
  if (req.url === "/doc") {
    const paths = ["/event", "/provider", "/session", "/session/{sessionID}", "/session/{sessionID}/message", "/permission/{requestID}/reply"];
    if (mode === "unsupported") paths.pop();
    return reply(res, { paths: Object.fromEntries(paths.map((key) => [key, {}])) });
  }
  if (req.url === "/provider") return reply(res, { connected: ["local"], all: [{ id: "local", name: "Local fixture", models: { "tiny": { name: "Tiny", limit: { context: 10000 }, capabilities: { toolcall: true, input: { text: true } } } } }] });
  if (req.url === "/event") {
    events = res;
    res.writeHead(200, { "content-type": "text/event-stream" });
    send("server.connected", {});
    return;
  }
  if (req.url === "/session") return reply(res, { id: "ses_test", directory: process.cwd(), permission: body.permission });
  if (req.url?.endsWith("/children")) return reply(res, mode === "resumed-child" && req.url === "/session/ses_test/children" ? [{ id: "ses_child", parentID: "ses_test" }] : []);
  if (req.url === "/session/ses_child" && req.method === "PATCH") return reply(res, { id: "ses_child", permission: body.permission });
  if (req.url === "/session/ses_missing") return reply(res, {}, 404);
  if (req.url === "/session/ses_test") {
    if (mode === "patch-missing" && req.method === "PATCH") return reply(res, {}, 404);
    if (mode === "missing" && req.method === "GET") return reply(res, {}, 404);
    if (mode === "resume-failed" && req.method === "GET") return reply(res, {}, 500);
    return reply(res, { id: "ses_test", directory: process.cwd(), permission: req.method === "PATCH" ? [{ permission: "*", pattern: "*", action: "allow" }, ...body.permission] : body.permission });
  }
  if (req.url === "/session/ses_test/message") {
    answer = res;
    send("message.updated", { info });
    if (mode === "drop") { events.end(); return; }
    if (mode === "silent") return reply(res, { info, parts: [] });
    if (mode === "child") {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      fs.writeFileSync(path.join(root, "child-pid"), String(child.pid));
    }
    const tool = mode === "shell" ? "bash" : "edit";
    send("permission.asked", { id: "per_test", sessionID: mode === "resumed-child" ? "ses_child" : "ses_test", permission: tool, patterns: ["APPROVED.txt"], always: ["*"], metadata: { filepath: path.join(process.cwd(), "APPROVED.txt"), diff: "NOT DURABLE" }, tool: { callID: "call_test" } });
    return;
  }
  if (req.url === "/permission/per_test/reply") {
    if (mode === "reply-failed") return reply(res, {}, 500);
    if (body.reply === "always") throw new Error("Standing grants are forbidden");
    if (body.reply === "once") fs.writeFileSync(path.join(process.cwd(), "APPROVED.txt"), "approved\n");
    send("permission.replied", { sessionID: "ses_test", requestID: "per_test", reply: body.reply });
    reply(res, true);
    complete();
    return;
  }
  return reply(res, {}, 404);
});
server.listen(0, "127.0.0.1", () => console.log(`opencode server listening on http://127.0.0.1:${server.address().port}`));
