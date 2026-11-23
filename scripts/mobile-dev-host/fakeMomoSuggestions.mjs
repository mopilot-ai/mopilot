// DEV ONLY: MoMo's suggestions (A7) as the dev host's fake Mac answers them: the Mac's own store (electron/momo/suggestions.cjs, over the in-memory storage seam) and its own Start text (suggestionsIpc.cjs) over made-up suggestions. `on` seeds three (one with a deadline and a person waiting, one a commitment, one low), `empty` has none; `off` is an older Mac that lists neither method (host.mjs hides them). Start sends the first step into MoMo's fake chat as the user's message, as the Mac does, and Add and Hide change the store the same way.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RemoteError } = require('../../electron/remote/serviceErrors.cjs');
const { createSuggestions, memoryStorage } = require('../../electron/momo/suggestions.cjs');
const { startText } = require('../../electron/momo/suggestionsIpc.cjs');
const H = 3_600_000;

/** The made-up ones: a reply a person waits for, a promise the user made, and a low one. */
export const SEEDS = [
  {
    title: 'Reply to Sam about the lease',
    why: 'Sam asked on Monday and the lease ends Friday.',
    source: 'Mail: Sam, Lease renewal',
    step: 'Draft a reply to Sam about the lease',
    from: 'mail',
    ref: 'thread-lease',
    kind: 'reply',
    state: 'm1',
    cost: 'person',
    confidence: 'high',
    dueInH: 30,
  },
  {
    title: 'Send the invoice',
    why: 'You said you would send it today.',
    source: 'Your promise, Tuesday',
    step: 'Find the invoice and draft the email to send it',
    from: 'loop',
    ref: 'loop-invoice',
    kind: 'follow-up',
    state: '',
    cost: 'commitment',
    confidence: 'sure',
    dueInH: 6,
  },
  {
    title: 'Plan Thursday’s offsite',
    why: 'The offsite is on your calendar and nothing is booked.',
    source: 'Calendar: Offsite, Thu 10:00',
    step: 'List what is still open for Thursday’s offsite',
    from: 'calendar',
    ref: 'event-offsite',
    kind: 'prepare',
    state: 't1',
    cost: 'none',
    confidence: 'medium',
    dueInH: 80,
  },
];

/**
 * @param {object} o
 * @param {() => number} o.now
 * @param {(area: 'memory') => void} o.changed tells the phones
 * @param {(text: string) => Promise<unknown>} o.send puts a user message into MoMo's chat
 * @param {() => boolean} o.paused whether MoMo is paused (Start is held then, as on the Mac)
 */
export function createFakeSuggestions({ now, changed, send, paused }) {
  /** @type {ReturnType<typeof createSuggestions>} */
  let store = createSuggestions({ storage: memoryStorage({ now }), now });
  /** Seeds the store with the made-up ones (the day's cap is 3, so all three fit). */
  const seed = async () => {
    store = createSuggestions({ storage: memoryStorage({ now }), now });
    for (const { dueInH, ...s } of SEEDS) await store.add({ ...s, dueAt: now() + dueInH * H });
  };
  return {
    /** `on` (made-up suggestions) or `empty` (none); the phones read again. */
    async setMode(/** @type {'on' | 'empty'} */ mode) {
      if (mode === 'on') await seed();
      else store = createSuggestions({ storage: memoryStorage({ now }), now });
      changed('memory');
    },
    async list() {
      return { v: 1, ...store.list(), now: now() };
    },
    async act(/** @type {string} */ id, /** @type {string} */ action) {
      try {
        const done = await store.act(id, action, async (s) => {
          if (paused()) throw new RemoteError('forbidden', 'MoMo is paused. Resume it first.');
          await send(startText(s));
        });
        changed('memory');
        return { id: done.id, action: done.action, channel: done.item.channel };
      } catch (error) {
        throw error instanceof RemoteError ? error : new RemoteError('failed', /** @type {Error} */ (error).message);
      }
    },
  };
}
