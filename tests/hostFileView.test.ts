// A machine's folder entries and file text read through its Host (src/lib/hostFileView.ts, #4104): one request per path, the last answer kept while a reload asks again, and a refusal said in words.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h, act } from 'react';
import { createRoot } from 'react-dom/client';
import { fakeNative } from './support/ports/native.ts';
import { installNative } from '../src/lib/native.ts';
import { useRemoteDiff, useRemoteFile, useRemoteTree } from '../src/lib/hostFileView.ts';

let tree: () => Promise<any>;
let read: () => Promise<any>;
let diff: () => Promise<any>;
let fake: ReturnType<typeof fakeNative>;
beforeEach(() => {
  tree = async () => ({ value: { path: '/srv', entries: [], truncated: false } });
  read = async () => ({ value: { kind: 'text', text: 'hi', size: 2, truncated: false } });
  diff = async () => ({ value: { isRepo: true, patch: 'diff --git a/x b/x\n', truncated: false, unreadable: false } });
  fake = fakeNative({ host: { fsTree: () => tree(), fsRead: () => read(), gitDiff: () => diff() } });
  installNative(fake);
});
let out: any[] = [];
type Props = { kind: 'tree' | 'file' | 'diff'; path: string; reload: number | string };
// one component per hook, so each is called the same way on every render
const PROBES = {
  tree: (p: Props) => (out.push(useRemoteTree('m', p.path, p.reload as number)), null),
  file: (p: Props) => (out.push(useRemoteFile('m', p.path, p.reload as number)), null),
  diff: (p: Props) => (out.push(useRemoteDiff('m', p.path, 'branch', p.reload)), null),
};
async function mount(p: Props) {
  out = [];
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  await act(async () => root.render(h(PROBES[p.kind], p)));
  return { set: (n: Props) => act(async () => root.render(h(PROBES[n.kind], n))), end: () => root.unmount() };
}

test('a folder and a file are asked once, first as loading; the same path is not asked again', async () => {
  let m = await mount({ kind: 'tree', path: '/srv', reload: 0 });
  assert.deepEqual(out[0], { state: 'loading' });
  assert.deepEqual(out.at(-1), { state: 'ready', value: { path: '/srv', entries: [], truncated: false } });
  assert.deepEqual(fake.callsTo('host.fsTree'), [['m', { path: '/srv' }]]);
  await m.set({ kind: 'tree', path: '/srv', reload: 0 });
  assert.equal(fake.callsTo('host.fsTree').length, 1);
  await m.end();
  m = await mount({ kind: 'file', path: '/srv/a.ts', reload: 0 });
  assert.equal(out.at(-1).value.text, 'hi');
  assert.deepEqual(fake.callsTo('host.fsRead'), [['m', { path: '/srv/a.ts' }]]);
  await m.end();
});

test('a reload asks again and keeps the last answer meanwhile; another path starts from loading', async () => {
  const m = await mount({ kind: 'file', path: '/srv/a.ts', reload: 0 });
  let release!: (v: any) => void;
  read = () => new Promise((r) => (release = r));
  await m.set({ kind: 'file', path: '/srv/a.ts', reload: 1 });
  assert.equal(out.at(-1).state, 'ready', 'the old text stays while it reads again');
  await act(async () => release({ value: { kind: 'binary', size: 9 } }));
  assert.deepEqual(out.at(-1), { state: 'ready', value: { kind: 'binary', size: 9 } });
  read = async () => ({ value: { kind: 'text', text: 'b', size: 1, truncated: false } });
  await m.set({ kind: 'file', path: '/srv/b.ts', reload: 1 });
  assert.equal(
    out.some((o) => o.state === 'loading'),
    true,
  );
  assert.equal(out.at(-1).value.text, 'b');
  await m.end();
});

test('a refusal and a failed read say why; an answer for a path left is dropped', async () => {
  read = async () => ({ error: { message: 'x', code: 'not_a_file' } });
  let m = await mount({ kind: 'file', path: '/srv', reload: 0 });
  assert.deepEqual(out.at(-1), { state: 'unavailable', notice: 'That is not a file.' });
  await m.end();
  tree = async () => {
    throw new Error('ipc closed');
  };
  m = await mount({ kind: 'tree', path: '/srv', reload: 0 });
  assert.deepEqual(out.at(-1), { state: 'unavailable', notice: 'Could not read that on the machine.' });
  await m.end();
  let slow!: (v: any) => void;
  read = () => new Promise((r) => (slow = r));
  m = await mount({ kind: 'file', path: '/old', reload: 0 });
  const late = slow;
  read = async () => ({ value: { kind: 'text', text: 'new', size: 3, truncated: false } });
  await m.set({ kind: 'file', path: '/new', reload: 0 });
  await act(async () => late({ value: { kind: 'text', text: 'old', size: 3, truncated: false } }));
  assert.equal(out.at(-1).value.text, 'new');
  await m.end();
});

test('a patch is asked for by scope and folder, and again when the reload key changes', async () => {
  const m = await mount({ kind: 'diff', path: '/srv/app', reload: '0|a' });
  assert.equal(out.at(-1).value.patch, 'diff --git a/x b/x\n');
  assert.deepEqual(fake.callsTo('host.gitDiff'), [['m', { path: '/srv/app', scope: 'branch' }]]);
  await m.set({ kind: 'diff', path: '/srv/app', reload: '0|a' });
  assert.equal(fake.callsTo('host.gitDiff').length, 1);
  await m.set({ kind: 'diff', path: '/srv/app', reload: '0|b' });
  assert.equal(fake.callsTo('host.gitDiff').length, 2);
  await m.end();
});
