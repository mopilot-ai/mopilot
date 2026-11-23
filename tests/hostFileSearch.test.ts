// The @ popup's file search on a machine (src/lib/hostFileSearch.ts, #4106): asked after a pause, the latest query wins, an answer is kept for its query while the popup is open, a failure is not kept, and nothing is asked without a machine and a folder.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h, act } from 'react';
import { createRoot } from 'react-dom/client';
import { fakeNative } from './support/ports/native.ts';
import { installNative } from '../src/lib/native.ts';
import { SEARCH_DELAY_MS, SEARCH_LIMIT, useRemoteSearch, type RemoteSearch } from '../src/lib/hostFileSearch.ts';

let reply: (q: string) => Promise<any>;
let fake: ReturnType<typeof fakeNative>;
beforeEach(() => {
  reply = async (q) => ({ value: { files: [`${q}.ts`], truncated: false } });
  fake = fakeNative({ host: { fsSearch: (_id: string, o: { query: string }) => reply(o.query) } });
  installNative(fake);
});
let out: RemoteSearch[] = [];
type Props = { machineId: string | null; folder: string; query: string };
function Probe(p: Props) {
  out.push(useRemoteSearch(p.machineId, p.folder, p.query));
  return null;
}
async function mount(p: Props) {
  out = [];
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  await act(async () => root.render(h(Probe, p)));
  return { set: (n: Props) => act(async () => root.render(h(Probe, n))), end: () => root.unmount() };
}
const wait = (ms = SEARCH_DELAY_MS + 60) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const asks = () => fake.callsTo('host.fsSearch').map((c) => (c[1] as any).query);

test('nothing is asked without a machine or a folder', async () => {
  let m = await mount({ machineId: null, folder: '/srv', query: 'a' });
  await wait();
  assert.deepEqual(out.at(-1), { state: 'ready', files: [] });
  await m.end();
  m = await mount({ machineId: 'm', folder: '', query: 'a' });
  await wait();
  assert.deepEqual(out.at(-1), { state: 'ready', files: [] });
  assert.deepEqual(asks(), []);
  await m.end();
});

test('a query is asked after the pause with the folder and the limit, searching until it answers; typing on asks only for the last', async () => {
  const m = await mount({ machineId: 'ssh:me@box', folder: '/srv/app', query: 'a' });
  assert.deepEqual(out.at(-1), { state: 'searching' });
  await m.set({ machineId: 'ssh:me@box', folder: '/srv/app', query: 'ab' });
  await m.set({ machineId: 'ssh:me@box', folder: '/srv/app', query: 'abc' });
  await wait();
  assert.deepEqual(asks(), ['abc'], 'the first two were replaced before the pause ended');
  assert.deepEqual(fake.callsTo('host.fsSearch')[0], ['ssh:me@box', { path: '/srv/app', query: 'abc', limit: SEARCH_LIMIT }]);
  assert.deepEqual(out.at(-1), { state: 'ready', files: ['abc.ts'] });
  await m.end();
});

test('an answer is kept for its query: going back to it asks nothing and shows it at once; another query starts from searching', async () => {
  const m = await mount({ machineId: 'm', folder: '/srv', query: 'a' });
  await wait();
  await m.set({ machineId: 'm', folder: '/srv', query: 'b' });
  assert.deepEqual(out.at(-1), { state: 'searching' }, 'not a’s answer');
  await wait();
  await m.set({ machineId: 'm', folder: '/srv', query: 'a' });
  assert.deepEqual(out.at(-1), { state: 'ready', files: ['a.ts'] });
  await wait();
  assert.deepEqual(asks(), ['a', 'b']);
  await m.end();
});

test('a refusal and a failed search say so, are not kept, and a slow answer for a query left is dropped', async () => {
  reply = async () => ({ error: { message: 'x', code: 'outside_roots' } });
  let m = await mount({ machineId: 'm', folder: '/etc', query: 'a' });
  await wait();
  assert.deepEqual(out.at(-1), { state: 'unavailable', notice: 'That folder is outside what this machine shares.' });
  reply = async () => {
    throw new Error('ipc closed');
  };
  await m.set({ machineId: 'm', folder: '/etc', query: 'b' });
  await wait();
  assert.deepEqual(out.at(-1), { state: 'unavailable', notice: 'Could not search that machine.' });
  // back to a query that failed: it is asked again
  reply = async () => ({ value: { files: ['ok.ts'], truncated: false } });
  await m.set({ machineId: 'm', folder: '/etc', query: 'a' });
  await wait();
  assert.deepEqual(out.at(-1), { state: 'ready', files: ['ok.ts'] });
  await m.end();
  let release!: (v: any) => void;
  reply = () => new Promise((r) => (release = r));
  m = await mount({ machineId: 'm', folder: '/srv', query: 'slow' });
  await wait();
  const late = release;
  reply = async () => ({ value: { files: ['fast.ts'], truncated: false } });
  await m.set({ machineId: 'm', folder: '/srv', query: 'fast' });
  await wait();
  await act(async () => late({ value: { files: ['slow.ts'], truncated: false } }));
  assert.deepEqual(out.at(-1), { state: 'ready', files: ['fast.ts'] });
  await m.end();
});

test('going back to a query that failed shows searching while it is asked again, not the old failure', async () => {
  reply = async () => {
    throw new Error('ipc closed');
  };
  const m = await mount({ machineId: 'm', folder: '/srv', query: 'a' });
  await wait();
  assert.equal(out.at(-1)!.state, 'unavailable');
  await m.set({ machineId: 'm', folder: '/srv', query: 'b' });
  let release!: (v: any) => void;
  reply = () => new Promise((r) => (release = r));
  await m.set({ machineId: 'm', folder: '/srv', query: 'a' });
  assert.deepEqual(out.at(-1), { state: 'searching' });
  await wait();
  await act(async () => release({ value: { files: ['a.ts'], truncated: false } }));
  assert.deepEqual(out.at(-1), { state: 'ready', files: ['a.ts'] });
  await m.end();
});
