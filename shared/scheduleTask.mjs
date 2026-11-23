// What a scheduled task's run is made of: which harness runs it, what it may do, and what its first
// message is sent with. Pure, so main (electron/platform/automationRun.cjs), the Scheduled page and the
// tests agree. The fields sit in the task's automation.toml next to the ones Codex's own app writes;
// Codex ignores keys it doesn't know.

import { isHarnessKind } from './defaultHarness.mjs';
import { ownTable } from './ownTable.mjs';

/** An unencoded task-directory key cannot select a parent or contain a path separator. */
export const isTaskFolderId = (id) => typeof id === 'string' && !!id && !/[\\/]|^\.\.?$/.test(id);

/** Resolve an ID-only reference after native mirrors and transfers have been canonicalized by the store. */
export function canonicalTask(tasks, id) {
  const matches = tasks.filter((a) => String(a.id) === String(id));
  if (matches.length > 1) throw new Error(`Scheduled task id "${id}" is ambiguous`);
  return matches[0] ?? null;
}

/** Which harness runs a task: 'claude', 'acp:<id>', or Codex for no harness or one this app doesn't run (an older value). */
export const runWithOf = (a) => (isHarnessKind(a.harness) ? a.harness : 'codex');

/** The basic-tier harness id a run uses ('opencode' for 'acp:opencode'), or null for Codex and Claude Code. */
export const acpHarnessOf = (a) => /^acp:(.+)$/.exec(runWithOf(a))?.[1] ?? null;

/** The remote machine a task runs on (its Host's id in the machine list), or null for this Mac. */
export const machineOf = (a) => (typeof a.host_id === 'string' && a.host_id ? a.host_id : null);

/** The app that runs a task beside MoPilot, by its harness: the Codex app keeps Codex tasks, Claude Desktop also runs Claude Code ones. */
const NATIVE_APP = ownTable({ codex: 'codex-app', claude: 'claude-desktop' });

/** The native app that also runs a task on this Mac, or null: a task on a machine runs only there. */
export const nativeAppOf = (a) => (machineOf(a) ? null : (NATIVE_APP[runWithOf(a)] ?? null));

/** Where a task's file lives: with the Codex app when it runs it ('codex'), else in MoPilot's folder ('mopilot'). */
export const storeHomeOf = (a) => (nativeAppOf(a) === 'codex-app' ? 'codex' : 'mopilot');

/** Whether Claude Desktop also runs the task. */
export const desktopRuns = (a) => nativeAppOf(a) === 'claude-desktop';

/** The agent a machine runs a task with, as its Host names it: 'claude', 'codex' or a basic agent's id. */
export const machineHarnessOf = (a) => acpHarnessOf(a) ?? runWithOf(a);

/** Computer control is off unless the task says so. */
export const computerAllowed = (a) => a.computer_control === true;

export const approvalOf = (a) => (a.on_approval === 'skip' ? 'skip' : 'wait');

/** What the run's chat is marked with (SessionState.scheduled); `unattended` is true for runs the scheduler starts. */
export function scheduledMark(a, unattended) {
  return { unattended, computer: computerAllowed(a), onApproval: approvalOf(a) };
}

/** Whether the task runs in a fresh worktree ("Run on this computer" off). */
export const wantsWorktree = (a) => a.execution_environment === 'worktree';

/** What the first message of a run is sent with: the task's model and effort, when it names them. */
export function runSendOptions(a) {
  return { ...(a.model ? { model: a.model } : {}), ...(a.reasoning_effort ? { effort: a.reasoning_effort } : {}) };
}

/** A newly started heartbeat chat applies only while the task still requests that mode, harness and machine. */
export function canRememberChat(started, current) {
  return (
    !!current &&
    current.kind === 'heartbeat' &&
    runWithOf(current) === runWithOf(started) &&
    machineOf(current) === machineOf(started) &&
    !current.target_thread_id
  );
}
