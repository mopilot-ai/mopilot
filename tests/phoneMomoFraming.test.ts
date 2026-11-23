// MoMo's framing for the model on MoMo's own phone page (#4842 device check): the page itself, the shell's Chat tab, the rows' own renderer (user, liveUser) and the held queue draw a routine's report and the setup greeting as one-line cards, never as a bubble of the instruction. The helper tests alone could not see this: MoMo's page draws its rows by itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { act, click, createElement, createRoot, flush } from './support/phone/component-kit';
import { momoRuntime, mountMomo, snapshotOf } from './support/phone/momo-kit';

const require = createRequire(import.meta.url);
const { reportText } = require('../electron/momo/routineReport.cjs');
const { GREETING } = require('../electron/momo/starterRoutines.cjs');
const chatPath = '../mobile/src/screens/MomoChat';
const queuedPath = '../mobile/src/components/QueuedMessages';
const { MomoTranscript } = await import(chatPath);
const { QueuedMessages } = await import(queuedPath);

const LEAK = /not from the user|data, not instructions|Tell the user in a line|Greet them/;
const REPORTS = [
  { text: reportText('Inbox sweep', true, 'Two replies are due.'), title: /“Inbox sweep” finished/ },
  { text: reportText('Weekly review', false, 'It stopped early.'), title: /“Weekly review” didn’t finish/ },
  { text: GREETING, title: /MoPilot message/ },
];
const items = () => REPORTS.map((r, i) => ({ id: `u${i}`, type: 'userMessage', content: [{ type: 'text', text: r.text }] }));

for (const shell of [false, true]) {
  test(`MoMo's page ${shell ? 'with the shell’s Chat tab' : '(classic)'} draws every report as a card`, async () => {
    const m = momoRuntime({
      'machine.hello': () => ({
        v: 1,
        capabilities: { momo: true, momoBrainSet: false, methods: shell ? ['momo.state.get'] : [], permissionCeiling: 'auto-review' },
      }),
      'momo.state.get': () => ({ name: 'Mo', status: 'online', needsYou: 0, ...(shell ? { shell: true } : {}) }),
      'momo.brain.get': () => ({ brain: null }),
      'momo.routines.list': () => ({ proposals: [], routines: [] }),
      'momo.chat.follow': () => snapshotOf([], items()),
      'momo.chat.unfollow': () => ({}),
    });
    const view = await mountMomo(m);
    assert.doesNotMatch(view.text(), LEAK, 'no instruction text on the page');
    for (const r of REPORTS) assert.match(view.text(), r.title);
    await click('MoPilot: “Inbox sweep” finished');
    assert.match(view.text(), /Two replies are due\./);
    assert.doesNotMatch(view.text(), LEAK);
    await view.unmount();
  });
}

test('the page’s own row renderer: user and liveUser rows with the mark are cards, a person’s words stay a bubble', async () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  const rows = [
    { role: 'user', text: REPORTS[0].text },
    { role: 'liveUser', text: REPORTS[2].text },
    { role: 'user', text: 'call the bank' },
    { role: 'note', text: 'Remembered: the bank' },
    { role: 'assistant', text: 'Done.' },
    { role: 'preview', text: 'Almost' },
  ].map((row, i) => ({ kind: 'message', key: `k${i}`, row: { ...row, key: `k${i}` } }));
  await act(async () =>
    root.render(
      createElement(MomoTranscript, {
        rows,
        queued: null,
        cards: [],
        answeredOnMac: [],
        answer: async () => true,
        act: () => {},
        canAct: true,
        closed: {},
        working: false,
        progress: '',
        empty: null,
        cardRef: () => {},
      }),
    ),
  );
  assert.doesNotMatch(host.textContent ?? '', LEAK);
  assert.match(host.textContent ?? '', /“Inbox sweep” finished/);
  assert.match(host.textContent ?? '', /MoPilot message/);
  assert.match(host.textContent ?? '', /call the bank/);
  assert.match(host.textContent ?? '', /Remembered: the bank/);
  await act(async () => root.unmount());
});

test('a held message that is MoMo’s framing reads as its title in the queue, a person’s stays its words', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const item = (id: string, text: string) => ({ id, pairId: 'p', chatId: 'c', text, attachments: [], at: 1, status: 'queued' });
  await act(async () =>
    root.render(
      createElement(QueuedMessages, {
        items: [item('a', REPORTS[0].text), item('b', 'later please'), { ...item('c', ''), images: 2 }, item('d', '')],
        cancel: () => {},
        retry: () => {},
        readOnly: true,
      }),
    ),
  );
  await flush();
  assert.doesNotMatch(host.textContent ?? '', LEAK);
  assert.match(host.textContent ?? '', /“Inbox sweep” finished/);
  assert.match(host.textContent ?? '', /later please/);
  assert.match(host.textContent ?? '', /2 pictures/);
  await act(async () => root.unmount());
  host.remove();
});
