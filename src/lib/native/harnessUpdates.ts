// window.native.harnessUpdates' types (harness versions and updates), merged into NativeApi; the calls are declared
// in electron/bridge/harnessUpdates.cjs.
import type { HarnessUpdateOutcome, HarnessVersionInfo } from '../../../shared/model/harness';
export type { HarnessUpdateOutcome, HarnessVersionInfo } from '../../../shared/model/harness';

export interface UpdateAllState {
  running: boolean;
  total: number;
  index: number;
  current: string | null;
  results: { harness: string; outcome: HarnessUpdateOutcome | null }[];
  cancelled: boolean;
}

export interface HarnessUpdatesState {
  harnesses: HarnessVersionInfo[];
  all: UpdateAllState | null;
  checkedAt: number | null;
  checking: boolean;
}

export type HarnessUpdateResult =
  | { ok: true; runId?: string; waiting?: boolean }
  | {
      ok: false;
      error: 'not-updatable' | 'chats' | 'busy' | 'spawn' | 'unknown';
      chats?: { id: string; title: string }[];
      by?: string;
      message?: string;
    };

declare module '../native' {
  interface NativeApi {
    harnessUpdates: {
      state(): Promise<HarnessUpdatesState>;
      /** read every installed harness again; `force` asks the registries again too */
      check(force?: boolean): Promise<HarnessUpdatesState>;
      /** with chats mid-turn on it: 'now', 'idle' (wait for them), or unset to be told which */
      update(kind: string, when?: 'now' | 'idle'): Promise<HarnessUpdateResult>;
      cancelWait(kind: string): Promise<boolean>;
      updateAll(): Promise<{ ok: boolean; error?: string }>;
      cancelAll(): Promise<boolean>;
      onState(cb: (s: HarnessUpdatesState) => void): () => void;
    };
  }
}
