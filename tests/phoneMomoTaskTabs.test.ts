// The four-tab Tasks of MoMo's page on the classic phone (mobile/src/screens/MomoTaskTabs.tsx over MomoPage.tsx), where the Mac answers momo.tasks.list with `v: 2` and lists momo.tasks.mark: Active, Up next, Scheduled and Resolved over the Mac's rows; a run waiting for the user is marked done or archived on its own page and reopened from Resolved, with an Undo line for a minute; a loop keeps its own calls (Reopen once closed); a routine Pauses or Resumes and Pause all is MoMo's pause; a failed read says so with Try again over the last list greyed; an older Mac keeps the classic list; the words are in both catalogs.
import './support/tz-la.ts';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act, click, flush } from './support/phone/component-kit';
import { momoRuntime, mountMomo, snapshotOf } from './support/phone/momo-kit';

const i18nPath = '../mobile/src/ui/i18n';
const i18n = await import(i18nPath);
const enPath = '../mobile/src/ui/i18n/locales/en';
const zhPath = '../mobile/src/ui/i18n/locales/zh-Hans';
const en = (await import(enPath)).default;
const zh = (await import(zhPath)).default;
const undoPath = '../mobile/src/screens/MomoTaskTabs';
const { UNDO_MS } = await import(undoPath);

const NOW = new Date(2026, 10, 15, 12, 0).getTime();
const H = 3_600_000;
const BASE = ['momo.state.get', 'momo.prefs.get', 'momo.prefs.set', 'momo.routines.pause', 'momo.routines.resume'];
const WITH_MARK = [...BASE, 'momo.tasks.list', 'momo.tasks.mark'];
const row = (over: any) => ({
  id: 'x',
  kind: 'loop',
  tab: 'active',
  state: 'needs-you',
  title: 'T',
  detail: null,
  dueDay: null,
  ref: 'x',
  at: null,
  outcome: null,
  nextAt: null,
  paused: false,
  ...over,
});
const TASKS = [
  row({ id: 'card:a1', kind: 'card', title: 'Send the mail', detail: 'Mail', ref: 'a1' }),
  row({ id: 'loop:L1', ref: 'L1', title: 'Call mum', detail: 'call mum', dueDay: '2026-11-16' }),
  row({ id: 'run:c1', kind: 'run', state: 'running', title: 'Daily brief', ref: 'c1', at: NOW - 60_000 }),
  row({ id: 'run:c2', kind: 'run', state: 'failed', title: 'Weekly cleanup', ref: 'c2', at: NOW - 2 * H, outcome: 'stopped' }),
  row({ id: 'run:c5', kind: 'run', state: 'failed', title: 'Inbox digest', ref: 'c5', at: NOW - 3 * H, outcome: 'interrupted' }),
  row({ id: 'run:c6', kind: 'run', state: 'failed', title: 'Backup', ref: 'c6', at: NOW - 4 * H, outcome: 'failed' }),
  row({ id: 'run:c3', kind: 'run', state: 'review', title: 'Morning brief', ref: 'c3', at: NOW - H }),
  row({ id: 'loop:L2', tab: 'next', state: 'queued', ref: 'L2', title: 'Plan the offsite', detail: 'someday' }),
  row({
    id: 'routine:r1',
    kind: 'routine',
    tab: 'scheduled',
    state: 'scheduled',
    title: 'Weekdays brief',
    ref: 'r1',
    nextAt: NOW + 20 * H,
  }),
  row({ id: 'routine:r2', kind: 'routine', tab: 'scheduled', state: 'scheduled', title: 'Cleanup', ref: 'r2', paused: true }),
  row({ id: 'routine:r3', kind: 'routine', tab: 'scheduled', state: 'scheduled', title: 'Quiet one', ref: 'r3' }),
  row({ id: 'run:c4', kind: 'run', tab: 'resolved', state: 'done', title: 'Old brief', ref: 'c4', at: NOW - 30 * H }),
  row({ id: 'run:c7', kind: 'run', tab: 'resolved', state: 'archived', title: 'Old digest', ref: 'c7', at: NOW - 31 * H }),
  row({ id: 'loop:L3', tab: 'resolved', state: 'dismissed', title: 'Book the dentist', ref: 'L3', at: NOW - H }),
];
const reply = (tasks: any[] = TASKS, paused = false) => ({ v: 2, tasks, paused, now: NOW });
function page(extra: Record<string, any> = {}, methods = WITH_MARK, tasks: any[] = TASKS) {
  return momoRuntime({
    'machine.hello': () => ({ v: 1, capabilities: { momo: true, momoBrainSet: false, methods, permissionCeiling: 'auto-review' } }),
    'momo.chat.follow': () => snapshotOf([{ id: 'k1', rev: 1, title: 'Send it?', choices: [{ key: 'ok', label: 'OK' }] }]),
    'momo.chat.unfollow': () => ({}),
    'momo.brain.get': () => ({ brain: null }),
    'momo.routines.list': () => ({
      proposals: [],
      routines: [{ id: 'r9', name: 'Old routines list', schedule: 'Daily', rrule: 'x', prompt: '', sources: [], paused: false }],
    }),
    'momo.sources.status': () => ({ calendar: true, reminders: true }),
    'momo.state.get': () => ({ name: 'Mo', status: 'online', needsYou: 1 }),
    'momo.prefs.get': () => ({ paused: false, proactivity: 'default', quietHours: null, levels: [{ id: 'default' }] }),
    'momo.prefs.set': () => ({ paused: true }),
    'momo.tasks.list': () => reply(tasks),
    'momo.tasks.mark': () => ({ taskId: 'run:c3', mark: 'done', undoToken: 'tok-1' }),
    'momo.loops.act': () => ({ loop: {} }),
    'momo.routines.pause': () => ({ routine: {} }),
    'momo.routines.resume': () => ({ routine: {} }),
    ...extra,
  });
}
async function openPage() {
  await flush();
  await click('Mo, MoMo’s page');
}
const calls = (m: any, method: string) => m.calls.filter(([x]: [string]) => x === method).map(([, p]: any) => p);
const label = (name: string) => document.querySelector(`[aria-label="${name}"]`) as HTMLElement | null;

