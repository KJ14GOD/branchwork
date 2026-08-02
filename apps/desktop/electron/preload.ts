import { contextBridge, ipcRenderer } from "electron";
import type {
  CreateMissionInput,
  IpcAuthStatus,
  IpcResult,
  Mission,
  MissionDetailResponse
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
  missions: {
    list: (): Promise<IpcResult<Mission[]>> => ipcRenderer.invoke("novus:missions:list"),
    create: (input: CreateMissionInput): Promise<IpcResult<Mission>> =>
      ipcRenderer.invoke("novus:missions:create", input),
    get: (missionId: string): Promise<IpcResult<MissionDetailResponse>> =>
      ipcRenderer.invoke("novus:missions:get", missionId)
  }
};

export type NovusBridge = typeof novus;

contextBridge.exposeInMainWorld("novus", novus);
