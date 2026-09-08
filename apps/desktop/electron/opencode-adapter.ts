import type { ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { OpenCodeModelIdSchema, type OpenCodeCatalogue, type RunnerEvent } from "@novus/contracts";
import type { HarnessAdapter, HarnessWire } from "./harness-adapter";
import type { HarnessControlMessage } from "./harness-stream";
import { OpenCodeServer, OpenCodeHttpError } from "./opencode-server";
import { OpenCodeStream } from "./opencode-stream";
import { object, openCodeMcp, OPEN_CODE_PERMISSION } from "./opencode-config";

export function openCodeModels(value: unknown): OpenCodeCatalogue["models"] {
  const response = object(value);
  const connected = new Set(Array.isArray(response.connected) ? response.connected : []);
  return (Array.isArray(response.all) ? response.all : []).flatMap((value) => {
    const provider = object(value);
    if (typeof provider.id !== "string" || provider.id.length > 100 || !connected.has(provider.id)) return [];
    return Object.entries(object(provider.models)).flatMap(([modelId, value]) => {
      const model = object(value);
      const id = OpenCodeModelIdSchema.safeParse(`opencode:${provider.id}/${modelId}`);
      // A chat needs tool calling. The picker must not offer an embedding or
      // an image generator as a coding agent.
      if (!id.success || object(model.capabilities).toolcall === false) return [];
      return [{ id: id.data, label: String(model.name || modelId).slice(0, 200),
        provider: provider.id as string, providerLabel: String(provider.name || provider.id).slice(0, 200) }];
    });
  }).slice(0, 10000);
}

/** Setup observes only this projection. Provider authentication objects and
 * model options never cross IPC or the control-plane boundary. */
export async function discoverOpenCode(cwd: string): Promise<OpenCodeCatalogue["models"]> {
  const server = new OpenCodeServer(cwd);
  try {
    await server.ready;
    await server.validateProtocol();
    return openCodeModels(await server.request("/provider"));
  } finally { server.stop(); await server.closed; }
}

export function createOpenCodeAdapter(options: {
  cwd: string;
  model: string;
  direction: string;
  resumeSessionId: string | null;
  mcpFile: string | null;
  attachments?: { mediaType: string; base64: string }[];
  sanitize: (text: string) => string;
  onControl: (message: HarnessControlMessage) => void;
  emit: (event: RunnerEvent) => void;
  wire: HarnessWire;
  setChild: (child: ChildProcess | null) => void;
  stopped: () => boolean;
}): HarnessAdapter {
  return { async run() {
    let server: OpenCodeServer | null = null;
    let stream = new OpenCodeStream({ resumeSessionId: options.resumeSessionId, sanitize: options.sanitize, onControl: options.onControl });
    let streamPump: Promise<void> | null = null;
    let finished = false;
    let transportFailure: Error | null = null;
    const emit = (events: RunnerEvent[]) => { for (const event of events) options.emit(event); };
    try {
      const parsed = OpenCodeModelIdSchema.parse(options.model);
      const native = parsed.slice("opencode:".length);
      const split = native.indexOf("/");
      const providerID = native.slice(0, split), modelID = native.slice(split + 1);
      server = new OpenCodeServer(options.cwd, openCodeMcp(options.mcpFile));
      const local = server;
      options.setChild(local.child);
      options.wire.steer = () => false;
      const send = (path: string, body?: unknown): boolean => {
        if (finished || options.stopped() && !path.endsWith("/abort")) return false;
        void local.request(path, body).catch((error: unknown) => {
          transportFailure = error instanceof Error ? error : new Error("OpenCode's control channel failed.");
          local.stop();
        });
        return true;
      };
      options.wire.decision = (id, allow, message) => {
        const sent = send(`/permission/${encodeURIComponent(id)}/reply`, {
          reply: allow ? "once" : "reject", ...(allow ? {} : { message })
        });
        if (sent) stream.answered(id);
        return sent;
      };
      options.wire.unsupported = (id, subtype) => {
        if (subtype === "question") return send(`/question/${encodeURIComponent(id)}/reject`, {});
        transportFailure = new Error("OpenCode requested an unsupported control operation.");
        local.stop();
        return false;
      };
      options.wire.interrupt = () => {
        // Process-tree termination also closes every outstanding HTTP call.
        // OpenCode persists the session incrementally for the next direction.
        local.stop();
        return false;
      };
      if (options.stopped()) local.stop();
      await local.ready;
      await local.validateProtocol();
      const catalogue = await local.request("/provider");
      if (!openCodeModels(catalogue).some((model) => model.id === parsed)) {
        throw new Error("This model is not available in this machine's OpenCode. Connect its provider with opencode auth login, or configure a local provider, then refresh the model menu.");
      }
      const providers = object(catalogue).all as unknown[];
      const provider = providers.map(object).find((p) => p.id === providerID)!;
      const model = object(object(provider.models)[modelID]);
      const context = object(model.limit).context;
      stream = new OpenCodeStream({ resumeSessionId: options.resumeSessionId, sanitize: options.sanitize, onControl: options.onControl,
        contextWindow: typeof context === "number" && context > 0 ? context : null });
      let session: Record<string, unknown> | null = null;
      if (options.resumeSessionId) {
        let existing: Record<string, unknown> | null = null;
        try {
          existing = object(await local.request(`/session/${encodeURIComponent(options.resumeSessionId)}`));
        } catch (error) {
          if (!(error instanceof OpenCodeHttpError && error.status === 404)) throw error;
          // Only a missing session can start fresh. Auth/network failures
          // cannot be relabelled as lost continuity.
        }
        if (existing) {
          if (typeof existing.directory !== "string" || realpathSync(existing.directory) !== realpathSync(options.cwd)) throw new Error("OpenCode's saved session belongs to another workspace.");
          session = object(await local.request(`/session/${encodeURIComponent(options.resumeSessionId)}`, { permission: OPEN_CODE_PERMISSION }, "PATCH"));
        }
      }
      session ??= object(await local.request("/session", { title: "Novus", permission: OPEN_CODE_PERMISSION }));
      if (typeof session.id !== "string" || !/^ses[a-zA-Z0-9_-]+$/.test(session.id)) throw new Error("OpenCode returned an invalid session identity.");
      // PATCH appends rules. OpenCode evaluates the last matching rule, so
      // this complete suffix supersedes every saved grant, including '*'.
      if (!Array.isArray(session.permission) || !isDeepStrictEqual(session.permission.slice(-OPEN_CODE_PERMISSION.length), OPEN_CODE_PERMISSION)) throw new Error("OpenCode did not accept Novus's pinned permission policy.");
      emit(stream.open(session.id));
      // A native task may resume a child from an earlier direction. No new
      // session.created event is emitted for it, but its approvals still
      // belong to this execution and must reach the same policy ladder.
      if (stream.resumed) {
        const queue = [session.id];
        const seen = new Set(queue);
        for (let index = 0; index < queue.length; index++) {
          const parent = queue[index]!;
          const children = await local.request(`/session/${encodeURIComponent(parent)}/children`);
          if (!Array.isArray(children)) throw new Error("OpenCode could not verify its resumed child sessions.");
          for (const value of children) {
            const child = object(value);
            if (typeof child.id !== "string" || child.parentID !== parent || seen.has(child.id)) continue;
            if (seen.size >= 1000) throw new Error("OpenCode exceeded the supervised child-session limit.");
            // Keep the native child's stricter denials, but replace any
            // saved allows before a task can resume it.
            const denies = (Array.isArray(child.permission) ? child.permission : []).map(object)
              .filter((rule) => rule.action === "deny" && typeof rule.permission === "string" && typeof rule.pattern === "string");
            const policy = [...OPEN_CODE_PERMISSION, ...denies];
            const pinned = object(await local.request(`/session/${encodeURIComponent(child.id)}`, { permission: policy }, "PATCH"));
            if (!Array.isArray(pinned.permission) || !isDeepStrictEqual(pinned.permission.slice(-policy.length), policy)) throw new Error("OpenCode did not accept a resumed child's permission policy.");
            seen.add(child.id);
            stream.registerChild(child.id, parent);
            queue.push(child.id);
          }
        }
      }
      const pump = await local.events((chunk) => emit(stream.push(chunk)));
      const failed = new Promise<never>((_resolve, reject) => {
        streamPump = pump().catch((error: unknown) => {
          if (finished) return;
          transportFailure = error instanceof Error ? error : new Error("OpenCode event stream failed.");
          reject(transportFailure);
          local.stop();
        });
        void local.closed.then(() => { if (!finished) reject(transportFailure ?? new Error("OpenCode's server exited during the turn.")); });
      });
      const capabilities = object(object(model.capabilities).input);
      for (const attachment of options.attachments ?? []) {
        const kind = attachment.mediaType.startsWith("image/") ? "image" : "pdf";
        if (capabilities[kind] !== true) throw new Error("This OpenCode model cannot read the supplied attachment type. Choose a model that supports it.");
      }
      const answer = await Promise.race([failed, local.request(`/session/${session.id}/message`, {
        model: { providerID, modelID }, agent: "novus",
        parts: [{ type: "text", text: options.direction }, ...(options.attachments ?? []).map((attachment) => ({
          type: "file", mime: attachment.mediaType, url: `data:${attachment.mediaType};base64,${attachment.base64}`
        }))]
      }, "POST", true)]);
      emit(stream.finish(answer));
      return { stream, outcome: { code: 0, signal: null, stderr: "", spawnError: null } };
    } catch (error) {
      const reason = transportFailure ?? error;
      return { stream, outcome: { code: 1, signal: null, stderr: options.sanitize(reason instanceof Error ? reason.message : "OpenCode adapter failed."), spawnError: null } };
    } finally {
      finished = true;
      server?.stop();
      if (server) await server.closed;
      if (streamPump) await streamPump;
      options.setChild(null);
    }
  } };
}
