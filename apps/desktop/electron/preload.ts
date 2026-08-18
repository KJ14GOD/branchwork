import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  IpcAuthStatus,
  MissionChange,
  NovusBridge,
  ProcessLogChunk,
  TerminalChunk
} from "@novus/contracts";

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
  people: {
    avatar: (login) => ipcRenderer.invoke("novus:people:avatar", login)
  },
  repos: {
    available: () => ipcRenderer.invoke("novus:repos:available"),
    base: (providerRepoId, ref) => ipcRenderer.invoke("novus:repos:base", { providerRepoId, ref }),
    addLocal: () => ipcRenderer.invoke("novus:repos:add-local"),
    localList: () => ipcRenderer.invoke("novus:repos:local-list"),
    baseLocal: (localId, ref) =>
      ipcRenderer.invoke("novus:repos:base-local", ref === undefined ? localId : { localId, ref }),
    branches: (input) => ipcRenderer.invoke("novus:repos:branches", input),
    baseStatusLocal: (input) => ipcRenderer.invoke("novus:repos:base-status-local", input),
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
    // The room's live connection (D-149). The stream itself is the main
    // process's — it carries the session credential, which never crosses this
    // bridge — so the renderer asks for a mission to be watched and is told
    // when it moves.
    watch: (missionId) => ipcRenderer.invoke("novus:missions:watch", missionId),
    unwatch: () => ipcRenderer.invoke("novus:missions:unwatch"),
    onChanged: (listener: (change: MissionChange) => void) => {
      const wrapped = (_event: unknown, change: MissionChange) => listener(change);
      ipcRenderer.on("novus:mission-changed", wrapped);
      return () => ipcRenderer.removeListener("novus:mission-changed", wrapped);
    },
    pickImage: () => ipcRenderer.invoke("novus:missions:pick-image"),
    attachImage: (input) => ipcRenderer.invoke("novus:missions:attach-image", input),
    attachClipboardImage: (input) =>
      ipcRenderer.invoke("novus:missions:attach-clipboard", input),
    // Not an `invoke`: the renderer has a `File` in hand and needs the path
    // *now*, inside the drop event. Electron 32 removed `File.path`, and this
    // is its sanctioned replacement — it resolves a path the browser already
    // holds rather than granting the renderer any new reach.
    pathForDroppedFile: (file: File) => {
      try {
        const path = webUtils.getPathForFile(file);
        return path.length > 0 ? path : null;
      } catch {
        return null;
      }
    },
    retryBranch: (workstreamId) => ipcRenderer.invoke("novus:missions:retry-branch", workstreamId),
    syncBase: (missionId) => ipcRenderer.invoke("novus:missions:sync-base", missionId),
    direct: (input) => ipcRenderer.invoke("novus:missions:direct", input),
    resolveDirection: (input) => ipcRenderer.invoke("novus:missions:resolve-direction", input),
    setSessionScope: (input) => ipcRenderer.invoke("novus:missions:set-session-scope", input),
    setPermissionProfile: (input) =>
      ipcRenderer.invoke("novus:missions:set-permission-profile", input),
    setEnabledSkills: (input) => ipcRenderer.invoke("novus:missions:set-enabled-skills", input),
    setEnabledMcpServers: (input) => ipcRenderer.invoke("novus:missions:set-enabled-mcp", input),
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
    forceInterrupt: (missionId, workstreamId, sessionId) =>
      ipcRenderer.invoke(
        "novus:missions:force-interrupt",
        {
          missionId,
          ...(workstreamId ? { workstreamId } : {}),
          ...(sessionId ? { sessionId } : {})
        }
      ),
    archive: (missionId) => ipcRenderer.invoke("novus:missions:archive", missionId),
    close: (missionId, input) => ipcRenderer.invoke("novus:missions:close", { missionId, input }),
    restore: (missionId) => ipcRenderer.invoke("novus:missions:restore", missionId),
    respondApproval: (input) => ipcRenderer.invoke("novus:missions:respond-approval", input)
  },
  approaches: {
    create: (input) => ipcRenderer.invoke("novus:approaches:create", input),
    decide: (input) => ipcRenderer.invoke("novus:approaches:decide", input),
    requestRevision: (input) => ipcRenderer.invoke("novus:approaches:request-revision", input)
  },
  // Durable visual evidence (D-122, D-123). The renderer names a lane and
  // nothing else; capture authority stays in the main process, and bytes are
  // read over the novus-artifact protocol rather than through this surface.
  artifacts: {
    capture: (input) => ipcRenderer.invoke("novus:artifacts:capture", input),
    startRecording: (input) => ipcRenderer.invoke("novus:artifacts:start-recording", input),
    stopRecording: () => ipcRenderer.invoke("novus:artifacts:stop-recording"),
    cancelRecording: () => ipcRenderer.invoke("novus:artifacts:cancel-recording"),
    recordingStatus: () => ipcRenderer.invoke("novus:artifacts:recording-status"),
    onRecording: (listener) => {
      const wrapped = (_event: unknown, status: Parameters<typeof listener>[0]) => listener(status);
      ipcRenderer.on("novus:recording-status", wrapped);
      return () => ipcRenderer.removeListener("novus:recording-status", wrapped);
    },
    attach: (input) => ipcRenderer.invoke("novus:artifacts:attach", input),
    detach: (input) => ipcRenderer.invoke("novus:artifacts:detach", input)
  },
  // Publishing a decision as a pull request (D-099). No merge verb exists on
  // this bridge, on the server, or in the runner vocabulary.
  pulls: {
    push: (input) => ipcRenderer.invoke("novus:pulls:push", input),
    create: (input) => ipcRenderer.invoke("novus:pulls:create", input),
    requestReview: (input) => ipcRenderer.invoke("novus:pulls:request-review", input),
    markReady: (pullRequestId) => ipcRenderer.invoke("novus:pulls:mark-ready", pullRequestId),
    merge: (input) => ipcRenderer.invoke("novus:pulls:merge", input),
    updateBranch: (pullRequestId) => ipcRenderer.invoke("novus:pulls:update-branch", pullRequestId),
    close: (pullRequestId) => ipcRenderer.invoke("novus:pulls:close", pullRequestId),
    deleteBranch: (pullRequestId) => ipcRenderer.invoke("novus:pulls:delete-branch", pullRequestId),
    files: (pullRequestId) => ipcRenderer.invoke("novus:pulls:files", pullRequestId),
    comment: (input) => ipcRenderer.invoke("novus:pulls:comment", input),
    resolveThread: (input) => ipcRenderer.invoke("novus:pulls:resolve-thread", input),
    setMetadata: (input) => ipcRenderer.invoke("novus:pulls:set-metadata", input)
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
    // The embedded preview surface (D-098). The renderer reserves a rectangle
    // and reads a status; the view, its address, and its navigation belong to
    // the main process.
    preview: {
      open: (input) => ipcRenderer.invoke("novus:preview:open", input),
      setBounds: (bounds) => ipcRenderer.invoke("novus:preview:set-bounds", bounds),
      hide: () => ipcRenderer.invoke("novus:preview:hide"),
      reload: () => ipcRenderer.invoke("novus:preview:reload"),
      close: () => ipcRenderer.invoke("novus:preview:close"),
      status: () => ipcRenderer.invoke("novus:preview:status"),
      onStatus: (listener) => {
        const wrapped = (_event: unknown, status: Parameters<typeof listener>[0]) => listener(status);
        ipcRenderer.on("novus:preview-status", wrapped);
        return () => ipcRenderer.removeListener("novus:preview-status", wrapped);
      }
    },
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
