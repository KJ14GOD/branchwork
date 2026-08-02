import type {
  CreateMissionInput,
  IpcAuthStatus,
  IpcResult,
  Mission,
  MissionDetailResponse,
  SetupProbeResponse
} from "@novus/contracts";

export interface NovusBridge {
  auth: {
    status(): Promise<IpcAuthStatus>;
    start(): Promise<IpcResult<null>>;
    signOut(): Promise<IpcResult<null>>;
    onChanged(listener: (status: IpcAuthStatus) => void): () => void;
  };
  setup: {
    probe(): Promise<IpcResult<SetupProbeResponse>>;
  };
  missions: {
    list(): Promise<IpcResult<Mission[]>>;
    create(input: CreateMissionInput): Promise<IpcResult<Mission>>;
    get(missionId: string): Promise<IpcResult<MissionDetailResponse>>;
  };
}

declare global {
  interface Window {
    novus: NovusBridge;
  }
}

export const novus = (): NovusBridge => window.novus;
