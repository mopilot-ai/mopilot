// Check connection: named steps read from what the phone already knows, and a report of them that holds no code, key, name or chat text.
import type { MobileSnapshot } from './contracts';
import { presenceLine } from './presence';
import type { PermissionStep } from './push/permission';
import type { TokenStatus } from './push/registration';

export type StepState = 'ok' | 'bad' | 'wait' | 'na';
export type CheckStep = { name: string; state: StepState; note?: string };

const MARK: Record<StepState, string> = { ok: '✓', bad: '✗', wait: '…', na: '–' };

/** The path from the account to the computer, one step each, so the person sees where it stops. */
export function checkSteps(
  state: MobileSnapshot,
  push: { step: PermissionStep; token: TokenStatus | null } | null,
  now: number,
): CheckStep[] {
  const pair = state.selectedPair ?? state.pairs[0]?.pairId;
  const presence = pair ? state.presence[pair] : undefined;
  const steps: CheckStep[] = [
    state.user ? { name: 'Signed in', state: 'ok' } : { name: 'Signed in', state: 'bad', note: 'Sign in again.' },
    state.pairs.length
      ? { name: 'Computer paired', state: 'ok' }
      : { name: 'Computer paired', state: 'bad', note: 'Pair a computer in Settings.' },
  ];
  const relay: CheckStep =
    state.phase === 'error'
      ? { name: 'Reached the relay', state: 'bad', note: 'The relay did not answer. Check your connection.' }
      : state.phase === 'online' || presence
        ? { name: 'Reached the relay', state: 'ok' }
        : { name: 'Reached the relay', state: 'wait', note: 'No answer yet.' };
  const line = presenceLine(presence, now);
  const computer: CheckStep = !presence
    ? { name: 'Computer is awake', state: 'wait', note: 'Not known yet.' }
    : presence.state === 'online'
      ? { name: 'Computer is awake', state: 'ok' }
      : { name: 'Computer is awake', state: 'bad', note: `${line}. Is it awake and signed in?` };
  steps.push(
    relay,
    computer,
    state.phase === 'online'
      ? { name: 'Connected', state: 'ok' }
      : { name: 'Connected', state: 'bad', note: 'Not connected. Connect it under Computers.' },
  );
  if (push) steps.push(notificationsStep(push));
  return steps;
}

function notificationsStep({ step, token }: { step: PermissionStep; token: TokenStatus | null }): CheckStep {
  if (step === 'blocked') return { name: 'Notifications', state: 'bad', note: "Off in your phone's settings." };
  if (step !== 'granted') return { name: 'Notifications', state: 'na', note: 'Not turned on.' };
  if (token === 'registered') return { name: 'Notifications', state: 'ok' };
  return token === 'unavailable'
    ? { name: 'Notifications', state: 'bad', note: 'Not available in this build.' }
    : { name: 'Notifications', state: 'wait', note: 'Waiting for a device token.' };
}

/** Plain text for sharing: the steps and their notes, and the app version. Nothing the person typed or any identifier is in it. */
export function checkReport(steps: CheckStep[], version?: string): string {
  return [
    `MoPilot connection check${version ? ` (${version})` : ''}`,
    ...steps.map((s) => `${MARK[s.state]} ${s.name}${s.note ? ` — ${s.note}` : ''}`),
  ].join('\n');
}

/** What a screen reader says for a step's mark. */
export const STATE_WORD: Record<StepState, string> = { ok: 'ok', bad: 'problem', wait: 'waiting', na: 'not used' };

export const stepMark = (state: StepState) => MARK[state];
