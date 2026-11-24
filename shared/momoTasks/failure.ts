// Why a task could not start or finish, as the real cause plus one-click fix data. The words come from the same tables a Remote Run chat uses (shared/host/refusalWords, turnErrorCode), handed in through `FailureContext.words`, so a machine chat and a task never disagree.
import type { FailureCode, Fix, FixAction, MachineInfo, RefusalWordsOf, TaskError, TaskWords } from './types.ts';

/** How many named alternatives "Run on another machine" lists. */
export const MAX_ALTERNATIVES = 3;

export type FailureContext = {
  /** The machine the task was meant for; null when MoMo does not know it (removed). */
  machine: MachineInfo | null;
  machineId: string;
  harness: string;
  /** Every machine MoMo knows, to name where else it could run. */
  machines: MachineInfo[];
  words: TaskWords;
  /** The machine's name as the task last knew it, for one that is no longer listed. */
  knownName?: string | null;
  now: number;
};

export const machineName = (c: FailureContext): string => c.machine?.name ?? c.knownName ?? c.machineId;

/** Machines other than the failing one where the same agent is ready: the named choices of "Run on another machine". */
export function alternatives(c: FailureContext): Fix[] {
  const named = c.machines
    .filter(
      (m) => m.machineId !== c.machineId && m.online && !m.outdated && m.agents.some((a) => a.id === c.harness && a.state === 'ready'),
    )
    .slice(0, MAX_ALTERNATIVES)
    .map((m): Fix => ({ action: 'runElsewhere', label: `Run on ${m.name}`, machineId: m.machineId, harness: c.harness }));
  return named.length ? named : [{ action: 'runElsewhere', label: 'Run on another machine' }];
}

const FIX_LABEL: Partial<Record<FixAction, (machine: string, agent: string) => string>> = {
  install: (machine, agent) => `Install ${agent} on ${machine}`,
  signIn: (machine) => `Sign in on ${machine}`,
  orgSignIn: () => 'Sign in to your organization',
  update: (machine) => `Update MoPilot on ${machine}`,
  // done by the app: it registers MoMo's key on that machine after the owner agrees
  allow: (machine) => `Allow MoMo to use ${machine}`,
};

const fix = (action: FixAction, c: FailureContext, extra: Partial<Fix> = {}): Fix => ({
  action,
  label: (FIX_LABEL[action] as (machine: string, agent: string) => string)(machineName(c), c.words.agentLabel(c.harness)),
  machineId: c.machineId,
  harness: c.harness,
  ...extra,
});

const error = (c: FailureContext, code: FailureCode, message: string, fixes: Fix[], retry: boolean): TaskError => ({
  code,
  message,
  fixes,
  retry,
  at: c.now,
});

/** The two refusal codes whose words always exist. */
const known = (
  c: FailureContext,
  code: 'agent_missing' | 'agent_signed_out',
  ctx: Parameters<TaskWords['refusalWords']>[1],
): RefusalWordsOf => c.words.refusalWords(code, ctx) as RefusalWordsOf;

const retryFix: Fix = { action: 'retry', label: 'Retry' };

/** The machine's own state before anything is sent: offline, out of date, or the agent missing or signed out there. null when it looks ready. */
export function preflight(c: FailureContext): TaskError | null {
  const name = machineName(c);
  if (!c.machine) return error(c, 'machine_offline', `${name} isn't one of your machines any more.`, alternatives(c), false);
  if (c.machine.needsAllow)
    return error(c, 'machine_not_allowed', `MoMo isn't allowed to use ${name} yet.`, [fix('allow', c), ...alternatives(c)], false);
  if (!c.machine.online) return error(c, 'machine_offline', `${name} is offline.`, [retryFix, ...alternatives(c)], true);
  if (c.machine.outdated)
    return error(c, 'host_outdated', `MoPilot on ${name} is out of date.`, [fix('update', c), ...alternatives(c)], false);
  const state = c.machine.agents.find((a) => a.id === c.harness)?.state ?? 'missing';
  if (state === 'missing') {
    const words = known(c, 'agent_missing', { machine: name, agent: c.harness, installable: c.machine.installable });
    return error(c, 'agent_missing', words.line, [...(words.action === 'install' ? [fix('install', c)] : []), ...alternatives(c)], false);
  }
  if (state === 'signin') {
    return error(
      c,
      'agent_signed_out',
      known(c, 'agent_signed_out', { machine: name, agent: c.harness }).line,
      [fix('signIn', c), ...alternatives(c)],
      false,
    );
  }
  return null;
}

