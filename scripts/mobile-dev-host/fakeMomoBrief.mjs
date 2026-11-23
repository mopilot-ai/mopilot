// DEV ONLY: MoMo's morning brief (A7) as the dev host's fake Mac has it: the Scheduled row the Mac derives (electron/momo/tasksPanel.cjs, with the brief's own row shape), and the brief's stack in MoMo's fake chat (a greeting, the one attention item, a lead-in and two suggestion cards, as chat rows the phone reads) written by Try again. `on` shows the row with its next time and writes the brief once; `failed` shows "Couldn't start" with its reason until Try again; `off` is a Mac without the brief (host.mjs hides the method).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RemoteError } = require('../../electron/remote/serviceErrors.cjs');
const H = 3_600_000;
const REASON = 'MoMo’s brain is not signed in.';

/**
 * @param {object} o
 * @param {() => number} o.now
 * @param {() => Promise<string>} o.mainChatId MoMo's fake main chat, made when there is none
 * @param {{ chats: { get: (id: string) => any } }} o.app
 * @param {(area: 'memory' | 'chat') => void} o.changed tells the phones
 * @param {() => Promise<{ suggestions: { id: string, title: string, source: string, status: string }[] }>} o.suggestions the fake store's list
 */
export function createFakeBrief({ now, mainChatId, app, changed, suggestions }) {
  /** @type {'on' | 'off' | 'failed'} */
  let mode = 'off';
  let failure = /** @type {string | null} */ (null);
  let sentOn = /** @type {string | null} */ (null);
  const today = () => new Date(now()).toDateString();
  /** Writes the stack into MoMo's chat. */
  async function write() {
    const chat = app.chats.get(await mainChatId());
    const cards = (await suggestions()).suggestions.filter((s) => s.status === 'new').slice(0, 2);
    const at = now();
    /** @type {{ text: string, suggestion?: object }[]} */
    const rows = [
      { text: 'Good morning, MoMo.' },
      { text: 'Your lease promise is due Friday (Your promise, Tuesday).' },
      ...(cards.length ? [{ text: `I can move ${cards.length} thing${cards.length > 1 ? 's' : ''} forward:` }] : []),
      ...cards.map((c) => ({ text: c.title, suggestion: { id: c.id, title: c.title, source: c.source } })),
    ];
    for (const r of rows) chat.rows.push({ role: 'note', ...r, at, id: `${chat.id}-r${chat.rows.length + 1}` });
    sentOn = today();
    changed('chat');
  }
  return {
    /** `on`, `failed` or `off`; `on` writes the brief once. */
    async setMode(/** @type {'on' | 'off' | 'failed'} */ next) {
      mode = next;
      failure = next === 'failed' ? REASON : null;
      if (next === 'on' && sentOn !== today()) await write();
      changed('memory');
    },
    /** The Scheduled row's data, or null while the brief is off. */
    row: () =>
      mode === 'off'
        ? null
        : { state: /** @type {'failed' | 'scheduled'} */ (failure ? 'failed' : 'scheduled'), nextAt: now() + 20 * H, reason: failure },
    /** Try again: the brief goes out now, once a day. */
    async runNow() {
      if (mode === 'off') throw new RemoteError('failed', 'The morning brief is off.');
      if (sentOn === today()) throw new RemoteError('failed', 'The brief already went out today.');
      await write();
      failure = null;
      changed('memory');
    },
  };
}
