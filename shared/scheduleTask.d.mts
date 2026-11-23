/** The task fields a run reads (a subset of Automation). */
export interface TaskFields {
  kind?: string;
  harness?: unknown;
  computer_control?: unknown;
  on_approval?: unknown;
  model?: string;
  reasoning_effort?: string;
  execution_environment?: string;
  target_thread_id?: string;
  /** the remote machine it runs on; none for this Mac */
  host_id?: unknown;
}
export type RunWith = 'codex' | 'claude' | `acp:${string}`;
export type OnApproval = 'wait' | 'skip';

export function isTaskFolderId(id: unknown): id is string;
export function canonicalTask<T extends { id: unknown }>(tasks: T[], id: unknown): T | null;
export function runWithOf(a: TaskFields): RunWith;
export function acpHarnessOf(a: TaskFields): string | null;
export function machineOf(a: TaskFields): string | null;
export function nativeAppOf(a: TaskFields): 'codex-app' | 'claude-desktop' | null;
export function storeHomeOf(a: TaskFields): 'codex' | 'mopilot';
export function desktopRuns(a: TaskFields): boolean;
export function machineHarnessOf(a: TaskFields): string;
export function computerAllowed(a: TaskFields): boolean;
export function approvalOf(a: TaskFields): OnApproval;
export function scheduledMark(a: TaskFields, unattended: boolean): { unattended: boolean; computer: boolean; onApproval: OnApproval };
export function wantsWorktree(a: TaskFields): boolean;
export function runSendOptions(a: TaskFields): { model?: string; effort?: string };

export function canRememberChat(started: TaskFields, current: TaskFields | null | undefined): boolean;
