// MoMo's right panel (src/components/momo/MomoPanel.tsx, useMomoActivity.ts, momoStatus.ts): its identity with what it is doing and Pause or Resume, "MoMo's computer", Devices (this Mac and the Host machines, each with its status, Show more), Recent activity from main (empty, failed and changed states, each item opening its chat) and the way to Memory and Settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h, act } from 'react';
import { render, click, flush } from './support/shell-chrome-kit.ts';
import { mockSource } from './support/stubs.ts';
import { deferred } from './support/async-scenarios.ts';
import { installNativeStub } from './support/ports/native.ts';

const calls: any[] = [];
let paused = false;
let rowState: string | null = null;
let machines: any[] = [];
let list: () => Promise<any> = async () => ({ items: [] });
let watch: (on: boolean) => Promise<boolean> = async () => true;
let changed: ((c: { id: string }) => void) | null = null;
let savePref: (k: string, v: unknown) => Promise<boolean> = async () => true;

mockSource('src/session/momoPrefs.ts', {
  useMomoPrefs: () => ({ paused, persona: { name: 'MoMo', color: 'clay' } }),
  saveMomoPref: (k: string, v: unknown) => (calls.push(['pref', k, v]), savePref(k, v)),
});
mockSource('src/session/useChatRowState.ts', { useChatRowState: () => (rowState ? { state: rowState } : null) });
mockSource('src/lib/hostMachines.ts', { useHostMachines: () => ({ machines, resolved: true }) });
let outputsFlag = true;
mockSource('src/lib/flags.ts', { useFlag: (key: string) => key === 'momo.outputs' && outputsFlag });
mockSource('src/store/panes.ts', { navigate: (r: any) => calls.push(['navigate', r]) });
mockSource('src/components/momo/MomoSidebarRow.tsx', { MomoDot: () => h('i', { 'data-stub': 'dot' }) });
installNativeStub({
  momoOutputs: { list: async () => ({ ok: true, files: [] }), onChanged: () => () => {} },
  momoChat: {
    activityList: () => list(),
    watchActivity: (on: boolean) => (calls.push(['watch', on]), watch(on)),
    onActivityChanged: (cb: any) => ((changed = cb), () => (changed = null)),
  },
});
const { MomoPanel } = await import('../src/components/momo/MomoPanel.tsx');

const settle = async () => {
  for (let i = 0; i < 4; i++) await flush();
};
const panel = async (chatId: string | null = 'm1') => {
  const r = await render(h(MomoPanel, { chatId }));
  await settle();
  return r;
};
const text = (r: any, sel: string) => r.host.querySelector(sel)?.textContent ?? null;
const reset = () => {
  outputsFlag = true;
  calls.length = 0;
  paused = false;
  rowState = null;
  machines = [];
  list = async () => ({ items: [] });
  watch = async () => true;
  savePref = async () => true;
};

test('identity: its name and what it is doing on any harness, with Pause that saves and waits for the save; Paused says so with Resume', async () => {
  reset();
  let r = await panel();
  assert.equal(r.host.querySelector('aside')!.getAttribute('aria-label'), 'MoMo details');
  assert.equal(text(r, '[data-tone=active]'), 'Active');
  assert.equal(text(r, '[aria-label="MoMo\'s computer"]'), 'MoMo’s computerThis Mac · Ready');
  const save = deferred<boolean>();
  savePref = () => save.promise;
  const pause = r.host.querySelector('button')!;
  assert.equal(pause.textContent, 'Pause');
  await click(pause);
  assert.deepEqual(
    calls.filter((c) => c[0] === 'pref'),
    [['pref', 'paused', true]],
  );
  assert.equal(r.host.querySelector<HTMLButtonElement>('button')!.disabled, true, 'busy until saved');
  await act(async () => save.resolve(true));
  await settle();
  assert.equal(r.host.querySelector<HTMLButtonElement>('button')!.disabled, false);
  await r.unmount();
  paused = true;
  r = await panel();
  assert.equal(text(r, '[data-tone=paused]'), 'Paused');
  assert.equal(r.host.querySelector('button')!.textContent, 'Resume');
  assert.match(text(r, '[aria-label="MoMo\'s computer"]'), /This Mac · Paused/);
  savePref = async () => true;
  calls.length = 0;
  await click(r.host.querySelector('button'));
  assert.deepEqual(
    calls.filter((c) => c[0] === 'pref'),
    [['pref', 'paused', false]],
  );
  await r.unmount();
  for (const [state, line, computer] of [
    ['working', 'Working…', 'Working'],
    ['elsewhereRunning', 'Working…', 'Working'],
    ['approval', 'Needs you', 'Ready'],
    ['unread', 'Active', 'Ready'],
  ]) {
    paused = false;
    rowState = state!;
    const s = await panel();
    assert.equal(text(s, '[class*=status]'), line, state!);
    assert.match(text(s, '[aria-label="MoMo\'s computer"]'), new RegExp(`This Mac · ${computer}`), state!);
    await s.unmount();
  }
  // no chat yet: idle
  reset();
  const none = await panel(null);
  assert.equal(text(none, '[data-tone=active]'), 'Active');
  await none.unmount();
});

