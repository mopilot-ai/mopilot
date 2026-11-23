// The Tasks part of MoMo's page on the classic phone (mobile/src/screens/MomoTasks.tsx, MomoPage.tsx): what needs you and what runs, from the Mac's own list and only where the Mac lists momo.tasks.list; a card opens the chat, a loop opens a page with the user's Done, Snooze and Dismiss (the loop calls), a run only shows; a Mac without the method keeps the old Needs you line; words come from the phone's catalog in both languages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, click, flush } from './support/phone/component-kit';
import { momoRuntime, mountMomo, snapshotOf } from './support/phone/momo-kit';
import { deferred } from './support/async-scenarios.ts';

const i18nPath = '../mobile/src/ui/i18n';
const i18n = await import(i18nPath);
const enPath = '../mobile/src/ui/i18n/locales/en';
const zhPath = '../mobile/src/ui/i18n/locales/zh-Hans';
const en = (await import(enPath)).default;
const zh = (await import(zhPath)).default;

const BASE = ['momo.state.get', 'momo.prefs.get', 'momo.prefs.set'];
const TASKS = [
  { id: 'card:a1', kind: 'card', state: 'needs-you', title: 'Send the mail', detail: 'Mail', dueDay: null, ref: 'a1' },
  { id: 'loop:L1', kind: 'loop', state: 'needs-you', title: 'Call mum', detail: 'call mum', dueDay: '2026-11-04', ref: 'L1' },
  { id: 'loop:L2', kind: 'loop', state: 'needs-you', title: 'Water the plants', detail: null, dueDay: null, ref: 'L2' },
  { id: 'run:c1', kind: 'run', state: 'running', title: 'Daily brief', detail: null, dueDay: null, ref: 'c1' },
];
function page(extra: Record<string, any> = {}, methods = [...BASE, 'momo.tasks.list'], tasks: any = TASKS) {
  return momoRuntime({
    'machine.hello': () => ({ v: 1, capabilities: { momo: true, momoBrainSet: false, methods, permissionCeiling: 'auto-review' } }),
    'momo.chat.follow': () => snapshotOf([{ id: 'k1', rev: 1, title: 'Send it?', choices: [{ key: 'ok', label: 'OK' }] }]),
    'momo.chat.unfollow': () => ({}),
    'momo.brain.get': () => ({ brain: null }),
    'momo.routines.list': () => ({ proposals: [], routines: [] }),
    'momo.sources.status': () => ({ calendar: true, reminders: true }),
    'momo.state.get': () => ({ name: 'Mo', status: 'online', needsYou: 1 }),
    'momo.prefs.get': () => ({ paused: false, proactivity: 'default', quietHours: null, levels: [{ id: 'default' }] }),
    'momo.prefs.set': () => ({ paused: false }),
    'momo.tasks.list': () => ({ tasks, now: 1 }),
    'momo.loops.act': () => ({ loop: {} }),
    ...extra,
  });
}
async function openPage() {
  await flush();
  await click('Mo, MoMo’s page');
}
const label = (name: string) => document.querySelector(`[aria-label="${name}"]`) as HTMLButtonElement | null;
const loopCalls = (m: any) => m.calls.filter(([method]: [string]) => method === 'momo.loops.act').map(([, p]: any) => p);

test('the page lists what needs you, with each task’s grey line, and what is running apart', async () => {
  const m = page();
  const view = await mountMomo(m);
  await openPage();
  assert.match(view.text(), /Needs youSend the mailMailReview›Call mumDue 2026-11-04 · call mum›Water the plants›Running/);
  assert.match(view.text(), /RunningDaily brief/);
  assert.doesNotMatch(view.text(), /waiting for you/);
  assert.equal(label('Daily brief'), null, 'a run is not a button');
  await view.unmount();
});

test('a card opens the chat where it is answered: the page closes and nothing is answered from here', async () => {
  const m = page();
  const view = await mountMomo(m);
  await openPage();
  await click('Send the mail, Review');
  assert.equal(label('Done'), null);
  assert.equal(label('Mo, MoMo’s page') !== null, true, 'back on the chat');
  assert.equal(m.count('momo.card.answer'), 0);
  assert.equal(m.count('momo.loops.act'), 0);
  await view.unmount();
});

