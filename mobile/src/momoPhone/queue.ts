// The held-message queue as one pure state machine: every event the phone can see (a tap, a write, an answer, a kill) turns the state into the next one plus the effects to run. No clock, no storage, no network: the store only carries out the effects and feeds back what happened. The rules it keeps: a message the person sent is on the phone before anything else happens to it; the doubt is on the phone before the send leaves; a message is sent again only under its own id and only after the home said it never had it; nothing is dropped without the person being told.
// Known and left as they are, both on the safe side: a message returned to the composer as not kept can come back after a restart when its failed write had landed and the one clean-up write also failed (never lost, never sent twice by the phone alone), and a failed arm write's "not sure" can ride on the next write, so a message that never left reads as not sure after a restart (Check again clears it).
import type { LocalTurn } from './types';

/** A held message and what is being done to it now. One message is saved at a time: `hold` waits behind the one being saved, so no write ever overwrites another's. */
export type QTurn = LocalTurn & { op?: 'hold' | 'save' | 'arm' | 'send' | 'check' };

/** Whether what the phone kept can be written: not yet read, readable, or kept but unreadable (never written over). */
export type Disk = 'unread' | 'ok' | 'unreadable';

export type QState = {
  turns: QTurn[];
  disk: Disk;
  /** What the last successful write put on the phone. */
  image: LocalTurn[];
  /** A write for the next send failed: nothing is armed again until the person asks. */
  blocked: boolean;
  /** The home is running: a message is armed and sent only then. */
  running: boolean;
};

export type QEvent =
  | { t: 'load'; read: 'none' | 'unreadable' | 'ok'; turns?: LocalTurn[] }
  | { t: 'discard' }
  | { t: 'submit'; id: string; text: string; at: number }
  /** The home marked a turn of this phone as never arrived: it may be sent again once the person says so. */
  | { t: 'adopt'; id: string; text: string; at: number }
  | { t: 'wrote'; id: string | null; ok: boolean; image: LocalTurn[] }
  | { t: 'sent'; id: string; answer: 'accepted' | 'refused' | 'unanswered' }
  | { t: 'check'; id: string }
  | { t: 'checked'; id: string; answer: 'has' | 'missing' | 'unavailable' }
  | { t: 'resend'; id: string }
  | { t: 'retry' }
  | { t: 'home'; running: boolean }
  | { t: 'listed'; ids: readonly string[] }
  /** Sign-out, an unpaired computer, a computer that says it is not a home: the one way held messages are let go. */
  | { t: 'forget' };

export type QEffect =
  | { t: 'write'; id: string | null; image: LocalTurn[] }
  | { t: 'send'; id: string; text: string }
  | { t: 'check'; id: string }
  /** The message did not go: its text goes back to the composer. */
  | { t: 'reject'; id: string; text: string }
  /** `again`: the person can ask for the same step to be tried again. */
  | { t: 'tell'; why: 'keep' | 'lost'; again?: true };

export const start = (disk: Disk = 'unread'): QState => ({ turns: [], disk, image: [], blocked: false, running: false });

/** What every write holds: each held message that is being saved or already on the phone; one waiting its turn to be saved is not in any. */
export function imageOf(turns: readonly QTurn[]): LocalTurn[] {
  return turns
    .filter((t) => t.delivery !== 'accepted' && t.op !== 'hold')
    .map(({ id, text, at, delivery }) => ({ id, text, at, delivery }));
}

const strip = (t: QTurn): QTurn => {
  const { op: _op, ...rest } = t;
  return rest;
};

type Out = { state: QState; effects: QEffect[] };

/** Arms the oldest queued message when nothing else is in doubt or on its way. */
function pump(s: QState, effects: QEffect[]): Out {
  if (s.disk !== 'ok' || s.blocked || !s.running || s.turns.some((t) => t.delivery === 'not-sure' || t.op === 'save' || t.op === 'hold'))
    return { state: s, effects };
  const next = s.turns.find((t) => t.delivery === 'queued');
  if (!next || next.op) return { state: s, effects };
  const turns = s.turns.map((t) => (t.id === next.id ? { ...t, delivery: 'not-sure' as const, check: undefined, op: 'arm' as const } : t));
  return { state: { ...s, turns }, effects: [...effects, { t: 'write', id: next.id, image: imageOf(turns) }] };
}

const patch = (s: QState, id: string, change: Partial<QTurn>): QState => ({
  ...s,
  turns: s.turns.map((t) => (t.id === id ? { ...t, ...change } : t)),
});
const write = (s: QState, effects: QEffect[]): QEffect[] => [...effects, { t: 'write', id: null, image: imageOf(s.turns) }];

/** The next message waiting to be saved is saved once the one before it is on the phone (or was refused). */
function promote(out: Out): Out {
  const { state } = out;
  const next = state.turns.find((t) => t.op === 'hold');
  if (!next || state.turns.some((t) => t.op === 'save')) return out;
  const turns = state.turns.map((t) => (t.id === next.id ? { ...t, op: 'save' as const } : t));
  return { state: { ...state, turns }, effects: [...out.effects, { t: 'write', id: next.id, image: imageOf(turns) }] };
}

export function step(s: QState, e: QEvent): Out {
  const out = promote(reduce(s, e));
  return pump(out.state, out.effects);
}

