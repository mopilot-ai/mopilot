// Native bridge projects, git, terminal, cloud, speech and update contracts.
import type { RollbackIntent } from '../../../../shared/releaseRollback.cjs';
export type { CloudEnv, CloudTask, MigrationStatus } from '../../../../shared/model/native';

/** What a new or restored worktree got of its repository's ignored files (.env and the like; electron/platform/worktreeCopy.cjs). */
export interface WorktreeCopy {
  /** Paths in the repository, copied to the same place in the worktree. */
  copied: string[];
  skipped: { path: string; reason: string }[];
  /** Why nothing, or not everything, could be copied. */
  problem: string | null;
  /** `problem` and `skipped` in one line for the user; '' when there is nothing to say. */
  notice: string;
}

/** A worktree MoPilot made, or adopted in place (electron/platform/git.cjs). */
export interface ManagedWorktree {
  path: string;
  repo: string;
  branch: string | null;
  sourceBranch?: string;
  /** Made by another tool or by hand and adopted where it is: MoPilot never removes it. */
  adopted?: boolean;
  createdAt: number;
}

export interface GitInfo {
  root: string;
  branch: string;
  remote: string;
  branches: string[];
}

export interface BranchList {
  current: string | null;
  default: string | null;
  branches: string[];
  /** false: a worktree can't start from this repository (nothing checked out or on origin's default) */
  commits: boolean;
}

export interface GitStatusFile {
  code: string;
  path: string;
  added: number;
  removed: number;
  /** the path is unmerged: a conflict not yet resolved */
  conflicted?: boolean;
}

export interface NativeMenuItem {
  id?: string;
  label?: string;
  type?: 'separator';
  enabled?: boolean;
  checked?: boolean;
  accelerator?: string;
  submenu?: NativeMenuItem[];
}

/** One file-search hit; `path` is relative to `root`, `indices` are the matched positions in `path`. */
export interface FileMatch {
  root: string;
  path: string;
  file_name: string;
  match_type: 'file' | 'directory';
  indices: number[];
  score: number;
}

export interface LocalProject {
  id: string;
  name: string;
  path: string;
  source: 'sage' | 'codex';
  codexId?: string;
}

export interface MigrationCounts {
  chats: number;
  pinned: number;
  unread: number;
  archived: number;
  worktree: number;
  accounts: number;
  accountsPinned: number;
  multiSegment: number;
}

export interface MigrationReport {
  id: string;
  result: 'ok' | 'failed' | 'restored' | string;
  at: number | null;
  appVersion: string | null;
  report: { ok: boolean; before: MigrationCounts; after: MigrationCounts; failed: string[]; written: number } | null;
  backup: string | null;
  backupOk: boolean;
}

export interface ProjectsSnapshot {
  projects: LocalProject[];
  codexImported: boolean;
  /** the last import failed: when, why, and how many launches in a row */
  codexImportFailure?: { at: number; message: string; attempts: number } | null;
}

export interface PtySpawnOptions {
  command?: string[];
  /** Windows cmd launchers already escaped by winbin; pass to ConPTY verbatim instead of quoting twice. */
  windowsCommandLine?: string;
  cwd?: string;
  /** merged over the app's environment; null removes a variable */
  env?: Record<string, string | null>;
  /** a sign-in: URLs it opens go to the user's own browser, not the chat's pane (its OAuth redirect is a localhost listener) */
  systemBrowser?: boolean;
  cols?: number;
  rows?: number;
  /** no interactive terminal view answers for it (a one-off command): on Windows it answers ConPTY's start-up question itself */
  selfAnswer?: boolean;
}

export type PtyEvent = { id: string; type: 'data'; data: string } | { id: string; type: 'exit'; exitCode: number; signal: number | null };

/** The local dictation engine: Speech Recognition permission and whether it can run on this device. */
export interface LocalSpeechStatus {
  authorization: 'authorized' | 'denied' | 'restricted' | 'notDetermined';
  locale: string;
  available: boolean;
  onDevice: boolean;
}

/** The prompt could not be asked: why, in words the composer shows (the helper stopped, or is outdated and says the fix). */
export interface LocalSpeechFailure {
  failure: string;
}

export type UpdateState = {
  status: 'idle' | 'checking' | 'downloading' | 'ready' | 'installing' | 'error' | 'unsupported';
  version: string;
  available: {
    version: string;
    notes: string;
    url?: string;
    rollback?: RollbackIntent;
  } | null;
  /** Windows and Linux: the update is a package the user downloads (install() opens it), not a staged restart */
  manual?: boolean;
  error: string | null;
  checkedAt: number | null;
  /** Restart when idle was chosen; the restart waits for running work to end */
  restartWhenIdle?: boolean;
  /** macOS, while downloading: bytes so far, and the size when the server sent one */
  progress?: { version: string; received: number; total: number | null };
  /** macOS: the download finished and the update is being unpacked and verified */
  preparing?: boolean;
};

export type ExitGateRequest = { reason: 'quit' | 'update'; text: string; turns: number; background: number; goals: number; keeps?: number };
