// MoMo's replies on the phone go through the one Markdown renderer every transcript uses, so bold beside CJK text is bold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hello, momoRuntime, mountMomo, snapshotOf } from './support/phone/momo-kit';

const REPLY = '**Morning briefing** 和 **Bill reminders**，**粗体**文字';

test('MoMo’s reply is rendered as Markdown: bold next to CJK text is bold, never raw ** markers (#4823)', async () => {
  const m = momoRuntime({
    'machine.hello': () => hello(true),
    'momo.brain.get': () => ({ brain: null }),
    'momo.routines.list': () => ({ proposals: [], routines: [] }),
    'momo.chat.follow': () => snapshotOf([], [{ id: 'a1', type: 'agentMessage', text: REPLY }]),
    'momo.chat.unfollow': () => ({}),
  });
  const view = await mountMomo(m);
  assert.doesNotMatch(view.text(), /\*\*/, 'no raw markers on MoMo’s page');
  for (const word of ['Morning briefing', 'Bill reminders', '粗体']) {
    const bold = [...view.host.querySelectorAll('span')].filter((n) => n.textContent === word).at(-1);
    assert.equal(JSON.parse(bold?.getAttribute('data-style') ?? '{}').fontWeight, '600', `${word} is bold`);
  }
  await view.unmount();
});

test('a reply still being written (a preview row) is rendered as Markdown too', async () => {
  const chatPath = '../mobile/src/screens/MomoChat';
  const { MomoTranscript } = await import(chatPath);
  const { createElement, createRoot, act } = await import('./support/phone/component-kit');
  const host = document.createElement('div');
  const root = createRoot(host);
  const row = { role: 'preview', text: 'Almost **there**', key: 'live' };
  await act(async () =>
    root.render(
      createElement(MomoTranscript, {
        rows: [{ kind: 'message', key: 'live', row }],
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
  assert.doesNotMatch(host.textContent!, /\*\*/);
  assert.match(host.textContent!, /Almost there/);
  await act(async () => root.unmount());
});
