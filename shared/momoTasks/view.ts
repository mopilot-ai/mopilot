// The tasks as the Mac and phone clients draw them: an Item mapped to the view contract (shared/momoView.ts), and the fix a client sends back read into an action.
import type { MomoTaskFailure, MomoTaskView } from '../momoView.ts';
import { describeWatch } from './watch.ts';
import type { FailureCode, Fix, Item } from './types.ts';

/** The contract's failure codes for each of ours. A stop is not a failure, so it has none. */
const CODE: Record<FailureCode, MomoTaskFailure['code'] | null> = {
  machine_offline: 'machine-unreachable',
  host_outdated: 'machine-unreachable',
  agent_missing: 'agent-missing',
  agent_signed_out: 'agent-signed-out',
  usage_limit: 'usage-limit',
  stopped_by_user: null,
  interrupted: 'restarted',
  retry_cap: 'retry-cap',
  same_failure: 'retry-cap',
  too_many_active: 'session-error',
  check_failed: 'not-done',
  watch_failed: 'session-error',
  refused: 'session-error',
  session_failed: 'session-error',
};

/** The id a client sends back for a fix: the action, and for "Run on …" the machine and agent it names. */
export const fixId = (fix: Fix): string => (fix.machineId && fix.harness ? `${fix.action}|${fix.machineId}|${fix.harness}` : fix.action);

/** A fix id read back: its action, and the machine and agent when it named them. */
export function parseFixId(id: string): { action: string; machineId: string | null; harness: string | null } {
  const [action = '', machineId, harness] = id.split('|');
  return { action, machineId: machineId || null, harness: harness || null };
}

/** The first thing the user can press: the one-click fix of the cause, else null (the client falls back to Retry). */
const primaryFix = (fixes: Fix[]): { id: string; label: string } | null => {
  const first = fixes[0];
  return first ? { id: fixId(first), label: first.label } : null;
};

/** @param nameOf the machine's display name now; null when this home does not list it */
export function taskView(item: Item, nameOf: (machineId: string) => string | null): MomoTaskView {
  // a machine this home does not list is named as it was when the task last ran there, never by its raw id
  const machine = { machineId: item.where.machineId, name: nameOf(item.where.machineId) ?? item.where.machineName ?? 'An unknown machine' };
  const error = item.lastError;
  // a code a newer home made is still a failure to show
  const code = error ? (Object.hasOwn(CODE, error.code) ? CODE[error.code] : 'session-error') : null;
  let failure: MomoTaskFailure | null = null;
  if (error && code) {
    failure = { code, message: error.message, machine, agent: item.where.harness, fix: primaryFix(error.fixes) };
  } else if (item.state === 'needs_you' && item.result && !item.result.met && item.cardId === null) {
    // finished, but the check says it is not done: the user decides
    failure = {
      code: 'not-done',
      message: item.progress ?? item.result.summary,
      machine,
      agent: item.where.harness,
      fix: { id: 'review', label: 'Review' },
    };
  }
  return {
    id: item.id,
    title: item.title,
    doneMeans: item.doneMeans,
    state: item.state,
    origin: item.origin,
    where: { machine, agent: item.where.harness },
    startedAt: item.startedAt ?? item.createdAt,
    attempts: item.attempts,
    attemptCap: item.attemptCap,
    step: item.state === 'watching' && item.watch ? `Watching ${describeWatch(item.watch.watch)}` : item.progress,
    nextCheck: item.nextCheck,
    failure,
    result: item.result ? { summary: item.result.summary, files: item.result.files, evidence: item.result.evidence } : null,
  };
}
