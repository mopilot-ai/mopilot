// The composer's Share Computer History dialog (#1363, src/components/composer/ComputerHistoryShare.tsx): off says so with a way to Settings, a range and the apps and sites to include, a preview of exactly what main will send, a note on how this chat's harness gets it (from its capability), and the attachment it makes. Main is a fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const React = await import('react');
const { act, createElement } = React;
const { createRoot } = await import('react-dom/client');

const block = (s: string) => `<sage-computer-history>\n${s}\n</sage-computer-history>`;
const mem = (over: any) => ({
  day: '2026-10-18',
  bundleId: 'com.apple.Notes',
  app: 'Notes',
  title: 'Plan',
  start: 1,
  end: 2,
  ms: 60000,
  ...over,
});
const f: any = { calls: [], nav: [] };
installNativeStub({
  computerHistory: {
    state: () => f.state(),
    memories: (q: any) => (f.calls.push(q), f.memories(q)),
  },
});
stubStore({ navigate: (r: unknown) => f.nav.push(r), toast: () => undefined });
const { ComputerHistoryShare, rangeDays, deliveryNote, historyAttachment, RANGES } = await import(
  '../src/components/composer/ComputerHistoryShare.tsx'
);

const flush = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
function reset() {
  f.calls = [];
  f.nav = [];
  f.state = async () => ({ ok: true, state: { settings: { enabled: true } } });
  const all = [mem({}), mem({ bundleId: 'com.google.Chrome', app: 'Chrome', site: 'github.com', title: 'PR' })];
  f.memories = async (q: any) => {
    const picked = q.apps ? all.filter((m) => (m.site ? q.sites.includes(m.site) : q.apps.includes(m.bundleId))) : all;
    return {
      ok: true,
      memories: picked,
      text: picked.map((m) => m.title).join('\n'),
      block: picked.length ? block(picked.map((m) => m.title).join(',')) : null,
      unreadable: 0,
    };
  };
}
async function mount(cap: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  const out: any = { attached: [], closed: 0 };
  await act(async () =>
    root.render(createElement(ComputerHistoryShare, { cap, onAttach: (a: any) => out.attached.push(a), onClose: () => out.closed++ })),
  );
  await flush();
  const q = (sel: string) => document.querySelector(sel) as any;
  const button = (text: string) => [...document.querySelectorAll('button')].find((b: any) => b.textContent.trim() === text) as any;
  const click = async (el: any) => {
    assert.ok(el);
    await act(async () => el.click());
    await flush();
  };
  return { out, q, button, click, close: async () => (await act(() => root.unmount()), host.remove()) };
}

test('ranges are local days, newest first', () => {
  const now = new Date(2026, 9, 18, 9);
  assert.deepEqual(rangeDays('today', now), ['2026-10-18']);
  assert.deepEqual(rangeDays('yesterday', now), ['2026-10-17']);
  assert.deepEqual(rangeDays('week', now), [
    '2026-10-18',
    '2026-10-17',
    '2026-10-16',
    '2026-10-15',
    '2026-10-14',
    '2026-10-13',
    '2026-10-12',
  ]);
  assert.deepEqual(rangeDays('week', new Date(2026, 0, 2)).at(-1), '2025-12-27');
  assert.deepEqual(
    RANGES.map((r) => r.id),
    ['today', 'yesterday', 'week'],
  );
});