function reduce(s: QState, e: QEvent): Out {
  const none: QEffect[] = [];
  const has = (id: string) => s.turns.find((t) => t.id === id);
  switch (e.t) {
    case 'load': {
      if (e.read === 'unreadable') return { state: { ...s, disk: 'unreadable' }, effects: [{ t: 'tell', why: 'lost' }] };
      // nothing is taken before what was kept has been read, so nothing is held here yet
      const kept = e.turns ?? [];
      return { state: { ...s, disk: 'ok', turns: kept.map((t) => ({ ...t })), image: kept }, effects: none };
    }
    case 'discard':
      return { state: { ...s, disk: 'ok', image: [] }, effects: none };
    case 'submit':
    case 'adopt': {
      if (s.disk !== 'ok' || has(e.id)) {
        // nothing can be kept, so nothing is sent: the text stays with the person
        return has(e.id)
          ? { state: s, effects: none }
          : {
              state: s,
              effects: [
                { t: 'reject', id: e.id, text: e.text },
                { t: 'tell', why: s.disk === 'unreadable' ? 'lost' : 'keep' },
              ],
            };
      }
      // saved at once when nothing is being saved; otherwise promoted when the one before it is done
      const turn: QTurn = { id: e.id, text: e.text, at: e.at, delivery: 'queued', op: 'hold' };
      return { state: { ...s, blocked: false, turns: [...s.turns, turn] }, effects: none };
    }
    case 'wrote': {
      const ok = e.ok ? { ...s, image: e.image } : s;
      const turn = e.id ? has(e.id) : undefined;
      if (turn?.op !== 'save' && turn?.op !== 'arm') return { state: ok, effects: none };
      if (turn.op === 'save') {
        if (e.ok) return { state: patch(ok, turn.id, { op: undefined }), effects: none };
        // a message that was refused is taken off the phone again, in case another write carried it there
        const state = { ...ok, turns: ok.turns.filter((t) => t.id !== turn.id) };
        return {
          state,
          effects: write(state, [
            { t: 'reject', id: turn.id, text: turn.text },
            { t: 'tell', why: 'keep' },
          ]),
        };
      }
      // arm: the doubt is on the phone only when this write worked
      if (e.ok) {
        // the home may have gone to sleep while the doubt was being written: nothing leaves, the message waits again (the phone holding it as in doubt is the safe side)
        if (!ok.running) {
          const state = patch(ok, turn.id, { delivery: 'queued', op: undefined });
          return { state, effects: write(state, none) };
        }
        return { state: patch(ok, turn.id, { op: 'send' }), effects: [{ t: 'send', id: turn.id, text: turn.text }] };
      }
      return {
        state: { ...patch(ok, turn.id, { delivery: 'queued', op: undefined }), blocked: true },
        effects: [{ t: 'tell', why: 'keep', again: true }],
      };
    }
    case 'sent': {
      const turn = has(e.id);
      if (!turn || turn.op !== 'send') return { state: s, effects: none };
      if (e.answer === 'unanswered') return { state: patch(s, e.id, { op: undefined }), effects: none };
      const state = patch(s, e.id, { op: undefined, delivery: e.answer === 'accepted' ? 'accepted' : 'never-got-it' });
      return { state, effects: write(state, none) };
    }
    case 'check': {
      const turn = has(e.id);
      if (!turn || turn.op || (turn.delivery !== 'not-sure' && turn.delivery !== 'never-got-it')) return { state: s, effects: none };
      return { state: patch(s, e.id, { op: 'check' }), effects: [{ t: 'check', id: e.id }] };
    }
    case 'checked': {
      const turn = has(e.id);
      if (!turn || turn.op !== 'check') return { state: s, effects: none };
      if (e.answer === 'unavailable') return { state: patch(s, e.id, { op: undefined, check: 'unavailable' }), effects: none };
      const state = patch(s, e.id, { op: undefined, check: undefined, delivery: e.answer === 'has' ? 'accepted' : 'never-got-it' });
      return { state, effects: write(state, none) };
    }
    case 'resend': {
      const turn = has(e.id);
      if (!turn || turn.op || turn.delivery !== 'never-got-it' || s.disk !== 'ok') return { state: s, effects: none };
      const state = { ...patch(s, e.id, { delivery: 'queued' }), blocked: false };
      return { state, effects: write(state, none) };
    }
    case 'retry':
      return { state: { ...s, blocked: false }, effects: none };
    case 'home':
      return { state: { ...s, running: e.running }, effects: none };
    case 'listed': {
      const known = new Set(e.ids);
      const turns = s.turns.filter((t) => !known.has(t.id) || t.op === 'save' || t.op === 'hold');
      if (turns.length === s.turns.length) return { state: s, effects: none };
      const state = { ...s, turns };
      return { state, effects: write(state, none) };
    }
    case 'forget':
      return { state: { ...s, turns: [], image: [], blocked: false }, effects: none };
  }
}

/** What a phone that was killed and opened again holds: what the last successful write put there, nothing in flight. */
export const restore = (s: QState): QState => ({
  ...start('ok'),
  running: s.running,
  turns: s.image.map((t) => ({ ...t })),
  image: s.image,
});

/** The held messages as the screens see them. */
export const publicTurns = (s: QState): LocalTurn[] => s.turns.map(strip);
