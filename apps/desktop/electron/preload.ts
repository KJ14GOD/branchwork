import { contextBridge, ipcRenderer } from "electron";
import type { IpcAuthStatus, NovusBridge, ProcessLogChunk, TerminalChunk } from "@novus/contracts";

/**
 * The complete renderer surface. No Node, no Electron internals, no session
 * credentials, no runner credentials, no filesystem paths — only these typed
 * calls cross the bridge. `NovusBridge` in the renderer and this object are
 * the same shape by construction: the type annotation below fails the build if
 * they drift.
 */
const novus: NovusBridge = {
  auth: {
    status: () => ipcRenderer.invoke("novus:auth:status"),
    start: () => ipcRenderer.invoke("novus:auth:start"),
    signOut: () => ipcRenderer.invoke("novus:auth:signout"),
    onChanged: (listener: (status: IpcAuthStatus) => void) => {
      const wrapped = (_event: unknown, status: IpcAuthStatus) => listener(status);
      ipcRenderer.on("novus:auth-changed", wrapped);
      return () => ipcRenderer.removeListener("novus:auth-changed", wrapped);
    }
  },
  setup: {
    probe: () => ipcRenderer.invoke("novus:setup:probe")
  },
  repos: {
    available: () => ipcRenderer.invoke("novus:repos:available"),
    base: (providerRepoId, ref) => ipcRenderer.invoke("novus:repos:base", { providerRepoId, ref }),
    addLocal: () => ipcRenderer.invoke("novus:repos:add-local"),
    localList: () => ipcRenderer.invoke("novus:repos:local-list"),
    baseLocal: (localId) => ipcRenderer.invoke("novus:repos:base-local", localId),
    checkedOutHere: () => ipcRenderer.invoke("novus:repos:checked-out-here")
  },
  missions: {
    list: (filter) => ipcRenderer.invoke("novus:missions:list", filter),
    create: (input) => ipcRenderer.invoke("novus:missions:create", input),
    get: (missionId, workstreamId) =>
      ipcRenderer.invoke(
        "novus:missions:get",
        workstreamId ? { missionId, workstreamId } : missionId
      ),
    retryBranch: (workstreamId) => ipcRenderer.invoke("novus:missions:retry-branch", workstreamId),
    direct: (input) => ipcRenderer.invoke("novus:missions:direct", input),
    resolveDirection: (input) => ipcRenderer.invoke("novus:missions:resolve-direction", input),
    cancelDirection: (directionId) => ipcRenderer.invoke("novus:missions:cancel-direction", directionId),
    stop: (missionId, workstreamId, sessionId) =>
      ipcRenderer.invoke(
        "novus:missions:stop",
        {
          missionId,
          ...(workstreamId ? { workstreamId } : {}),
          ...(sessionId ? { sessionId } : {})
        }
      ),
    archive: (missionId) => ipcRenderer.invoke("novus:missions:archive", missionId),
    restore: (missionId) => ipcRenderer.invoke("novus:missions:restore", missionId),
    respondApproval: (input) => ipcRenderer.invoke("novus:missions:respond-approval", input)
  },
  approaches: {
    create: (input) => ipcRenderer.invoke("novus:approaches:create", input),
    decide: (input) => ipcRenderer.invoke("novus:approaches:decide", input),
    requestRevision: (input) => ipcRenderer.invoke("novus:approaches:request-revision", input)
  },
  control: {
    request: (missionId) => ipcRenderer.invoke("novus:control:request", missionId),
    withdrawRequest: (missionId) => ipcRenderer.invoke("novus:control:withdraw-request", missionId),
    declineRequest: (requestId) => ipcRenderer.invoke("novus:control:decline-request", requestId),
    offer: (input) => ipcRenderer.invoke("novus:control:offer", input),
    withdrawOffer: (offerId) => ipcRenderer.invoke("novus:control:withdraw-offer", offerId),
    acceptOffer: (offerId) => ipcRenderer.invoke("novus:control:accept-offer", offerId),
    declineOffer: (offerId) => ipcRenderer.invoke("novus:control:decline-offer", offerId),
    revoke: (missionId) => ipcRenderer.invoke("novus:control:revoke", missionId)
  },
  invites: {
    create: (input) => ipcRenderer.invoke("novus:invites:create", input),
    list: (missionId) => ipcRenderer.invoke("novus:invites:list", missionId),
    revoke: (invitationId) => ipcRenderer.invoke("novus:invites:revoke", invitationId),
    redeem: (token) => ipcRenderer.invoke("novus:invites:redeem", token)
  },
  evidence: {
    fileDiff: (changeId) => ipcRenderer.invoke("novus:evidence:file-diff", changeId)
  },
  workspace: {
    inspect: (missionId, workstreamId) =>
      ipcRenderer.invoke("novus:workspace:inspect", workstreamId ? { missionId, workstreamId } : missionId),
    save: (input) => ipcRenderer.invoke("novus:workspace:save", input),
    prepareLocalFiles: (input) => ipcRenderer.invoke("novus:workspace:prepare-local-files", input),
    command: (input) => ipcRenderer.invoke("novus:workspace:command", input),
    stop: (input) => ipcRenderer.invoke("novus:workspace:stop", input),
    logs: (missionId, workstreamId) =>
      ipcRenderer.invoke("novus:workspace:logs", workstreamId ? { missionId, workstreamId } : missionId),
    onLog: (listener: (chunk: ProcessLogChunk) => void) => {
      const wrapped = (_event: unknown, chunk: ProcessLogChunk) => listener(chunk);
      ipcRenderer.on("novus:process-log", wrapped);
      return () => ipcRenderer.removeListener("novus:process-log", wrapped);
    },
    secrets: (missionId, workstreamId) =>
      ipcRenderer.invoke("novus:workspace:secrets", workstreamId ? { missionId, workstreamId } : missionId),
    supplySecret: (input) => ipcRenderer.invoke("novus:workspace:supply-secret", input),
    forgetSecret: (input) => ipcRenderer.invoke("novus:workspace:forget-secret", input),
    openPreview: (input) => ipcRenderer.invoke("novus:workspace:open-preview", input),
    listFiles: (input) => ipcRenderer.invoke("novus:workspace:list-files", input),
    readFile: (input) => ipcRenderer.invoke("novus:workspace:read-file", input),
    writeFile: (input) => ipcRenderer.invoke("novus:workspace:write-file", input)
  },
  // Local only, by construction: every verb here reaches this machine's own
  // main process and there is no shell verb in the runner protocol for any of
  // it to travel through (D-042).
  terminal: {
    list: (missionId, workstreamId) =>
      ipcRenderer.invoke("novus:terminal:list", workstreamId ? { missionId, workstreamId } : missionId),
    open: (input) => ipcRenderer.invoke("novus:terminal:open", input),
    scrollback: (sessionId) => ipcRenderer.invoke("novus:terminal:scrollback", sessionId),
    write: (input) => ipcRenderer.invoke("novus:terminal:write", input),
    resize: (input) => ipcRenderer.invoke("novus:terminal:resize", input),
    rename: (input) => ipcRenderer.invoke("novus:terminal:rename", input),
    close: (sessionId) => ipcRenderer.invoke("novus:terminal:close", sessionId),
    onOutput: (listener: (chunk: TerminalChunk) => void) => {
      const wrapped = (_event: unknown, chunk: TerminalChunk) => listener(chunk);
      ipcRenderer.on("novus:terminal-output", wrapped);
      return () => ipcRenderer.removeListener("novus:terminal-output", wrapped);
    }
  }
};

contextBridge.exposeInMainWorld("novus", novus);
