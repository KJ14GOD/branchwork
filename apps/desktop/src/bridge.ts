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
    addLocal(): Promise<
      IpcResult<{ providerRepoId: string; name: string; defaultBranch: string; provider: "local" } | null>
    >;
    localList(): Promise<
      IpcResult<{ providerRepoId: string; name: string; defaultBranch: string; onThisMachine: boolean }[]>
    >;
    baseLocal(localId: string): Promise<IpcResult<BaseRevision>>;
  };
  missions: {
    list(): Promise<IpcResult<Mission[]>>;
    create(input: CreateMissionInput): Promise<IpcResult<{ mission: Mission; workstream: Workstream }>>;
    get(missionId: string): Promise<IpcResult<MissionDetailResponse>>;
    retryBranch(workstreamId: string): Promise<IpcResult<Workstream>>;
    direct(input: { missionId: string; localId: string; missionBranch: string; body: string }): Promise<IpcResult<null>>;
    stop(missionId: string): Promise<IpcResult<boolean>>;
    running(missionId: string): Promise<IpcResult<boolean>>;
  };
}

declare global {
  interface Window {
    novus: NovusBridge;
  }
}

export const novus = (): NovusBridge => window.novus;