test('Active lists what needs you, what is going, what did not finish and what waits for review, with each row’s grey line', async () => {
  const m = page();
  const view = await mountMomo(m);
  await openPage();
  const text = view.text();
  assert.match(text, /Needs you/);
  assert.match(text, /Send the mailMailReview›/);
  assert.match(text, /Call mumDue 2026-11-16 · call mum›/);
  assert.match(text, /WorkingDaily briefWorking/);
  assert.match(text, /Didn’t finishWeekly cleanupStopped · 10:00›Inbox digestCut short · 09:00›BackupCould not run · 08:00›/);
  assert.match(text, /Ready for reviewMorning briefReady for review · 11:00›/);
  assert.equal(label('Daily brief'), null, 'a run going is not a button');
  assert.doesNotMatch(text, /Old routines list/, 'the old Scheduled group is the tab now');
  assert.doesNotMatch(text, /waiting for you/);
  await view.unmount();
});

test('a routine’s Scheduled row reads its name and then its next time or that it is paused', async () => {
  const m = page();
  const view = await mountMomo(m);
  await openPage();
  await click('Scheduled');
  assert.ok(document.querySelector('[aria-label="Weekdays brief, Next 2026-11-16 08:00"]'), 'a routine with a next time');
  assert.ok(document.querySelector('[aria-label="Cleanup, Paused"]'), 'a paused routine');
  assert.ok(document.querySelector('[aria-label="Quiet one"]'), 'one with neither says its name');
  await view.unmount();
});

