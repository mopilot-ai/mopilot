// What an agent on a machine offers in its `/` menu (src/lib/hostCommands.ts, #4915): asked once per machine, agent and folder while the answer is fresh, shared by whoever asks meanwhile, never kept when it is a failure or an agent with no list yet, and not asked at all until the menu is open.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h, act } from 'react';
import { createRoot } from 'react-dom/client';
import { fakeNative } from './support/ports/native.ts';
import { installNative } from '../src/lib/native.ts';
import { COMMANDS_FRESH_MS, askHostCommands, resetHostCommands, useHostCommands, type CatalogRequest } from '../src/lib/hostCommands.ts';

const compact = { name: 'compact', description: 'Summarize', kind: 'command' as const, insert: '/compact ' };
let reply: (id: string, q: any) => Promise<any>;
let fake: ReturnType<typeof fakeNative>;
beforeEach(() => {
  resetHostCommands();
  reply = async () => ({ value: { listed: true, commands: [compact] } });
  fake = fakeNative({ host: { commands: (id: string, q: any) => reply(id, q) } });
  installNative(fake);
});
const asks = () => fake.callsTo('host.commands');

test('a list is asked with the agent and folder, kept while fresh for that machine, agent and folder, and asked again after', async () => {
  const first = await askHostCommands('box', 'claude', '/srv/app', '', 1000);
  assert.deepEqual(first, { state: 'ready', listed: true, commands: [compact] });
  assert.deepEqual(asks()[0], ['box', { harness: 'claude', cwd: '/srv/app' }]);
  await askHostCommands('box', 'claude', '/srv/app', '', 1000 + COMMANDS_FRESH_MS - 1);
  assert.equal(asks().length, 1, 'fresh: nothing asked');
  // another agent, another folder and another machine are other lists
  await askHostCommands('box', 'codex', '/srv/app', '', 1000);
  await askHostCommands('box', 'claude', '/srv/other', '', 1000);
  await askHostCommands('other', 'claude', '/srv/app', '', 1000);
  // the chat that follows a new chat asks again: its agent may have learned more by running
  await askHostCommands('box', 'claude', '/srv/app', 'chat-1', 1000);
  assert.equal(asks().length, 5);
  await askHostCommands('box', 'claude', '/srv/app', '', 1000 + COMMANDS_FRESH_MS);
  assert.equal(asks().length, 6, 'no longer fresh: asked again');
});

test('no folder is asked without one; a request made while another is running is the same request', async () => {
  let release: (v: unknown) => void = () => undefined;
  reply = () => new Promise((r) => (release = r));
  const a = askHostCommands('box', 'acp:kimi', '');
  const b = askHostCommands('box', 'acp:kimi', '');
  assert.equal(asks().length, 1);
  assert.deepEqual(asks()[0], ['box', { harness: 'acp:kimi' }]);
  release({ value: { listed: true, commands: [] } });
  assert.deepEqual(await a, await b);
});

test('an agent with no list yet, a Host that cannot list, and a failure are shown but never kept', async () => {
  reply = async () => ({ value: { listed: false, commands: [] } });
  assert.deepEqual(await askHostCommands('box', 'claude', '/p'), { state: 'ready', listed: false, commands: [] });
  reply = async () => ({ value: { listed: false, commands: [], outdated: true } });
  assert.deepEqual(await askHostCommands('box', 'claude', '/p'), { state: 'outdated' });
  reply = async () => ({ error: { message: 'Not allowed.', code: 'forbidden' } });
  const refused: any = await askHostCommands('box', 'claude', '/p');
  assert.equal(refused.state, 'unavailable');
  assert.ok(refused.notice.length > 0);
  reply = () => Promise.reject(new Error('socket closed'));
  assert.deepEqual(await askHostCommands('box', 'claude', '/p'), { state: 'unavailable', notice: 'Could not reach that machine.' });
  assert.equal(asks().length, 4, 'each was asked for again');
  reply = async () => ({ value: { listed: true, commands: [compact] } });
  assert.equal(((await askHostCommands('box', 'claude', '/p')) as any).state, 'ready');
});

