// The Memory tab's history and Settings' background memory (#2139 P3; src/components/momo/MemoryChanges.tsx, settings/BackgroundMemory.tsx), the real components over a fake window.native.momoMemory: each recent change names who made it and what it did to each fact, Undo takes one back or says why it can't, an undone change says so and offers no Undo, past facts show on request, and the background pass's limits and the last day's use are shown, read again when the memory changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { installNativeStub } from './support/ports/native.ts';

const React = await import('react');
const { act, createElement } = React;
const { createRoot } = await import('react-dom/client');

const f: any = { calls: [], listeners: new Set() };
const ok = (x: object = {}) => ({ ok: true, ...x });
installNativeStub({
  momoMemory: {
    changes: () => (f.calls.push(['changes']), f.changesAnswer()),
    undo: async (id: string) => (f.calls.push(['undo', id]), f.undoAnswer(id)),
    past: () => (f.calls.push(['past']), f.pastAnswer()),
    background: () => (f.calls.push(['background']), f.backgroundAnswer()),
    onChanged: (cb: () => void) => {
      f.listeners.add(cb);
      return () => f.listeners.delete(cb);
    },
  },
});
const { RecentChanges, PastFacts, itemText } = await import('../src/components/momo/MemoryChanges.tsx');
const { BackgroundMemorySettings } = await import('../src/components/momo/settings/BackgroundMemory.tsx');

const AT = new Date(2026, 10, 1, 12).getTime();
const fact = (id: string, text: string, over: any = {}) => ({
  id,
  text,
  source: { chatId: 'momo-main', harness: 'claude' },
  createdAt: AT,
  confidence: 'likely',
  ...over,
});
const change = (id: string, over: any = {}) => ({ id, at: AT, by: 'user', op: 'save', items: [], undoable: true, ...over });

function reset() {
  f.calls = [];
  f.changes = [
    change('c3', {
      by: 'pass',
      op: 'pass',
      reason: 'chat idle',
      items: [
        { before: fact('f1', 'Lives in Berlin'), after: fact('f1', 'Lives in Berlin', { invalidAt: AT }) },
        { before: null, after: fact('f2', 'Lives in Lisbon', { origin: 'extracted' }) },
      ],
    }),
    change('c2', {
      by: { chatId: 'c', harness: 'codex' },
      op: 'update',
      items: [{ before: fact('f3', 'Likes tea'), after: fact('f3', 'Likes green tea') }],
    }),
    change('c1', { op: 'forget', items: [{ before: fact('f4', 'Owns a cat'), after: null }], undone: AT, undoable: false }),
  ];
  f.changesAnswer = async () => ok({ changes: f.changes });
  f.undoAnswer = async (id: string) => {
    f.changes = f.changes.map((c: any) => (c.id === id ? { ...c, undone: AT, undoable: false } : c));
    return ok({ change: change('u1', { op: 'undo' }) });
  };
  f.pastAnswer = async () => ok({ facts: [fact('f1', 'Lives in Berlin', { invalidAt: AT, supersededBy: 'f2' })] });
  f.backgroundAnswer = async () =>
    ok({
      limits: {
        daily: { cap: 200000, today: 13000 },
        memory: { cap: 120000, today: 12345 },
        aliases: { cap: 100000, today: 655 },
        maxTokensPerPass: 6000,
      },
    });
}
const flush = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
const changed = () => act(async () => [...f.listeners].forEach((cb: any) => cb()));

async function mount(component: any) {
  const host = window.document.createElement('div');
  window.document.body.appendChild(host as any);
  const root = createRoot(host as any);
  await act(async () => root.render(createElement(component)));
  await flush();
  const q = (sel: string, el: any = host) => el.querySelector(sel);
  const all = (sel: string, el: any = host) => [...el.querySelectorAll(sel)];
  const button = (label: string, el: any = host) => all('button', el).find((b: any) => b.textContent === label);
  const click = async (el: any) => {
    await act(async () => el.click());
    await flush();
  };
  const row = (id: string) => q(`[data-change="${id}"]`);
  const text = (el: any) => el?.textContent ?? '';
  return { host, q, all, button, click, row, text, close: () => act(async () => root.unmount()) };
}

test('each change names who made it and what it did to each fact; an undone one says so and has no Undo', async () => {
  reset();
  const v = await mount(RecentChanges);
  const chips = (id: string) => v.all('.momo-chip', v.row(id)).map((c: any) => c.textContent);
  assert.deepEqual(chips('c3'), ['MoMo', '2026-11-01']);
  assert.deepEqual(
    v.all('.momo-change-item', v.row('c3')).map((x: any) => x.textContent),
    ['Replaced: Lives in Berlin', '+ Lives in Lisbon'],
  );
  assert.match(v.text(v.row('c3')), /^Updated/);
  assert.deepEqual(chips('c2'), ['Codex', '2026-11-01']);
  assert.match(v.text(v.row('c2')), /Likes tea → Likes green tea/);
  assert.deepEqual(chips('c1'), ['You', '2026-11-01', 'Undone']);
  assert.match(v.text(v.row('c1')), /Deleted− Owns a cat/);
  assert.equal(v.button('Undo', v.row('c1')), undefined, 'undone already');
  assert.equal(itemText({ before: fact('a', 'Same'), after: fact('a', 'Same', { confidence: 'sure' }) }), 'Same');
  assert.equal(itemText({ before: null, after: null }), '+ ');
  await v.close();
});