test('devices: this Mac first, then the Host machines with their status; more than fit show behind Show more', async () => {
  reset();
  let r = await panel();
  const names = (x: any) => [...x.host.querySelectorAll('ul')[0].querySelectorAll('li')].map((li: any) => li.textContent);
  assert.deepEqual(names(r), ['This Mac']);
  assert.equal(r.host.querySelector('[aria-expanded]'), null, 'nothing to show more of');
  await r.unmount();
  machines = [
    { id: 'a', name: 'Work laptop', status: 'online' },
    { id: 'b', name: 'Mac mini', status: 'offline' },
    { id: 'c', name: 'Desktop PC', status: 'attention' },
  ];
  r = await panel();
  assert.deepEqual(names(r), ['This Mac', 'Work laptop', 'Mac miniOffline']);
  const more = r.host.querySelector('[aria-expanded]')!;
  assert.equal(more.textContent, 'Show more');
  await click(more);
  assert.deepEqual(names(r), ['This Mac', 'Work laptop', 'Mac miniOffline', 'Desktop PCNeeds attention']);
  assert.equal(r.host.querySelector('[aria-expanded]')!.textContent, 'Show less');
  assert.deepEqual(
    [...r.host.querySelectorAll('ul')[0].querySelectorAll('[data-tone]')].map((d: any) => d.getAttribute('data-tone')),
    ['on', 'on', 'off', 'warn'],
  );
  await click(r.host.querySelector('[aria-expanded]'));
  assert.equal(names(r).length, 3);
  await r.unmount();
});

test('recent activity: loading, empty, failed and listed (each opening its chat), read again when main says an item changed, an older read ignored', async () => {
  reset();
  const first = deferred<any>();
  list = () => first.promise;
  const r = await render(h(MomoPanel, { chatId: 'm1' }));
  await settle();
  assert.match(text(r, 'aside'), /Loading…/);
  assert.deepEqual(
    calls.filter((c) => c[0] === 'watch'),
    [['watch', true]],
  );
  await act(async () => first.resolve({ items: [] }));
  await settle();
  assert.match(text(r, 'aside'), /No recent activity/);
  const items = Array.from({ length: 8 }, (_, i) => ({
    id: `i${i}`,
    kind: 'routine',
    title: `Run ${i}`,
    state: i === 0 ? 'running' : i === 1 ? 'needs-you' : i === 2 ? 'failed' : 'done',
    chatId: `c${i}`,
    startedAt: Date.now(),
  }));
  list = async () => ({ items });
  await act(async () => changed!({ id: 'i0' }));
  await settle();
  const rows = [...r.host.querySelectorAll('ul')].at(-1)!.querySelectorAll('li');
  assert.equal(rows.length, 6, 'the newest few');
  assert.deepEqual(
    [...rows].slice(0, 4).map((li: any) => li.textContent),
    ['Run 0Running · now', 'Run 1Needs you · now', 'Run 2Failed · now', 'Run 3Done · now'],
  );
  calls.length = 0;
  await click(rows[1].querySelector('button'));
  assert.deepEqual(calls, [['navigate', { name: 'momo', tab: 'chat', chatId: 'c1' }]]);
  // a slow read that settles after a newer one changes nothing
  const slow = deferred<any>();
  list = () => slow.promise;
  await act(async () => changed!({ id: 'x' }));
  list = async () => ({ items: [] });
  await act(async () => changed!({ id: 'y' }));
  await settle();
  await act(async () => slow.resolve({ items }));
  await settle();
  assert.match(text(r, 'aside'), /No recent activity/);
  // a failed read says so
  list = async () => {
    throw new Error('main said no');
  };
  await act(async () => changed!({ id: 'z' }));
  await settle();
  assert.match(text(r, 'aside'), /Couldn’t load activity\./);
  // the links
  calls.length = 0;
  const links = r.host.querySelector('nav')!.querySelectorAll('button');
  await click(links[0]);
  await click(links[1]);
  assert.deepEqual(calls, [
    ['navigate', { name: 'momo', tab: 'memory' }],
    ['navigate', { name: 'settings', section: 'momo' }],
  ]);
  calls.length = 0;
  await r.unmount();
  assert.equal(changed, null, 'closing the panel stops listening');
  assert.deepEqual(calls, [['watch', false]]);
});

test('main refusing to watch still lets the panel read, and a failed stop is only noted', async () => {
  reset();
  watch = async () => {
    throw new Error('not allowed');
  };
  list = async () => ({ items: [{ id: 'a', kind: 'errand', title: 'Errand', state: 'done', chatId: 'c', startedAt: Date.now() }] });
  const r = await panel();
  assert.match(text(r, 'aside'), /Errand/);
  await r.unmount();
  await settle();
});

test('Outputs: a section of the panel while the momo.outputs flag is on, and none (no heading, no list) while it is off', async () => {
  reset();
  let r = await panel();
  assert.ok([...r.host.querySelectorAll('h3')].some((h: any) => h.textContent === 'Outputs'));
  assert.match(r.host.textContent, /Files MoMo makes show up here\./);
  outputsFlag = false;
  r = await panel();
  assert.ok(![...r.host.querySelectorAll('h3')].some((h: any) => h.textContent === 'Outputs'));
  assert.doesNotMatch(r.host.textContent, /Files MoMo makes/);
});