let seen: unknown[] = [];
type Props = { machine: string | null; harness: string | null; folder: string; want: CatalogRequest };
type Observe = (answer: ReturnType<typeof useHostCommands>) => void;
function Probe(p: Props & { observe?: Observe }) {
  const answer = useHostCommands(p.machine, p.harness, p.folder, p.want);
  seen.push(answer);
  p.observe?.(answer);
  return null;
}
async function mount(p: Props, observe?: Observe) {
  seen = [];
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  await act(async () => root.render(h(Probe, { ...p, observe })));
  return { set: (n: Props) => act(async () => root.render(h(Probe, { ...n, observe }))), end: () => root.unmount() };
}

test('the menu asks nothing until it is open, says loading until the machine answers, and has nothing for a chat with no machine or agent', async () => {
  let m = await mount({ machine: null, harness: 'claude', folder: '/p', want: true });
  assert.equal(seen.at(-1), null);
  await m.end();
  m = await mount({ machine: 'box', harness: null, folder: '/p', want: true });
  assert.equal(seen.at(-1), null);
  await m.end();
  assert.equal(asks().length, 0);

  m = await mount({ machine: 'box', harness: 'claude', folder: '/p', want: false });
  assert.deepEqual(seen.at(-1), { state: 'loading' });
  assert.equal(asks().length, 0, 'closed: not asked');
  await m.set({ machine: 'box', harness: 'claude', folder: '/p', want: true });
  assert.deepEqual(seen.at(-1), { state: 'ready', listed: true, commands: [compact] });
  assert.equal(asks().length, 1);
  await m.end();
});

test('an answer that comes after the menu moved on is not shown for it', async () => {
  let release: (v: unknown) => void = () => undefined;
  reply = () => new Promise((r) => (release = r));
  const m = await mount({ machine: 'box', harness: 'claude', folder: '/a', want: true });
  await m.set({ machine: 'box', harness: 'claude', folder: '/a', want: false });
  await act(async () => release({ value: { listed: true, commands: [compact] } }));
  assert.deepEqual(seen.at(-1), { state: 'loading' }, 'the closed menu keeps no answer');
  await m.end();
});

test('opening the slash menu over an expired draft catalog waits for current commands', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const props = { machine: 'box', harness: 'claude', folder: '/p' };
  const m = await mount({ ...props, want: 'draft' });
  try {
    assert.deepEqual(seen.at(-1), { state: 'ready', listed: true, commands: [compact] });
    assert.equal(asks().length, 1);
    now += COMMANDS_FRESH_MS;
    let release: (value: unknown) => void = () => assert.fail('the menu did not refresh');
    reply = () => new Promise((resolve) => (release = resolve));
    await m.set({ ...props, want: true });
    assert.deepEqual(seen.at(-1), { state: 'loading' });
    assert.equal(asks().length, 2);
    await act(async () => release({ value: { listed: true, commands: [] } }));
    assert.deepEqual(seen.at(-1), { state: 'ready', listed: true, commands: [] });
    await m.set({ ...props, want: false });
    await m.set({ ...props, want: true });
    assert.equal(asks().length, 2, 'the fresh list is reused without another request');
    await m.set({ ...props, folder: '/other', want: false });
    assert.deepEqual(seen.at(-1), { state: 'loading' }, 'a closed menu on a different folder has no previous list');
    assert.equal(asks().length, 2);
  } finally {
    await act(async () => m.end());
  }
});

test('a draft refresh retires expired rows in a menu that is already open for the same Host catalog', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const props = { machine: 'box', harness: 'claude', folder: '/p' };
  let menu: unknown;
  const open = await mount({ ...props, want: true }, (answer) => (menu = answer));
  try {
    assert.deepEqual(menu, { state: 'ready', listed: true, commands: [compact] });
    now += COMMANDS_FRESH_MS;
    let release: (value: unknown) => void = () => assert.fail('the draft did not refresh');
    reply = () => new Promise((resolve) => (release = resolve));
    const draft = await mount({ ...props, want: 'draft' });
    try {
      assert.equal(asks().length, 2);
      assert.deepEqual(menu, { state: 'loading' });
      await act(async () => release({ value: { listed: true, commands: [] } }));
      assert.deepEqual(menu, { state: 'ready', listed: true, commands: [] });
    } finally {
      await act(async () => draft.end());
    }
  } finally {
    await act(async () => open.end());
  }
});