test('Undo takes a change back and the list reads again; a refused or failed undo says why', async () => {
  reset();
  const v = await mount(RecentChanges);
  f.undoAnswer = async () => ({ ok: false, error: 'That fact changed since; undo the later change first' });
  await v.click(v.button('Undo', v.row('c2')));
  assert.match(v.text(v.q('[role="alert"]', v.row('c2'))), /Couldn't undo: That fact changed since; undo the later change first/);
  f.undoAnswer = async () => {
    throw new Error('IPC gone');
  };
  await v.click(v.button('Undo', v.row('c2')));
  assert.match(v.text(v.q('[role="alert"]', v.row('c2'))), /IPC gone/);
  reset();
  await v.click(v.button('Undo', v.row('c3')));
  assert.deepEqual(
    f.calls.filter((c: any) => c[0] === 'undo'),
    [['undo', 'c3']],
  );
  // main says the memory changed: the list reads again and shows it undone
  await changed();
  await flush();
  assert.equal(v.button('Undo', v.row('c3')), undefined);
  assert.ok(v.all('.momo-chip', v.row('c3')).some((c: any) => c.textContent === 'Undone'));
  await v.close();
  assert.equal(f.listeners.size, 0);
});

test('no changes yet, a failed read with Retry, and nothing at all while MoMo is not allowed', async () => {
  reset();
  f.changesAnswer = async () => ok({ changes: [] });
  let v = await mount(RecentChanges);
  assert.match(v.text(v.host), /No changes yet/);
  await v.close();
  f.changesAnswer = async () => ({ ok: false, error: 'disk' });
  v = await mount(RecentChanges);
  assert.match(v.text(v.q('[role="alert"]')), /Couldn't read: disk/);
  reset();
  await v.click(v.button('Retry'));
  assert.ok(v.row('c3'));
  await v.close();
  f.changesAnswer = async () => ({ ok: false, error: 'no', reason: 'not_allowed' });
  v = await mount(RecentChanges);
  assert.equal(v.host.innerHTML, '');
  await v.close();
});

test('past facts stay hidden until asked for; none, or MoMo not allowed, shows nothing', async () => {
  reset();
  let v = await mount(PastFacts);
  assert.equal(v.q('.settings-row-title'), null, 'hidden');
  await v.click(v.button('Show 1'));
  assert.match(v.text(v.host), /Lives in Berlin/);
  assert.match(v.text(v.host), /Replaced 2026-11-01/);
  await v.click(v.button('Hide'));
  assert.equal(v.q('.momo-chip'), null);
  await v.close();
  f.pastAnswer = async () => ok({ facts: [] });
  v = await mount(PastFacts);
  assert.equal(v.host.innerHTML, '');
  await v.close();
  f.pastAnswer = async () => ({ ok: false, error: 'no', reason: 'not_allowed' });
  v = await mount(PastFacts);
  assert.equal(v.host.innerHTML, '');
  await v.close();
  // a past fact with no replacement time goes by the day it was made
  f.pastAnswer = async () => ok({ facts: [fact('f9', 'Old')] });
  v = await mount(PastFacts);
  await v.click(v.button('Show 1'));
  assert.match(v.text(v.host), /Replaced 2026-11-01/);
  await v.close();
});

test('Settings shows the day’s one background limit and each pass’s share, read again when the memory changes', async () => {
  reset();
  const v = await mount(BackgroundMemorySettings);
  const text = () => v.text(v.host);
  assert.match(text(), /MoMo saves facts and search aliases in the background, within one daily limit\./);
  assert.match(text(), /Daily limitAbout 13,000 of 200,000 tokens today\./);
  assert.match(text(), /MemoryAbout 12,345 of 120,000 tokens today\. Up to 6,000 tokens a pass\./);
  assert.match(text(), /Search aliasesAbout 655 of 100,000 tokens today\./);
  f.backgroundAnswer = async () =>
    ok({
      limits: {
        daily: { cap: 200000, today: 1000 },
        memory: { cap: 120000, today: 900 },
        aliases: { cap: 100000, today: 100 },
        maxTokensPerPass: 6000,
      },
    });
  await changed();
  await flush();
  assert.match(text(), /Daily limitAbout 1,000 of 200,000 tokens today\./);
  assert.match(text(), /MemoryAbout 900 of/);
  assert.match(text(), /Search aliasesAbout 100 of/);
  f.backgroundAnswer = async () =>
    ok({
      limits: {
        daily: { cap: 200000, today: null },
        memory: { cap: 120000, today: null },
        aliases: { cap: 100000, today: null },
        maxTokensPerPass: 6000,
      },
    });
  await changed();
  await flush();
  assert.match(text(), /Daily limitUp to 200,000 tokens a day; couldn't read today's use\./, 'never a 0 that isn’t true');
  assert.doesNotMatch(text(), /About 0 /);
  f.backgroundAnswer = async () => ok({ limits: null });
  await changed();
  await flush();
  assert.match(v.text(v.host), /Not running\./);
  f.backgroundAnswer = async () => ({ ok: false, error: 'no' });
  await changed();
  await flush();
  assert.match(v.text(v.host), /Couldn't read its use/);
  f.backgroundAnswer = async () => {
    throw new Error('IPC gone');
  };
  await changed();
  await flush();
  assert.match(v.text(v.host), /Couldn't read its use/);
  await v.close();
  assert.equal(f.listeners.size, 0);
});
