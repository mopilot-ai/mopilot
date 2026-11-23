// window.native.harnessRuns' types (harness install runs), merged into NativeApi; the calls are declared in
// electron/bridge/harnessRuns.cjs.
import type { InstallTools } from '../../../shared/harnessInstall.mjs';

/** A harness install or update run as every window sees it; its output comes through attach and onData. */
export interface HarnessRun {
  id: string;
  /** the registry kind: 'codex', 'claude', 'acp:<id>' */
  kind: string;
  purpose: 'install' | 'update';
  via: string;
  command: string;
  group: 'npm' | 'brew' | null;
  /** run with nobody watching (Update all): no terminal to type into, its output kept */
  quiet: boolean;
  state: 'running' | 'exited';
  /** the exit code; null while running or once stopped */
  code: number | null;
  stopped: boolean;
  /** main has looked for the harness again since it ended */
  checked: boolean;
  startedAt: number;
  endedAt: number | null;
}

export type HarnessRunStart =
  | { ok: true; run: HarnessRun; joined: boolean }
  | { ok: false; error: 'unknown' | 'busy' | 'spawn'; by?: string; message?: string };

declare module '../native' {
  interface NativeApi {
    harnessRuns: {
      /** npm and Homebrew on the login-shell PATH, and whether npm's global folder can be written */
      tools(): Promise<InstallTools>;
      list(): Promise<HarnessRun[]>;
      /** the harness's binary that can run, as path, size and change time; null for none (cheap: nothing is started) */
      find(kind: string): Promise<string | null>;
      /** run line `index` of the harness's install table; one already running for it is joined */
      start(kind: string, index: number, size?: { cols?: number; rows?: number }): Promise<HarnessRunStart>;
      /** a run and the output it kept; `end` is how much output it had in all */
      attach(id: string): Promise<{ run: HarnessRun; output: string; end: number } | null>;
      write(id: string, data: string): void;
      resize(id: string, cols: number, rows: number): void;
      stop(id: string): Promise<boolean>;
      dismiss(id: string): Promise<boolean>;
      onState(cb: (runs: HarnessRun[]) => void): () => void;
      /** `end` is the run's output length after this chunk */
      onData(cb: (e: { id: string; data: string; end: number }) => void): () => void;
    };
  }
}