test('a loop opens its page: Done, Snooze and Dismiss are the loop’s own calls, and the page reads the list again', async () => {
  const m = page();
  const view = await mountMomo(m);
  await openPage();
  await click('Call mum');
  assert.match(view.text(), /Due 2026-11-04 · call mumDoneSnoozeDismiss/);
  const reads = m.count('momo.tasks.list');
  await click('Done');
  assert.deepEqual(loopCalls(m), [{ loopId: 'L1', action: 'done' }]);
  assert.ok(m.count('momo.tasks.list') > reads, 'read again');
  assert.match(view.text(), /Needs you/, 'back on the page');
  await click('Call mum');
  await click('Snooze');
  await click('Call mum');
  await click('Dismiss');
  assert.deepEqual(loopCalls(m), [
    { loopId: 'L1', action: 'done' },
    { loopId: 'L1', action: 'snooze', snooze: 'day' },
    { loopId: 'L1', action: 'dismiss' },
  ]);
  await view.unmount();
});

test('a loop with no due day or words has no grey line; a second tap while one is working does nothing', async () => {
  const gate = deferred<unknown>();
  const m = page({ 'momo.loops.act': () => gate.promise });
  const view = await mountMomo(m);
  await openPage();
  await click('Water the plants');
  assert.doesNotMatch(view.text(), /Due/);
  await click('Done');
  assert.equal(label('Snooze'), null, 'rows are not buttons while a change is working');
  gate.resolve({ loop: {} });
  await act(async () => gate.promise);
  await flush();
  assert.deepEqual(loopCalls(m), [{ loopId: 'L2', action: 'done' }]);
  await view.unmount();
});

test('a refusal from the Mac is said on the loop’s page, which stays', async () => {
  const m = page({ 'momo.loops.act': () => Promise.reject(new Error('That reminder is no longer open.')) });
  const view = await mountMomo(m);
  await openPage();
  await click('Call mum');
  await click('Done');
  assert.match(view.text(), /That reminder is no longer open\./);
  assert.ok(label('Snooze'));
  await view.unmount();
});

test('nothing waiting says so; no Running group without a run', async () => {
  const m = page({}, undefined, []);
  const view = await mountMomo(m);
  await openPage();
  assert.match(view.text(), /Needs youNothing needs you/);
  assert.doesNotMatch(view.text(), /Running/);
  await view.unmount();
});

test('a Mac without the method, or whose list cannot be read, keeps the Needs you line', async () => {
  const old = page({}, BASE);
  let view = await mountMomo(old);
  await openPage();
  assert.match(view.text(), /Needs you1 waiting for you/);
  assert.equal(old.count('momo.tasks.list'), 0, 'not asked');
  await view.unmount();
  const broken = page({ 'momo.tasks.list': () => Promise.reject(new Error('boom')) });
  view = await mountMomo(broken);
  await openPage();
  assert.match(view.text(), /Needs you1 waiting for you/);
  await view.unmount();
  const junk = page({ 'momo.tasks.list': () => ({ nope: true }) });
  view = await mountMomo(junk);
  await openPage();
  assert.match(view.text(), /Needs you1 waiting for you/);
  await view.unmount();
});

test('the words are in the catalog in both languages, with the same keys, and show in Chinese when chosen', async () => {
  assert.deepEqual(Object.keys(zh.momoTasks), Object.keys(en.momoTasks));
  for (const key of Object.keys(en.momoTasks)) assert.equal(typeof zh.momoTasks[key], 'string', key);
  assert.equal(zh.momoTasks.due.includes('{{day}}'), true);
  assert.equal(en.momoTasks.due.includes('{{day}}'), true);
  const m = page();
  const view = await mountMomo(m);
  try {
    await act(async () => i18n.showLocale('zh-Hans'));
    await openPage();
    assert.match(view.text(), /需要你/);
    assert.match(view.text(), /进行中/);
    assert.match(view.text(), /2026-11-04 到期/);
  } finally {
    await act(async () => i18n.showLocale('en'));
    await view.unmount();
  }
});