test("the note says how this chat's harness gets them, from its capability", () => {
  assert.match(deliveryNote({ state: 'native', via: 'config' } as any), /separate context, kept out of your message/);
  assert.match(deliveryNote({ state: 'sage', via: 'polyfill' } as any), /quoted context ahead of your message/);
  assert.match(deliveryNote(undefined), /can't take/);
  assert.deepEqual(historyAttachment('week', 'B'), {
    kind: 'computerHistory',
    path: 'computer-history:week',
    name: 'Computer History · Last 7 days',
    text: 'B',
  });
  assert.equal(historyAttachment('nope' as any, 'B').name, 'Computer History · nope');
});

test('pick what to include, read the exact text, and share it with the chat', async () => {
  reset();
  const v = await mount({ state: 'native', via: 'config' });
  assert.deepEqual(
    [...document.querySelectorAll('.ch-share-sources label')].map((l: any) => l.textContent),
    ['Notes', 'github.com'],
  );
  assert.equal(v.q('.ch-share-preview').textContent, 'Plan\nPR');
  assert.match(v.q('.ch-share-note').textContent, /kept out of your message/);
  // unticking a site: main rebuilds the text with only what is left
  await v.click(document.querySelectorAll('.ch-share-sources input')[1]);
  assert.deepEqual(f.calls.at(-1), { days: rangeDays('today'), apps: ['com.apple.Notes'], sites: [] });
  assert.equal(v.q('.ch-share-preview').textContent, 'Plan');
  await v.click(document.querySelectorAll('.ch-share-sources input')[1]);
  await v.click(document.querySelectorAll('.ch-share-sources input')[1]);
  await v.click(v.button('Share with this chat'));
  assert.deepEqual(v.out.attached, [
    { kind: 'computerHistory', path: 'computer-history:today', name: 'Computer History · Today', text: block('Plan') },
  ]);
  assert.equal(v.out.closed, 1);
  await v.close();
});

test('nothing ticked or nothing recorded: there is nothing to share', async () => {
  reset();
  const v = await mount({ state: 'sage', via: 'polyfill' });
  for (const box of [...document.querySelectorAll('.ch-share-sources input')]) await v.click(box);
  assert.equal(v.button('Share with this chat').disabled, true);
  assert.equal(v.q('.ch-share-preview'), null);
  await v.click(v.button('Share with this chat'));
  assert.deepEqual(v.out.attached, []);
  await v.close();
  reset();
  f.memories = async () => ({ ok: true, memories: [], text: '', block: null, unreadable: 0 });
  const w = await mount({ state: 'sage', via: 'polyfill' });
  assert.equal(w.q('.ch-share-empty').textContent, 'No memories today.');
  await w.click(w.button('Last 7 days'));
  assert.equal(w.q('.ch-share-empty').textContent, 'No memories in the last 7 days.');
  assert.deepEqual(f.calls.at(-1).days.length, 7);
  await w.click(w.button('Yesterday'));
  assert.equal(w.q('.ch-share-empty').textContent, 'No memories yesterday.');
  await w.close();
});

test("a chat that can't take them can't share, even with memories ready", async () => {
  reset();
  const v = await mount({ state: 'absent', via: 'none' });
  assert.equal(v.button('Share with this chat').disabled, true);
  assert.match(v.q('.ch-share-note').textContent, /can't take/);
  await v.close();
});

test('off: says so and opens Computer History settings; Cancel closes', async () => {
  reset();
  f.state = async () => ({ ok: true, state: { settings: { enabled: false } } });
  const v = await mount({ state: 'native', via: 'config' });
  assert.match(v.q('.ch-share-off').textContent, /Computer History is off/);
  assert.equal(f.calls.length, 0, 'nothing is read while it is off');
  await v.click(v.button('Open Computer History settings'));
  assert.deepEqual(f.nav, [{ name: 'settings', section: 'computer-history' }]);
  assert.equal(v.out.closed, 1);
  await v.click(v.button('Cancel'));
  assert.equal(v.out.closed, 2);
  await v.close();
});

test('failures say why: a refused or failed state, list or preview', async () => {
  for (const [what, setup] of [
    ['state refused', () => (f.state = async () => ({ ok: false, error: 'not started' }))],
    ['state thrown', () => (f.state = async () => Promise.reject(new Error('no bridge')))],
    ['list refused', () => (f.memories = async () => ({ ok: false, reason: 'locked' }))],
    ['list thrown', () => (f.memories = async () => Promise.reject(new Error('gone')))],
  ] as const) {
    reset();
    setup();
    const v = await mount({ state: 'native', via: 'config' });
    assert.ok(v.q('.config-warning[role="alert"]'), what);
    await v.close();
  }
  reset();
  let n = 0;
  const ok = f.memories;
  f.memories = async (q: any) => (++n === 1 ? ok(q) : n === 2 ? { ok: false, error: 'busy' } : Promise.reject(new Error('down')));
  const v = await mount({ state: 'native', via: 'config' });
  assert.match(v.q('.config-warning').textContent, /busy/);
  await v.click(document.querySelectorAll('.ch-share-sources input')[0]);
  assert.match(v.q('.config-warning').textContent, /down/);
  await v.close();
});

test('a read that lands after the dialog closed or the range changed is dropped', async () => {
  reset();
  let release: (v: unknown) => void = () => undefined;
  f.state = () => new Promise((r) => (release = r));
  const v = await mount({ state: 'native', via: 'config' });
  assert.equal(v.q('.ch-share-empty').textContent, 'Reading…');
  await v.close();
  await act(async () => release({ ok: true, state: { settings: { enabled: true } } }));
  reset();
  const answers: ((v: unknown) => void)[] = [];
  f.memories = () => new Promise((r) => answers.push(r));
  const w = await mount({ state: 'native', via: 'config' });
  await w.click(w.button('Yesterday'));
  await act(async () => answers[0]({ ok: true, memories: [mem({ title: 'Stale' })], text: 'Stale', block: block('Stale'), unreadable: 0 }));
  await flush();
  assert.equal(w.q('.ch-share-sources'), null, 'the older range answer is ignored');
  await act(async () => answers[1]({ ok: true, memories: [mem({})], text: 'Plan', block: block('Plan'), unreadable: 0 }));
  await flush();
  let preview: (v: unknown) => void = () => undefined;
  f.memories = () => new Promise((r) => (preview = r));
  await w.click(document.querySelectorAll('.ch-share-sources input')[0]);
  await w.close();
  await act(async () => preview({ ok: true, memories: [], text: '', block: null, unreadable: 0 }));
  void window;
});
