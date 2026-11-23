// The MoMo tab for the Mac's connect flow: a connect card waits as "finish on your Mac" and clears when the Mac connects or says Not now, and the first run with nothing connected says where to connect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, flush } from './support/phone/component-kit';
import { hello, momoRuntime, mountMomo, snapshotOf } from './support/phone/momo-kit';

const FIRST_RUN = /Connect Calendar and Reminders on your Mac in Settings > MoMo > Sources\./;
const connectCard = { id: 'c1', title: 'MoMo needs Calendar. Allow it on your Mac.', inApp: true };
const base = (sources: () => unknown, cards: any[] = []) => ({
  'machine.hello': () => hello(true),
  'momo.brain.get': () => ({ brain: null }),
  'momo.routines.list': () => ({ proposals: [], routines: [] }),
  'momo.sources.status': sources,
  'momo.chat.follow': () => snapshotOf(cards),
  'momo.chat.unfollow': () => ({}),
});
const patch = (cards: any[]) => ({ kind: 'event', chatId: 'main', ev: 'session.patch', rev: 2, feedSeq: 1, patch: { cards } });

test('a connect card waits in Needs you with no choices and goes without a trace when the Mac connects or the user says Not now', async () => {
  const m = momoRuntime(base(() => ({ calendar: false, reminders: false }), [connectCard]));
  const view = await mountMomo(m);
  // a card only the Mac can finish is in the chat, uncounted by the pill
  assert.doesNotMatch(view.text(), /needs? you/);
  assert.match(view.text(), /MoMo needs Calendar\. Allow it on your Mac\.[\s\S]*Finish on your Mac/);
  assert.equal(
    [...document.querySelectorAll('button')].filter((b) => /Connect|Not now|Allow/.test(b.textContent ?? '')).length,
    0,
    'the phone offers nothing to press',
  );
  // connected, or Not now on the Mac: the card is gone and nothing says it was answered
  await act(async () => m.emit(patch([])));
  assert.doesNotMatch(view.text(), /MoMo needs Calendar/);
  assert.doesNotMatch(view.text(), /Answered on your Mac/);
  await view.unmount();
});

test('the first run with nothing connected says where to connect, read-only, and clears when the Mac connects', async () => {
  let status: any = { calendar: false, reminders: false };
  const m = momoRuntime(base(() => status));
  const view = await mountMomo(m);
  assert.match(view.text(), FIRST_RUN);
  assert.equal([...document.querySelectorAll('button')].filter((b) => /Connect/.test(b.textContent ?? '')).length, 0);
  status = { calendar: true, reminders: false };
  await act(async () => m.emit({ kind: 'event', ev: 'momo.changed', area: 'sources' }));
  await flush();
  assert.doesNotMatch(view.text(), FIRST_RUN);
  assert.equal(m.count('momo.sources.status'), 2);
  await view.unmount();
});

test('no first-run line while the status is unread, failed or the Mac is away', async () => {
  const failing = momoRuntime(base(() => Promise.reject(new Error('boom'))));
  const a = await mountMomo(failing);
  assert.doesNotMatch(a.text(), FIRST_RUN);
  await a.unmount();
  const away = momoRuntime(
    base(() => ({ calendar: false, reminders: false })),
    { phase: 'offline' },
  );
  const b = await mountMomo(away);
  assert.doesNotMatch(b.text(), FIRST_RUN);
  assert.equal(away.count('momo.sources.status'), 0);
  await b.unmount();
});

test('a status that is not two flags is unreadable and shows no first-run line', async () => {
  const m = momoRuntime(base(() => ({ calendar: 'yes' })));
  const view = await mountMomo(m);
  assert.doesNotMatch(view.text(), FIRST_RUN);
  assert.equal(m.count('momo.sources.status'), 1);
  await view.unmount();
});
