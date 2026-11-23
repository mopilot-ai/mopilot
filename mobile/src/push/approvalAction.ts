// Allow, Deny and Answer from a notification (P5): connect to the Host, send one chat.answer, and replace the notification with the truthful outcome.
import { chatRef } from './chatRef';

export type ApprovalAction = 'allow' | 'deny' | 'answer';
export const ALLOW_ACTION = 'allow';
export const DENY_ACTION = 'deny';
export const ANSWER_ACTION = 'answer';
/** How long the system leaves a background action running. */
export const ACTION_BUDGET_MS = 30_000;

/** What opening the push's sealed blob told the phone: which enrollment it belongs to and which card it names. */
export interface OpenedPush {
  pairId: string;
  requestId: string;
  machine: string;
  /** `summary.tool` of the card; delete and fetch open the app instead of acting from the lock screen. */
  tool: string;
  question: boolean;
}

export interface PendingCard {
  chatId: string;
  epoch: number;
  requestId: string;
  options: { optionId: string; kind: string }[];
}

/** The slice of the phone's Host client (shared/remote/phoneHost.mjs) this needs. */
export interface HostClient {
  pending(): Promise<{ cards: PendingCard[] }>;
  answer(p: { chatId: string; epoch: number; requestId: string; optionId: string; key: string }): Promise<unknown>;
}

export type Outcome =
  | { kind: 'allowed' | 'denied'; text: string }
  | { kind: 'answered'; text: string }
  | { kind: 'moved'; text: string }
  | { kind: 'unreachable'; text: string }
  /** The action could not be done from here: the notification stays and a tap opens the app on the card. */
  | { kind: 'open'; text: string }
  /** Face ID or the passcode was cancelled: nothing was sent and nothing changes. */
  | { kind: 'cancelled'; text: '' };

export interface Deps {
  /** The sealed blob opened under the phone's card keys; null keeps the fixed title and the action opens the app. */
  open(ref: string, sealed: string | undefined): OpenedPush | null;
  /** Face ID or the passcode; false when the person cancelled or it failed. */
  authenticate(reason: string): Promise<boolean>;
  connect(pairId: string): Promise<HostClient>;
  /** Replace the notification the person acted on (same identifier) with this text. */
  replace(text: string): Promise<void>;
  /** One key per tap, reused by any retry of it. */
  mintKey(): string;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(timer: unknown): void;
  budgetMs?: number;
}

const copy = {
  allowed: (m: string) => `Allowed on ${m}`,
  denied: (m: string) => `Denied on ${m}`,
  answered: (by: string) => `Already answered on ${by}.`,
  moved: () => 'This chat moved to another machine.',
  unreachable: (m: string) => `Couldn't reach ${m}. Tap to try again.`,
  open: (m: string) => `Open MoPilot to review this on ${m}.`,
};

const refusal = (e: unknown) => {
  const x = e as { code?: unknown; details?: { by?: { name?: unknown } } } | null;
  return {
    code: typeof x?.code === 'string' ? x.code : '',
    by: typeof x?.details?.by?.name === 'string' ? x.details.by.name : 'another device',
  };
};

/**
 * Runs one action. Exactly one chat.answer is sent, and only after the device authenticated for Allow; a card that is gone or answered says so,
 * and a Host that does not reply inside the background window leaves the card answerable and says so.
 */
export async function runApprovalAction(action: ApprovalAction, ref: string, sealed: string | undefined, d: Deps): Promise<Outcome> {
  const opened = d.open(ref, sealed);
  const finish = async (o: Outcome) => {
    if (o.kind !== 'cancelled') await d.replace(o.text).catch(() => undefined);
    return o;
  };
  // a blob that does not open, a question (it needs its form) and a delete or network action all open the app
  if (!opened) return { kind: 'open', text: '' };
  if (action === 'answer' || opened.question || (action === 'allow' && (opened.tool === 'delete' || opened.tool === 'fetch')))
    return finish({ kind: 'open', text: copy.open(opened.machine) });
  if (action === 'allow' && !(await d.authenticate(`Allow on ${opened.machine}`))) return { kind: 'cancelled', text: '' };
  const set = d.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clear = d.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let timer: unknown;
  const out = await Promise.race([
    send(action, ref, opened, d),
    new Promise<Outcome>((resolve) => {
      timer = set(() => resolve({ kind: 'unreachable', text: copy.unreachable(opened.machine) }), d.budgetMs ?? ACTION_BUDGET_MS);
    }),
  ]);
  clear(timer);
  return finish(out);
}

async function send(action: ApprovalAction, ref: string, o: OpenedPush, d: Deps): Promise<Outcome> {
  try {
    const host = await d.connect(o.pairId);
    const { cards } = await host.pending();
    const card = cards.find((c) => c.requestId === o.requestId && chatRef(o.pairId, c.chatId) === ref);
    if (!card) return { kind: 'answered', text: copy.answered('another device') };
    const want = action === 'allow' ? 'allow' : 'reject';
    const option = card.options.find((x) => x.kind.startsWith(want));
    if (!option) return { kind: 'open', text: copy.open(o.machine) };
    await host.answer({ chatId: card.chatId, epoch: card.epoch, requestId: card.requestId, optionId: option.optionId, key: d.mintKey() });
    return action === 'allow' ? { kind: 'allowed', text: copy.allowed(o.machine) } : { kind: 'denied', text: copy.denied(o.machine) };
  } catch (e) {
    const { code, by } = refusal(e);
    if (code === 'card_answered') return { kind: 'answered', text: copy.answered(by) };
    if (code === 'stale_epoch') return { kind: 'moved', text: copy.moved() };
    return { kind: 'unreachable', text: copy.unreachable(o.machine) };
  }
}
