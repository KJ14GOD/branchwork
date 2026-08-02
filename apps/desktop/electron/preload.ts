import { contextBridge, ipcRenderer } from "electron";
import type { IpcAuthStatus, NovusBridge } from "@novus/contracts";

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
    baseLocal: (localId) => ipcRenderer.invoke("novus:repos:base-local", localId)
  },
  missions: {
    list: () => ipcRenderer.invoke("novus:missions:list"),
    create: (input) => ipcRenderer.invoke("novus:missions:create", input),
    get: (missionId) => ipcRenderer.invoke("novus:missions:get", missionId),
    retryBranch: (workstreamId) => ipcRenderer.invoke("novus:missions:retry-branch", workstreamId),
    direct: (input) => ipcRenderer.invoke("novus:missions:direct", input),
    resolveDirection: (input) => ipcRenderer.invoke("novus:missions:resolve-direction", input),
    cancelDirection: (directionId) => ipcRenderer.invoke("novus:missions:cancel-direction", directionId),
    stop: (missionId) => ipcRenderer.invoke("novus:missions:stop", missionId)
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
  }
};

contextBridge.exposeInMainWorld("novus", novus);
