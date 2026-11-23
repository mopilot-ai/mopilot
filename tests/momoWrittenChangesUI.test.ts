// The Memory tab's "Added by MoMo" list (#2139 P5, src/components/momo/WrittenChanges.tsx), the real component over a fake window.native.momoSources: nothing is shown until MoMo wrote something; each write says what it did and when; Undo is the user's own act and the row says why when main refused it (changed since, a helper that can't delete); an undone write has no Undo; the list is read again when the memory changes; a refusal that means MoMo is off hides it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { installNativeStub } from './support/ports/native.ts';

const React = await import('react');
const { act, createElement } = React;
const { createRoot } = await import('react-dom/client');

const f: any = { calls: [], listeners: new Set() };
installNativeStub({
  momoSources: {
    writes: () => (f.calls.push(['writes']), f.writesAnswer()),
    undoWrite: async (id: string) => (f.calls.push(['undoWrite', id]), f.undoAnswer(id)),
  },
  momoMemory: {
    onChanged: (cb: () => void) => {
      f.listeners.add(cb);
      return () => f.listeners.delete(cb);
    },
  },
});
const { WrittenChanges } = await import('../src/components/momo/WrittenChanges.tsx');

const AT = new Date(2026, 10, 6, 12).getTime();
const write = (id: string, kind: string, title: string, over: any = {}) => ({ id, kind, title, at: AT, ...over });
function reset() {
  f.calls = [];
  f.writes = [write('w3', 'complete', 'Call landlord'), write('w2', 'reminder', 'Milk'), write('w1', 'event', 'Dentist', { undone: AT })];
  f.writesAnswer = async () => ({ ok: true, writes: f.writes });
  f.undoAnswer = async (id: string) => {
    f.writes = f.writes.map((w: any) => (w.id === id ? { ...w, undone: AT } : w));
    return { ok: true };
  };
}
const flush = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });

async function mount() {
  const host = window.document.createElement('div');
  window.document.body.appendChild(host as any);
  const root = createRoot(host as any);
  await act(async () => root.render(createElement(WrittenChanges)));
  await flush();
  const all = (sel: string, el: any = host) => [...el.querySelectorAll(sel)];
  const row = (id: string) => host.querySelector(`[data-write="${id}"]`) as any;
  const button = (id: string) => all('button', row(id)).find((b: any) => b.textContent === 'Undo');
  const click = async (el: any) => {
    await act(async () => el.click());
    await flush();
  };
  return { host, all, row, button, click, text: (el: any) => el?.textContent ?? '', close: () => act(async () => root.unmount()) };
}

test('each write says what it did and when; an undone one says so and has no Undo', async () => {
  reset();
  const v = await mount();
  assert.match(v.text(v.row('w3')), /^Marked a reminder doneCall landlord/);
  assert.match(v.text(v.row('w2')), /^Added a reminderMilk/);
  assert.match(v.text(v.row('w1')), /^Added to CalendarDentist/);
  assert.deepEqual(
    v.all('.momo-chip', v.row('w1')).map((c: any) => c.textContent),
    ['2026-11-06', 'Undone'],
  );
  assert.ok(v.button('w3') && v.button('w2'));
  assert.equal(v.button('w1'), undefined);
  await v.close();
});

test('Undo asks main, the list is read again when the memory changes, and the row then reads Undone', async () => {
  reset();
  const v = await mount();
  await v.click(v.button('w2'));
  assert.deepEqual(
    f.calls.filter((c: any) => c[0] === 'undoWrite'),
    [['undoWrite', 'w2']],
  );
  await act(async () => [...f.listeners].forEach((cb: any) => cb()));
  await flush();
  assert.equal(v.button('w2'), undefined);
  assert.deepEqual(
    v.all('.momo-chip', v.row('w2')).map((c: any) => c.textContent),
    ['2026-11-06', 'Undone'],
  );
  await v.close();
});

test('a refused Undo says why under the row and keeps Undo; a call that throws says so too', async () => {
  reset();
  const v = await mount();
  f.undoAnswer = async () => ({ ok: false, error: 'It was changed or removed since, so it was left alone.' });
  await v.click(v.button('w3'));
  assert.match(v.text(v.row('w3')), /Couldn't undo: It was changed or removed since, so it was left alone\./);
  assert.ok(v.button('w3'));
  f.undoAnswer = async () => {
    throw new Error('ipc closed');
  };
  await v.click(v.button('w3'));
  assert.match(v.text(v.row('w3')), /Couldn't undo: ipc closed/);
  f.undoAnswer = async () => ({ ok: true });
  await v.click(v.button('w3'));
  assert.doesNotMatch(v.text(v.row('w3')), /Couldn't undo/);
  await v.close();
});

test('nothing shows with no writes, with MoMo off, or when the read fails', async () => {
  for (const answer of [
    async () => ({ ok: true, writes: [] }),
    async () => ({ ok: false, error: 'MoMo is not available', reason: 'not_allowed' }),
    async () => ({ ok: false, error: 'No encryption', reason: 'unavailable' }),
    async () => ({ ok: false, error: 'broken' }),
  ]) {
    reset();
    f.writesAnswer = answer;
    const v = await mount();
    assert.equal(v.host.textContent, '');
    await v.close();
  }
});
