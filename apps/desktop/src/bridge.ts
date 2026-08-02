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
  repos: {
    available(): Promise<IpcResult<AvailableRepository[]>>;
    base(providerRepoId: string, ref?: string): Promise<IpcResult<BaseRevision>>;
  };
  missions: {
    list(): Promise<IpcResult<Mission[]>>;
    create(input: CreateMissionInput): Promise<IpcResult<{ mission: Mission; workstream: Workstream }>>;
    get(missionId: string): Promise<IpcResult<MissionDetailResponse>>;
    retryBranch(workstreamId: string): Promise<IpcResult<Workstream>>;
  };
}

declare global {
  interface Window {
    novus: NovusBridge;
  }
}

export const novus = (): NovusBridge => window.novus;
