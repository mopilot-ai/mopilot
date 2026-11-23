// The pairing log: where a pairing that has not finished stopped, in two named steps, a report of them without the code or any key, and the one line a failure says.
import { isTransient } from './reconnect';

export const PAIR_TIMEOUT_MS = 30_000;

export type PairOutcome = 'running' | 'timeout' | 'badCode' | 'otherAccount' | 'declined' | 'noAnswer';
export type PairStep = { name: 'Code read' | 'Waiting for the computer'; state: 'ok' | 'bad' | 'wait'; hint?: string };

const OTHER_ACCOUNT = 'relay: forbidden';
const DECLINED = 'pairing rejected';
const USED = /^relay: (taken|already_joined|pair_exists)$/;
const LAPSED = /^relay: (expired|pair_expired|unknown_pair)$|expired QR/;
const FOREIGN = /(?:untrusted|invalid) relay/;
const UNREADABLE = /invalid QR/;
const NEWER = /newer QR/;
const OLDER = /older QR/;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The failure is this phone being too old for the computer's code: the fix is its App Store page. */
export const needsUpdate = (error: unknown) => NEWER.test(message(error));

/** A failure that came from the code itself (unreadable, expired, used, another relay) is told apart from one that came after it was read. */
export const failureOutcome = (error: unknown): PairOutcome => {
  const text = message(error);
  if (text === OTHER_ACCOUNT) return 'otherAccount';
  if (text === DECLINED) return 'declined';
  return [USED, LAPSED, FOREIGN, UNREADABLE, NEWER, OLDER].some((kind) => kind.test(text)) ? 'badCode' : 'noAnswer';
};

/** The failure line already says what happened and what to do (an unreadable, expired or used code, a declined phone, another account): the step-by-step log, which is for a pairing that stalled or got no answer, would only repeat it. */
export const explained = (outcome: PairOutcome) => outcome === 'badCode' || outcome === 'declined' || outcome === 'otherAccount';

/** A line for the home screen: a protocol word becomes the same plain line, and anything already written for a person stays as it is. */
export const plainError = (text: string | null | undefined) =>
  text && /^relay: |^pairing rejected$|^pair cleanup required$|QR$/.test(text) ? pairFailure(new Error(text)) : (text ?? null);

/** What the person reads when a pairing failed: what happened and what to do, never a protocol word. `account` is who this phone is signed in as. */
export function pairFailure(error: unknown, account?: string | null): string {
  const text = message(error);
  if (text === DECLINED) return "Your computer didn't accept this phone.";
  if (text === OTHER_ACCOUNT) {
    return account
      ? `This computer uses a different MoPilot account. You're signed in as ${account}.`
      : 'This computer uses a different MoPilot account.';
  }
  if (USED.test(text)) return 'That code was already used. Scan the new one.';
  if (text === 'relay: pair_limit') return 'This account has too many connected computers. Remove one in Settings, then scan a new code.';
  if (NEWER.test(text)) return "This phone's MoPilot is too old for this computer. Update it, then scan again.";
  if (OLDER.test(text)) return "This computer's MoPilot is too old. Update MoPilot on it, then scan its new code.";
  if (LAPSED.test(text)) return 'That code expired. Scan the new one.';
  if (FOREIGN.test(text)) return 'That code is for a different MoPilot server.';
  if (UNREADABLE.test(text)) return "That isn't a MoPilot pairing code.";
  if (/^(pair cleanup required|pairing busy|Pair cleanup is in progress)$/.test(text)) return 'Finish or cancel the last pairing first.';
  if (isTransient(error)) return "Can't reach MoPilot. Check your connection and try again.";
  return "Couldn't pair. Try again.";
}

export const timeoutSentence = (ms: number) => `Could not connect within ${Math.round(ms / 1000)} s. The log shows where it stopped.`;

export function pairingSteps(outcome: PairOutcome): PairStep[] {
  if (outcome === 'badCode') return [{ name: 'Code read', state: 'bad', hint: 'Show a new code on your computer.' }];
  const read: PairStep = { name: 'Code read', state: 'ok' };
  if (outcome === 'running') return [read, { name: 'Waiting for the computer', state: 'wait' }];
  if (outcome === 'declined') return [read, { name: 'Waiting for the computer', state: 'bad', hint: 'It was declined on the computer.' }];
  if (outcome === 'otherAccount') return [read, { name: 'Waiting for the computer', state: 'bad', hint: 'Use the same account on both.' }];
  return [read, { name: 'Waiting for the computer', state: 'bad', hint: 'Is it awake and signed in?' }];
}

const MARK = { ok: '✓', bad: '✗', wait: '…' } as const;
export const pairMark = (step: PairStep) => MARK[step.state];

/** Step names and the time spent only: the code, the phone's name and every key stay out. */
export function pairingReport(outcome: PairOutcome, elapsedMs: number): string {
  return [
    'MoPilot pairing report',
    ...pairingSteps(outcome).map((s) => `${MARK[s.state]} ${s.name}${s.hint ? ` — ${s.hint}` : ''}`),
    `Time: ${(elapsedMs / 1000).toFixed(1)} s`,
  ].join('\n');
}
