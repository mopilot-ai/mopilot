// One morning note (A7, PR-F): setup no longer proposes the older "Morning briefing" starter, and for an account that approved it the Morning brief's two places (the first run's row and Settings › MoMo › Proactivity) say it is still on and have one button that pauses only that routine, through the routine edit Settings › MoMo › Routines uses. A new account never sees both; nothing is paused or removed for anyone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { window } from './support/dom.ts';
import { mockSource } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';

const require = createRequire(import.meta.url);
const { MOMO_SETUP_STARTERS, MOMO_STARTER_ROUTINES } = require('../shared/momoPrefs.mjs');
const { STARTERS } = require('../electron/momo/starterRoutines.cjs');
const React = await import('react');
const { act, createElement } = React;
const { createRoot } = await import('react-dom/client');

const f: any = { calls: [], routines: [], brief: false, editAnswer: async () => ({}), listeners: [] as Array<() => void> };
installNativeStub({
  momoRoutines: {
    view: async () => ({ proposals: [], routines: f.routines, sources: [] }),
    onChanged: (cb: () => void) => (f.listeners.push(cb), () => undefined),
    edit: async (id: string, change: unknown) => (f.calls.push(['edit', id, change]), f.editAnswer()),
    remove: async (id: string) => f.calls.push(['remove', id]),
  },
});
mockSource('src/session/momoPrefs.ts', {
  useMomoPrefs: () => ({
    brief: f.brief,
    notify: { pushBody: false, needsAnswer: true },
    routines: { proactivity: 'default', quietHours: null },
  }),
  saveMomoPref: async (k: string, v: unknown) => (f.calls.push(['pref', k, v]), true),
});
const { BriefRow } = await import('../src/components/momo/setup/BriefRow.tsx');
const { ProactivitySettings } = await import('../src/components/momo/settings/Proactivity.tsx');
const { EARLIER_BRIEFING } = await import('../src/lib/momoEarlierBriefing.ts');

const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
const routine = (over: any) => ({
  id: 'r1',
  name: EARLIER_BRIEFING,
  prompt: 'p',
  schedule: 'Every day at 8',
  rrule: '',
  parts: null,
  sources: [],
  paused: false,
  ...over,
});
async function mount(el: any) {
  const host: any = window.document.createElement('div');
  window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(el));
  await flush();
  const button = (label: string) => [...host.querySelectorAll('button')].find((b: any) => b.textContent.trim() === label) as any;
  const click = async (target: any) => {
    await act(async () => target.click());
    await flush();
  };
  return { host, button, click, close: () => act(async () => root.unmount()) };
}
const reset = (routines: any[], brief = false) =>
  Object.assign(f, { calls: [], routines, brief, editAnswer: async () => ({}), listeners: [] });

test('the name matches the starter, and setup proposes the others but never the Morning briefing, while older picks still read', () => {
  assert.equal(EARLIER_BRIEFING, STARTERS.morningFeed().name);
  assert.deepEqual(MOMO_SETUP_STARTERS, ['weekAhead', 'bills']);
  assert.ok(MOMO_STARTER_ROUTINES.includes('morningFeed'), 'a saved pick of an older build is still valid');
});

test('a new account: turning the brief on shows no earlier-routine line', async () => {
  reset([]);
  const v = await mount(createElement(BriefRow));
  await v.click(v.button('Turn on'));
  assert.deepEqual(f.calls, [['pref', 'brief', true]]);
  assert.match(v.host.textContent, /On/);
  assert.doesNotMatch(v.host.textContent, /Earlier Morning briefing|still on/);
  await v.close();
});

test('an account that approved it: the first run’s row says it is still on once the brief is on, and its button pauses only that routine', async () => {
  reset([routine({}), routine({ id: 'r2', name: 'Week ahead' })]);
  const v = await mount(createElement(BriefRow));
  assert.doesNotMatch(v.host.textContent, /still on/, 'nothing before the brief is on');
  await v.click(v.button('Turn on'));
  assert.match(v.host.textContent, /Earlier Morning briefing/);
  assert.match(v.host.textContent, /Your earlier routine is still on\./);
  f.calls = [];
  f.routines = [routine({ paused: true }), routine({ id: 'r2', name: 'Week ahead' })];
  await v.click(v.button('Turn it off'));
  assert.deepEqual(f.calls, [['edit', 'r1', { paused: true }]], 'only that routine, paused, not removed');
  assert.doesNotMatch(v.host.textContent, /still on/, 'the line goes once main has saved it');
  await v.close();
});

test('a refused pause says why and keeps the line; a paused routine shows nothing', async () => {
  reset([routine({})]);
  f.editAnswer = async () => {
    throw new Error('That routine changed.');
  };
  const v = await mount(createElement(BriefRow));
  await v.click(v.button('Turn on'));
  await v.click(v.button('Turn it off'));
  assert.match(v.host.textContent, /Couldn’t save that: That routine changed\./);
  assert.ok(v.button('Turn it off'));
  await v.close();
  reset([routine({ paused: true })]);
  const paused = await mount(createElement(BriefRow));
  await paused.click(paused.button('Turn on'));
  assert.doesNotMatch(paused.host.textContent, /still on/);
  await paused.close();
});

test('Settings › Proactivity: the line and button show only with the brief on and the routine running, and the button pauses only it', async () => {
  reset([routine({})], false);
  const off = await mount(createElement(ProactivitySettings));
  assert.doesNotMatch(off.host.textContent, /Earlier Morning briefing/, 'the brief is off: nothing to say');
  await off.close();
  reset([routine({})], true);
  const on = await mount(createElement(ProactivitySettings));
  assert.match(on.host.textContent, /Your earlier Morning briefing routine is still on\./);
  await on.click(on.button('Turn it off'));
  assert.deepEqual(f.calls, [['edit', 'r1', { paused: true }]]);
  await on.close();
  reset([], true);
  const none = await mount(createElement(ProactivitySettings));
  assert.doesNotMatch(none.host.textContent, /Earlier Morning briefing/);
  await none.close();
});
