// window.native.computerHistory's types (Computer History, #1363, electron/computerHistory), merged into NativeApi; the calls are declared in electron/bridge/computerHistory.cjs.
export {};

export type ComputerHistoryStatus = 'off' | 'recording' | 'paused' | 'suspended' | 'needs-permission' | 'unavailable' | 'store-unavailable';

export interface ComputerHistorySettings {
  enabled: boolean;
  paused: boolean;
  apps: { bundleId: string; name: string }[];
  sites: string[];
  retentionDays: number;
  explainerSeen: boolean;
}

export interface ComputerHistoryState {
  status: ComputerHistoryStatus;
  settings: ComputerHistorySettings;
  suspended: ('locked' | 'asleep' | 'quit')[];
  /** why the latest sample or write failed */
  error: string | null;
  /** set when the saved settings could not be read (Computer History is then off) */
  settingsError: string | null;
}

export interface ComputerHistoryMemory {
  day: string;
  bundleId: string;
  app: string;
  site?: string;
  title: string;
  start: number;
  end: number;
  ms: number;
}

/** Every answer carries the state after the call; a refused or failed call says why. */
export type ComputerHistoryResult<T = object> =
  | ({ ok: true; state: ComputerHistoryState } & T)
  | { ok: false; error?: string; reason?: string; state?: ComputerHistoryState };

declare module '../native' {
  interface NativeApi {
    computerHistory: {
      state(): Promise<ComputerHistoryResult<{ exclusions: { apps: { pattern: string; reason: string }[]; healthSites: string[] } }>>;
      setEnabled(on: boolean): Promise<ComputerHistoryResult>;
      pause(): Promise<ComputerHistoryResult>;
      resume(): Promise<ComputerHistoryResult>;
      allowApp(app: { bundleId: string; name: string }): Promise<ComputerHistoryResult>;
      removeApp(bundleId: string): Promise<ComputerHistoryResult>;
      allowSite(site: string): Promise<ComputerHistoryResult<{ site: string }>>;
      removeSite(site: string): Promise<ComputerHistoryResult>;
      setRetention(days: number): Promise<ComputerHistoryResult>;
      explainerSeen(): Promise<ComputerHistoryResult>;
      days(): Promise<ComputerHistoryResult<{ days: string[] }>>;
      /** days default to today; apps / sites narrow to what the user chose to share */
      memories(q?: {
        days?: string[];
        apps?: string[];
        sites?: string[];
      }): Promise<ComputerHistoryResult<{ memories: ComputerHistoryMemory[]; text: string; block: string | null; unreadable: number }>>;
      deleteDay(day: string): Promise<ComputerHistoryResult>;
      deleteAll(): Promise<ComputerHistoryResult>;
      candidates(): Promise<
        { ok: true; apps: { bundleId: string; name: string; excluded: string | null }[] } | { ok: false; error: string }
      >;
      onChanged(cb: (state: ComputerHistoryState) => void): () => void;
    };
  }
}