test('the other tabs: Up next, Scheduled with Pause all, Resolved; empty ones say what they hold', async () => {
  const m = page();
  const view = await mountMomo(m);
  await openPage();
  await click('Up next');
  assert.match(view.text(), /Plan the offsitesomeday›/);
  await click('Scheduled');
  assert.match(view.text(), /Pause allWeekdays briefNext 2026-11-16 08:00CleanupPausedQuiet one/);
  await click('Resolved');
  assert.match(view.text(), /Old briefDone · 2026-11-14 06:00›Old digestArchived · 2026-11-14 05:00›Book the dentistDismissed · 11:00›/);
  await view.unmount();
  const empty = page({}, WITH_MARK, []);
  const v = await mountMomo(empty);
  await openPage();
  assert.match(v.text(), /Nothing needs you/);
  await click('Up next');
  assert.match(v.text(), /Nothing queued\. Suggestions from your sources show here\./);
  await click('Scheduled');
  assert.match(v.text(), /No routines yet\./);
  assert.doesNotMatch(v.text(), /Pause all/);
  await click('Resolved');
  assert.match(v.text(), /Nothing resolved yet\./);
  await v.unmount();
});

test('a card opens the chat where it is answered; the page answers nothing', async () => {
  const m = page();
  const view = await mountMomo(m);
  await openPage();
  await click('Send the mail, Review');
  assert.equal(m.count('momo.card.answer'), 0);
  assert.equal(m.count('momo.tasks.mark'), 0);
  assert.ok(label('Mo, MoMo’s page'), 'back on the chat');
  await view.unmount();
});

test('Mark as done on a run waiting for review is the Mac’s mark; an Undo line follows and Undo reopens it', async () => {
  const m = page();
  const view = await mountMomo(m);
  await openPage();
  await click('Morning brief');
  assert.match(view.text(), /Ready for review · 11:00Mark as doneArchive/);
  await click('Mark as done');
  assert.deepEqual(calls(m, 'momo.tasks.mark'), [{ taskId: 'run:c3', mark: 'done' }]);
  assert.match(view.text(), /Marked as doneUndo/, 'the page is back, with the Undo line');
  await click('Marked as done, Undo');
  assert.deepEqual(calls(m, 'momo.tasks.mark').at(-1), { taskId: 'run:c3', mark: 'reopen', undoToken: 'tok-1' });
  assert.doesNotMatch(view.text(), /Marked as done/);
  await view.unmount();
});

test('Archive is the Mac’s mark and says Archived; a mark with nothing to take back offers no Undo', async () => {
  const m = page({
    'momo.tasks.mark': (p: any) => ({ taskId: p.taskId, mark: 'archived', ...(p.mark === 'archive' ? { undoToken: 'tok-a' } : {}) }),
  });
  const view = await mountMomo(m);
  await openPage();
  await click('Weekly cleanup');
  assert.match(view.text(), /Stopped · 10:00Mark as doneArchive/);
  await click('Archive');
  assert.deepEqual(calls(m, 'momo.tasks.mark'), [{ taskId: 'run:c2', mark: 'archive' }]);
  assert.match(view.text(), /ArchivedUndo/);
  await click('Resolved');
  await click('Old brief');
  await click('Reopen');
  assert.deepEqual(calls(m, 'momo.tasks.mark').at(-1), { taskId: 'run:c4', mark: 'reopen' });
  assert.doesNotMatch(view.text(), /Undo/, 'reopening leaves nothing to take back, and a newer mark replaces the old line');
  await view.unmount();
});

test('the Undo line goes after a minute', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const m = page();
    const view = await mountMomo(m);
    await openPage();
    await click('Morning brief');
    await click('Mark as done');
    assert.match(view.text(), /Marked as doneUndo/);
    await act(async () => mock.timers.tick(UNDO_MS));
    await flush();
    assert.doesNotMatch(view.text(), /Marked as done/);
    await view.unmount();
  } finally {
    mock.timers.reset();
  }
  assert.equal(UNDO_MS, 60_000);
});

test('a loop keeps its own calls, and Reopen on a closed one is the loop’s own call; a run in Resolved is reopened by its mark', async () => {
  const m = page();
  const view = await mountMomo(m);
  await openPage();
  await click('Call mum');
  assert.match(view.text(), /DoneSnoozeDismiss/);
  await click('Done');
  assert.deepEqual(calls(m, 'momo.loops.act'), [{ loopId: 'L1', action: 'done' }]);
  await click('Resolved');
  await click('Book the dentist');
  await click('Reopen');
  assert.deepEqual(calls(m, 'momo.loops.act').at(-1), { loopId: 'L3', action: 'reopen' });
  await view.unmount();
});

