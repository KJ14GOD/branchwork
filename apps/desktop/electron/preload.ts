import { contextBridge, ipcRenderer } from "electron";
import type {
  AvailableRepository,
  BaseRevision,
  CreateMissionInput,
  IpcAuthStatus,
  IpcResult,
  Mission,
  MissionDetailResponse,
  SetupProbeResponse,
  Workstream
} from "@novus/contracts";

/**
 * The complete renderer surface. No Node, no Electron internals, no session
 * credentials — only these typed calls cross the bridge.
 */
const novus = {
  auth: {
    status: (): Promise<IpcAuthStatus> => ipcRenderer.invoke("novus:auth:status"),
    start: (): Promise<IpcResult<null>> => ipcRenderer.invoke("novus:auth:start"),
    signOut: (): Promise<IpcResult<null>> => ipcRenderer.invoke("novus:auth:signout"),
    onChanged: (listener: (status: IpcAuthStatus) => void): (() => void) => {
      const wrapped = (_event: unknown, status: IpcAuthStatus) => listener(status);
      ipcRenderer.on("novus:auth-changed", wrapped);
      return () => ipcRenderer.removeListener("novus:auth-changed", wrapped);
    }
  },
  setup: {
    probe: (): Promise<IpcResult<SetupProbeResponse>> => ipcRenderer.invoke("novus:setup:probe")
  },
  repos: {
    available: (): Promise<IpcResult<AvailableRepository[]>> => ipcRenderer.invoke("novus:repos:available"),
    base: (providerRepoId: string, ref?: string): Promise<IpcResult<BaseRevision>> =>
      ipcRenderer.invoke("novus:repos:base", { providerRepoId, ref }),
    addLocal: (): Promise<IpcResult<unknown>> => ipcRenderer.invoke("novus:repos:add-local"),
    localList: (): Promise<IpcResult<unknown[]>> => ipcRenderer.invoke("novus:repos:local-list"),
    baseLocal: (localId: string): Promise<IpcResult<unknown>> =>
      ipcRenderer.invoke("novus:repos:base-local", localId)
  },
  missions: {
    list: (): Promise<IpcResult<Mission[]>> => ipcRenderer.invoke("novus:missions:list"),
    create: (input: CreateMissionInput): Promise<IpcResult<{ mission: Mission; workstream: Workstream }>> =>
      ipcRenderer.invoke("novus:missions:create", input),
    get: (missionId: string): Promise<IpcResult<MissionDetailResponse>> =>
      ipcRenderer.invoke("novus:missions:get", missionId),
    retryBranch: (workstreamId: string): Promise<IpcResult<Workstream>> =>
      ipcRenderer.invoke("novus:missions:retry-branch", workstreamId),
    direct: (input: { missionId: string; body: string }): Promise<IpcResult<null>> =>
      ipcRenderer.invoke("novus:missions:direct", input),
    stop: (missionId: string): Promise<IpcResult<boolean>> => ipcRenderer.invoke("novus:missions:stop", missionId),
    running: (missionId: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke("novus:missions:running", missionId)
  }
};

export type NovusBridge = typeof novus;

contextBridge.exposeInMainWorld("novus", novus);