/** A Host's refusal of the start, in the words a Remote Run chat shows for the same code. */
export function fromRefusal(refusal: { code: string; message?: string; details?: Record<string, unknown> }, c: FailureContext): TaskError {
  const name = machineName(c);
  // the machine does not take MoMo's key as its home's (another key holds the lease, none does, or a handover did not finish): the owner's device allows MoMo again, in the machine's own words
  if (refusal.code === 'home_lease_held' || refusal.code === 'home_lease_unassigned' || refusal.code === 'home_handover_failed')
    return error(
      c,
      'machine_not_allowed',
      c.words.refusalWords(refusal.code, { machine: name })?.line ?? `MoMo isn't allowed to use ${name} yet.`,
      [fix('allow', c), ...alternatives(c)],
      false,
    );
  if (refusal.code === 'machine_not_allowed')
    return error(c, 'machine_not_allowed', `MoMo isn't allowed to use ${name} yet.`, [fix('allow', c), ...alternatives(c)], false);
  if (refusal.code === 'machine_lost')
    return error(
      c,
      'machine_offline',
      `The connection to ${name} was lost while starting, so it may have started. Retry checks.`,
      [retryFix, ...alternatives(c)],
      true,
    );
  if (refusal.code === 'machine_offline') return error(c, 'machine_offline', `${name} is offline.`, [retryFix, ...alternatives(c)], true);
  if (refusal.code === 'host_outdated')
    return error(c, 'host_outdated', `MoPilot on ${name} is out of date.`, [fix('update', c), ...alternatives(c)], false);
  const words = c.words.refusalWords(refusal.code, {
    machine: name,
    agent: c.harness,
    message: refusal.message,
    details: refusal.details,
    installable: c.machine?.installable === true,
  });
  const line = words?.line ?? refusal.message?.trim() ?? `${name} couldn't start this.`;
  const fixes: Fix[] = [];
  if (words?.action && Object.hasOwn(FIX_LABEL, words.action)) fixes.push(fix(words.action as FixAction, c));
  if (words?.retry) fixes.push(retryFix);
  fixes.push(...alternatives(c));
  const code: FailureCode =
    refusal.code === 'agent_missing'
      ? 'agent_missing'
      : refusal.code === 'agent_signed_out' || refusal.code === 'login_signed_out'
        ? 'agent_signed_out'
        : refusal.code === 'login_limited' || refusal.code === 'spend_limit'
          ? 'usage_limit'
          : 'refused';
  return error(c, code, line, fixes, words?.retry === true);
}

/** A session's own failure, told apart by the shared typed code: a usage limit, a sign-in that stopped working, or anything else with the agent's words. */
export function fromSessionFailure(signal: unknown, message: string | undefined, c: FailureContext): TaskError {
  const name = machineName(c);
  const agent = c.words.agentLabel(c.harness);
  const code = c.words.turnErrorCode(signal, message);
  if (code === 'rate_limit')
    return error(c, 'usage_limit', `${agent} on ${name} hit its usage limit.`, [retryFix, ...alternatives(c)], true);
  if (code === 'auth')
    return error(c, 'agent_signed_out', `${agent} on ${name} is signed out.`, [fix('signIn', c), ...alternatives(c)], false);
  const said = message?.trim();
  return error(
    c,
    'session_failed',
    said ? `${agent} on ${name} stopped: ${said.slice(0, 300)}` : `${agent} on ${name} stopped.`,
    [retryFix, ...alternatives(c)],
    true,
  );
}

export const stoppedByUser = (c: FailureContext): TaskError =>
  error(c, 'stopped_by_user', 'You stopped this task. Files already made are kept.', [], false);

/** The machine restarted, or the session is gone, while the task ran: it may have partly finished, so it is never started again by itself. */
export const interrupted = (c: FailureContext, reason: 'machine_restarted' | 'session_gone' | 'never_started'): TaskError =>
  error(
    c,
    'interrupted',
    reason === 'machine_restarted'
      ? `${machineName(c)} restarted while this ran. It may have partly finished.`
      : reason === 'session_gone'
        ? `The session for this task is gone from ${machineName(c)}. It may have partly finished.`
        : `MoMo restarted while this was starting, so it may already be running on ${machineName(c)}. Start again reconnects to it if so.`,
    [
      ...(reason === 'never_started' ? [] : [{ action: 'openSession' as const, label: 'Open the session' }]),
      { action: 'startAgain', label: 'Start again' },
    ],
    false,
  );

export const retryCapReached = (c: FailureContext, cap: number): TaskError =>
  error(c, 'retry_cap', `This task has already run ${cap} times. Run it on another machine, or ask me again.`, alternatives(c), false);

export const sameFailure = (c: FailureContext, last: TaskError): TaskError =>
  error(c, 'same_failure', `${last.message} Trying the same thing here would fail the same way.`, alternatives(c), false);

export const tooManyActive = (c: FailureContext, max: number): TaskError =>
  error(c, 'too_many_active', `${max} tasks are already working. Ask again when one has finished.`, [], false);

export const checkFailed = (c: FailureContext, why: string): TaskError =>
  error(
    c,
    'check_failed',
    why,
    [
      { action: 'review', label: 'Review' },
      { action: 'openSession', label: 'Open the session' },
    ],
    false,
  );

export const watchFailed = (c: FailureContext, why: string): TaskError => error(c, 'watch_failed', why, [retryFix], true);