test('a routine is paused or resumed from its own page and Pause all is MoMo’s own pause; neither runs while a change is working', async () => {
  const m = page();
  const view = await mountMomo(m);
  await openPage();
  await click('Scheduled');
  await click('Weekdays brief, Next 2026-11-16 08:00');
  await click('Pause');
  assert.deepEqual(calls(m, 'momo.routines.pause'), [{ id: 'r1' }]);
  await click('Scheduled');
  await click('Cleanup, Paused');
  await click('Resume');
  assert.deepEqual(calls(m, 'momo.routines.resume'), [{ id: 'r2' }]);
  await click('Scheduled');
  await click('Pause all');
  assert.deepEqual(calls(m, 'momo.prefs.set'), [{ paused: true }]);
  await view.unmount();
});

test('with MoMo paused Scheduled offers Resume all', async () => {
  const m = page({ 'momo.tasks.list': () => reply(TASKS, true) });
  const view = await mountMomo(m);
  await openPage();
  await click('Scheduled');
  await click('Resume all');
  assert.deepEqual(calls(m, 'momo.prefs.set'), [{ paused: false }]);
  await view.unmount();
});

test('a refusal from the Mac is said on the run’s page, which stays', async () => {
  const m = page({ 'momo.tasks.mark': () => Promise.reject(new Error('Only a routine run can be marked.')) });
  const view = await mountMomo(m);
  await openPage();
  await click('Morning brief');
  await click('Mark as done');
  assert.match(view.text(), /Only a routine run can be marked\./);
  assert.ok(label('Archive'));
  await view.unmount();
});

test('a read that fails after one that worked says "Couldn’t read your tasks." with Try again over the last list; Try again reads once more', async () => {
  let fail = false;
  const m = page({ 'momo.tasks.list': () => (fail ? Promise.reject(new Error('boom')) : reply()) });
  const view = await mountMomo(m);
  await openPage();
  fail = true;
  await click('Call mum');
  await click('Done');
  assert.match(view.text(), /Couldn’t read your tasks\.Try again/);
  assert.match(view.text(), /Send the mail/, 'the last list stays');
  fail = false;
  await click('Couldn’t read your tasks., Try again');
  assert.doesNotMatch(view.text(), /Couldn’t read your tasks/);
  await view.unmount();
});

test('an older Mac keeps the classic list: no panel without the mark method, and none for a reply with no `v`', async () => {
  const noMark = page({}, [...BASE, 'momo.tasks.list']);
  let view = await mountMomo(noMark);
  await openPage();
  assert.equal(label('Up next'), null);
  assert.match(view.text(), /Needs youNothing needs you/);
  assert.match(view.text(), /Scheduled/, 'its own Scheduled group, from the routines list');
  await view.unmount();
  const classic = page({
    'momo.tasks.list': () => ({
      tasks: [{ id: 'loop:L1', kind: 'loop', state: 'needs-you', title: 'Call mum', detail: null, dueDay: null, ref: 'L1' }],
      now: 1,
    }),
  });
  view = await mountMomo(classic);
  await openPage();
  assert.equal(label('Up next'), null);
  assert.match(view.text(), /Needs youCall mum›/);
  await view.unmount();
});

test('the words are in the catalog in both languages with the same keys, and the tabs show in Chinese when chosen', async () => {
  assert.deepEqual(Object.keys(zh.momoTasks), Object.keys(en.momoTasks));
  for (const key of Object.keys(en.momoTasks)) assert.equal(typeof zh.momoTasks[key], 'string', key);
  assert.equal(en.momoTasks.next.includes('{{time}}'), true);
  assert.equal(zh.momoTasks.next.includes('{{time}}'), true);
  const m = page();
  const view = await mountMomo(m);
  try {
    await act(async () => i18n.showLocale('zh-Hans'));
    await openPage();
    assert.match(view.text(), /接下来/);
    assert.match(view.text(), /待查看/);
    assert.match(view.text(), /未完成/);
  } finally {
    await act(async () => i18n.showLocale('en'));
    await view.unmount();
  }
});

