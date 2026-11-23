// The Outputs section of MoMo's right panel (src/components/momo/MomoOutputs.tsx, useMomoOutputs.ts): loading, unreadable, empty and listed (newest first, eight shown and the rest behind Show all), Open on a click, the menu's Show in Finder, Save a copy and Delete, a gone file dimmed with only Delete, the after-reading-your-data note, a failed click saying why, and the list read again when main says a file changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h } from 'react';
import { render, click, flush } from './support/shell-chrome-kit.ts';
import { deferred } from './support/async-scenarios.ts';
import { installNativeStub } from './support/ports/native.ts';

const calls: any[] = [];
let list: () => Promise<any> = async () => ({ ok: true, files: [] });
let act: (name: string, id: string) => Promise<any> = async () => ({ ok: true });
let changed: (() => void) | null = null;
installNativeStub({
  momoOutputs: {
    list: () => list(),
    open: (id: string) => (calls.push(['open', id]), act('open', id)),
    reveal: (id: string) => (calls.push(['reveal', id]), act('reveal', id)),
    saveCopy: (id: string) => (calls.push(['saveCopy', id]), act('saveCopy', id)),
    remove: (id: string) => (calls.push(['remove', id]), act('remove', id)),
    onChanged: (cb: () => void) => ((changed = cb), () => (changed = null)),
  },
});
const { MomoOutputs } = await import('../src/components/momo/MomoOutputs.tsx');

const file = (n: number, over: object = {}) => ({
  id: `o${n}`,
  name: `f${n}.md`,
  type: 'md',
  size: n === 1 ? 500 : n === 2 ? 2500 : 2_500_000,
  at: Date.now() - n * 60_000,
  note: '',
  fromPrivate: false,
  gone: false,
  ...over,
});
const settle = async () => {
  for (let i = 0; i < 4; i++) await flush();
};
const mount = async () => {
  const r = await render(h(MomoOutputs));
  await settle();
  return r;
};
const reset = () => {
  calls.length = 0;
  list = async () => ({ ok: true, files: [] });
  act = async () => ({ ok: true });
};
const button = (r: any, label: string) => r.host.querySelector(`[aria-label="${label}"]`) as HTMLElement;
const menuItem = (r: any, name: string) =>
  [...r.host.querySelectorAll('[role=menuitem]')].find((b: any) => b.textContent === name) as HTMLElement;

test('loading, unreadable and empty each say so', async () => {
  reset();
  const wait = deferred<any>();
  list = () => wait.promise;
  const r = await render(h(MomoOutputs));
  assert.equal(r.host.textContent, 'Loading…');
  wait.resolve({ ok: false, error: 'sealed with another key' });
  await settle();
  assert.equal(r.host.textContent, 'Couldn’t read your files.');
  list = async () => {
    throw new Error('ipc down');
  };
  changed!();
  await settle();
  assert.equal(r.host.textContent, 'Couldn’t read your files.');
  list = async () => ({ ok: true, files: [] });
  changed!();
  await settle();
  assert.equal(r.host.textContent, 'Files MoMo makes show up here.');
});

test('listed: name, size and age, the after-reading note, the not-encrypted line, and Open on a click; a failed click says why, a good one clears it', async () => {
  reset();
  list = async () => ({ ok: true, files: [file(1), file(2, { fromPrivate: true }), file(3)] });
  const r = await mount();
  const rows = [...r.host.querySelectorAll('li')].map((li: any) => li.querySelector('button')?.textContent);
  assert.match(rows[0], /^f1\.md500 B · /);
  assert.match(rows[1], /^f2\.md2\.5 KB · .* · After reading your data$/);
  assert.match(rows[2], /^f3\.md2\.5 MB · /);
  assert.match(r.host.textContent, /Stored on this Mac, not encrypted\. Reset MoMo deletes them\.$/);
  act = async () => ({ ok: false, error: 'The file is no longer there' });
  await click(button(r, 'Open f1.md'));
  await settle();
  assert.equal(r.host.querySelector('[role=alert]')!.textContent, 'The file is no longer there');
  act = async () => ({ ok: true });
  await click(button(r, 'Open f2.md'));
  await settle();
  assert.equal(r.host.querySelector('[role=alert]'), null);
  act = async () => {
    throw new Error('ipc');
  };
  await click(button(r, 'Open f3.md'));
  await settle();
  assert.equal(r.host.querySelector('[role=alert]')!.textContent, 'Something went wrong');
  act = async () => ({ ok: false });
  await click(button(r, 'Open f3.md'));
  await settle();
  assert.equal(r.host.querySelector('[role=alert]')!.textContent, 'Something went wrong');
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['open', 'open', 'open', 'open'],
  );
});

test('the menu: Show in Finder, Save a copy and Delete act on that file; a gone file is dimmed and offers only Delete', async () => {
  reset();
  list = async () => ({ ok: true, files: [file(1), file(2, { gone: true })] });
  const r = await mount();
  assert.equal(r.host.querySelector('[role=menu]'), null);
  await click(button(r, 'Actions for f1.md'));
  assert.equal(button(r, 'Actions for f1.md').getAttribute('aria-expanded'), 'true');
  await click(menuItem(r, 'Show in Finder'));
  assert.equal(r.host.querySelector('[role=menu]'), null, 'the menu closes when an item is chosen');
  await click(button(r, 'Actions for f1.md'));
  await click(menuItem(r, 'Save a copy…'));
  await click(button(r, 'Actions for f1.md'));
  await click(menuItem(r, 'Delete'));
  await click(button(r, 'Actions for f1.md'));
  assert.deepEqual(calls, [
    ['reveal', 'o1'],
    ['saveCopy', 'o1'],
    ['remove', 'o1'],
  ]);
  await click(button(r, 'Actions for f1.md'));
  assert.equal(r.host.querySelector('[role=menu]'), null);
  await click(button(r, 'Actions for f2.md'));
  assert.deepEqual(
    [...r.host.querySelectorAll('[role=menuitem]')].map((b: any) => b.textContent),
    ['Delete'],
  );
  const gone = r.host.querySelector('[data-gone]')!;
  assert.match(gone.textContent, /File no longer there/);
  assert.equal((button(r, 'f2.md, file no longer there') as HTMLButtonElement).disabled, true);
});

test('more than eight files: eight shown, Show all and Show less, and a change in main reads the list again', async () => {
  reset();
  list = async () => ({ ok: true, files: Array.from({ length: 10 }, (_, i) => file(i + 1)) });
  const r = await mount();
  assert.equal(r.host.querySelectorAll('li').length, 8);
  const more = [...r.host.querySelectorAll('button')].find((b: any) => /^Show all 10$/.test(b.textContent))!;
  await click(more);
  assert.equal(r.host.querySelectorAll('li').length, 10);
  await click([...r.host.querySelectorAll('button')].find((b: any) => b.textContent === 'Show less')!);
  assert.equal(r.host.querySelectorAll('li').length, 8);
  list = async () => ({ ok: true, files: [file(1)] });
  changed!();
  await settle();
  assert.equal(r.host.querySelectorAll('li').length, 1);
  r.unmount?.();
});
