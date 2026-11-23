// A Host chat's repository read through its machine (src/lib/hostRepo.ts, #4103): read on open, on a turn change and on focus; an offline machine is not asked; a refusal or a failed read says why; an old answer never replaces a newer one.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h, act } from 'react';
import { createRoot } from 'react-dom/client';
import { fakeNative } from './support/ports/native.ts';
import { installNative } from '../src/lib/native.ts';
import { repoOf, useRemoteRepo, type RemoteRepo } from '../src/lib/hostRepo.ts';

const BOX = { id: 'ssh:me@box', name: 'box', away: false };
const STATUS = {
  isRepo: true as const,
  branch: 'main',
  head: 'a'.repeat(40),
  remote: null,
  files: [
    { path: 'a.ts', added: 3, removed: 1 },
    { path: 'n.ts', added: 0, removed: 0, untracked: true },
  ],
  truncated: false,
  unreadable: false,
};
let reply: () => Promise<any>;
let fake: ReturnType<typeof fakeNative>;
beforeEach(() => {
  reply = async () => ({ value: STATUS });
  fake = fakeNative({ host: { gitStatus: () => reply() } });
  installNative(fake);
});

let out: (RemoteRepo | null)[] = [];
let refresh = () => {};
function Probe(p: { machine: typeof BOX | null; folder: string; turn: string }) {
  const result = useRemoteRepo(p.machine, p.folder, p.turn);
  refresh = result.refresh;
  out.push(result.repo);
  return null;
}
async function mount(p: Parameters<typeof Probe>[0]) {
  out = [];
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  await act(async () => root.render(h(Probe, p)));
  return { set: (n: Parameters<typeof Probe>[0]) => act(async () => root.render(h(Probe, n))), end: () => act(() => root.unmount()) };
}
const last = () => out.at(-1);

test('the totals count the tracked lines and the files, and say how many are untracked', () => {
  assert.deepEqual(repoOf(STATUS), {
    state: 'ready',
    branch: 'main',
    remote: null,
    files: 2,
    added: 3,
    removed: 1,
    untracked: 1,
    truncated: false,
  });
  assert.equal(repoOf({ ...STATUS, unreadable: true }).truncated, true);
});

test('no machine, or one that is offline, is not asked; the machine’s folder is read on open and shown once it answers', async () => {
  let m = await mount({ machine: null, folder: '/srv/app', turn: '1' });
  assert.equal(last(), null);
  await m.end();
  m = await mount({ machine: { ...BOX, away: true }, folder: '/srv/app', turn: '1' });
  assert.equal(last(), null);
  assert.equal(fake.callsTo('host.gitStatus').length, 0);
  await m.end();
  m = await mount({ machine: BOX, folder: '', turn: '1' });
  assert.equal(last(), null, 'no folder');
  await m.end();
  m = await mount({ machine: BOX, folder: '/srv/app', turn: '1' });
  assert.deepEqual(last(), repoOf(STATUS));
  assert.deepEqual(fake.callsTo('host.gitStatus')[0], [BOX.id, { path: '/srv/app' }]);
  assert.deepEqual(out[0], { state: 'loading' }, 'reading first');
  await m.end();
});

test('a changed turn, a focused window and a manual refresh read again; the same turn does not', async () => {
  const m = await mount({ machine: BOX, folder: '/srv/app', turn: '1' });
  assert.equal(fake.callsTo('host.gitStatus').length, 1);
  await m.set({ machine: BOX, folder: '/srv/app', turn: '1' });
  assert.equal(fake.callsTo('host.gitStatus').length, 1);
  await m.set({ machine: BOX, folder: '/srv/app', turn: '2' });
  assert.equal(fake.callsTo('host.gitStatus').length, 2);
  await act(async () => void window.dispatchEvent(new Event('focus')));
  assert.equal(fake.callsTo('host.gitStatus').length, 3);
  await act(refresh);
  assert.equal(fake.callsTo('host.gitStatus').length, 4);
  await m.end();
});

test('not a repository, a refusal and a failed read each say so; the answer of another folder is not shown', async () => {
  reply = async () => ({ value: { isRepo: false } });
  let m = await mount({ machine: BOX, folder: '/srv', turn: '1' });
  assert.deepEqual(last(), { state: 'none' });
  await m.end();
  reply = async () => ({ error: { message: 'x', code: 'outside_roots' } });
  m = await mount({ machine: BOX, folder: '/etc', turn: '1' });
  assert.deepEqual(last(), { state: 'unavailable', notice: 'That folder is outside what this machine shares.' });
  await m.end();
  reply = async () => ({ error: { message: 'x', code: 'host_outdated' } });
  m = await mount({ machine: BOX, folder: '/srv', turn: '1' });
  assert.deepEqual(last(), { state: 'unavailable', notice: 'Update the Host on that machine.' });
  await m.end();
  reply = async () => {
    throw new Error('ipc closed');
  };
  m = await mount({ machine: BOX, folder: '/srv', turn: '1' });
  assert.deepEqual(last(), { state: 'unavailable', notice: 'Could not read the folder on the machine.' });
  await m.end();
  // a slow answer for the folder left is dropped, and the folder that replaced it shows its own
  let release!: (v: any) => void;
  reply = () => new Promise((r) => (release = r));
  m = await mount({ machine: BOX, folder: '/old', turn: '1' });
  const slow = release;
  reply = async () => ({ value: { ...STATUS, branch: 'new' } });
  await m.set({ machine: BOX, folder: '/new', turn: '1' });
  await act(async () => slow({ value: { ...STATUS, branch: 'old' } }));
  assert.equal((last() as any).branch, 'new');
  await m.end();
});

test('a read that fails after the folder changed is dropped', async () => {
  let fail!: (e: Error) => void;
  reply = () => new Promise((_ok, no) => (fail = no));
  const m = await mount({ machine: BOX, folder: '/old', turn: '1' });
  const failOld = fail;
  reply = async () => ({ value: STATUS });
  await m.set({ machine: BOX, folder: '/new', turn: '1' });
  await act(async () => failOld(new Error('late')));
  assert.equal(last()?.state, 'ready');
  await m.end();
});

test('reconnecting to the same machine retires its old snapshot and ignores earlier refresh failures', async () => {
  const props = { machine: BOX, folder: '/srv/app', turn: '1' };
  const m = await mount(props);
  assert.equal(last()?.state, 'ready');
  let fail!: (error: Error) => void;
  reply = () => new Promise((_resolve, reject) => (fail = reject));
  await act(refresh);
  await m.set({ ...props, machine: { ...BOX, away: true } });
  assert.equal(last(), null);
  let resolve!: (value: unknown) => void;
  reply = () => new Promise((r) => (resolve = r));
  await m.set(props);
  assert.deepEqual(last(), { state: 'loading' });
  await act(async () => fail(Error('retired connection')));
  assert.deepEqual(last(), { state: 'loading' });
  await act(async () => resolve({ value: { ...STATUS, branch: 'reconnected' } }));
  assert.equal((last() as any).branch, 'reconnected');
  await m.end();
});