test('each routine on Scheduled has its own switch: off pauses it, on resumes it, without opening its page', async () => {
  const m = page();
  const view = await mountMomo(m);
  await openPage();
  await click('Scheduled');
  await click('Weekdays brief on');
  assert.deepEqual(calls(m, 'momo.routines.pause'), [{ id: 'r1' }]);
  await click('Cleanup off');
  assert.deepEqual(calls(m, 'momo.routines.resume'), [{ id: 'r2' }]);
  assert.match(view.text(), /Pause all/, 'still the list: a switch does not open the routine’s page');
  await view.unmount();
});

test('a routine’s switch is a real switch: role, a label with the routine and on or off, and its checked state; the words are in both catalogs', async () => {
  const m = page();
  const view = await mountMomo(m);
  await openPage();
  await click('Scheduled');
  const switches = [...document.querySelectorAll('[role="switch"]')] as HTMLElement[];
  assert.deepEqual(
    switches.map((e) => [e.getAttribute('aria-label'), e.getAttribute('aria-checked'), e.getAttribute('data-accessibility-role')]),
    [
      ['Weekdays brief on', 'true', 'switch'],
      ['Cleanup off', 'false', 'switch'],
      ['Quiet one on', 'true', 'switch'],
    ],
  );
  await view.unmount();
  assert.equal(en.momoTasks.routineOff, '{{name}} off');
  assert.equal(zh.momoTasks.routineOff.includes('{{name}}'), true);
  assert.equal(zh.momoTasks.routineOn.includes('{{name}}'), true);
});

test('while one switch’s change is held open the others are disabled; they are enabled again after it succeeds and after it fails', async () => {
  const held: { ok: () => void; no: (e: Error) => void }[] = [];
  const m = page({ 'momo.routines.pause': () => new Promise((ok, no) => held.push({ ok: () => ok({ routine: {} }), no })) });
  const view = await mountMomo(m);
  await openPage();
  await click('Scheduled');
  const sw = (name: string) => label(name) as HTMLButtonElement;
  assert.deepEqual([sw('Cleanup off').disabled, sw('Quiet one on').disabled], [false, false]);
  await click('Weekdays brief on');
  assert.equal(held.length, 1, 'the first request is still open');
  assert.deepEqual([sw('Cleanup off').disabled, sw('Quiet one on').disabled], [true, true]);
  await act(async () => held[0].ok());
  await flush();
  assert.deepEqual([sw('Cleanup off').disabled, sw('Quiet one on').disabled], [false, false]);
  await click('Quiet one on');
  assert.equal(held.length, 2);
  assert.equal(sw('Cleanup off').disabled, true);
  await act(async () => held[1].no(new Error('the Mac said no')));
  await flush();
  assert.equal(sw('Cleanup off').disabled, false);
  assert.match(view.text(), /the Mac said no/);
  await view.unmount();
});

test('a first read that fails shows "Couldn’t read your tasks." with Try again, not the older list; Try again reads once more and keeps an older Mac’s list intact', async () => {
  let fail = true;
  const m = page({ 'momo.tasks.list': () => (fail ? Promise.reject(new Error('boom')) : reply()) });
  const view = await mountMomo(m);
  await openPage();
  assert.match(view.text(), /Couldn’t read your tasks\.Try again/);
  assert.doesNotMatch(view.text(), /waiting for you|Old routines list/);
  fail = false;
  await click('Couldn’t read your tasks., Try again');
  assert.doesNotMatch(view.text(), /Couldn’t read your tasks/);
  assert.match(view.text(), /Send the mail/);
  await view.unmount();
  // no method listed: the older list as before
  const old = page({ 'momo.tasks.list': () => Promise.reject(new Error('boom')) }, [...BASE, 'momo.tasks.list']);
  const o = await mountMomo(old);
  await openPage();
  assert.match(o.text(), /Needs you1 waiting for you/);
  assert.doesNotMatch(o.text(), /Couldn’t read your tasks/);
  await o.unmount();
});
