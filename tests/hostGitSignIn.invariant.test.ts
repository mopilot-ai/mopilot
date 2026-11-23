// Git's sign-in on a machine, shown (electron/host/gitSignInRead.cjs, src/lib/hostGitSignIn.ts, MachineRow, the composer's note): main reads it once per ask and says 'unknown' for anything unclear; the row shows one line only for 'no' and only on an online machine, read once per online machine and again when it comes back, never polled; a Host chat shows one line when its latest turn carries the Host's own "no sign-in" line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createElement as h } from 'react';
import { mockStore, autoMock, render, resetStore, setStore, settle, native } from './support/thread-kit.ts';
import { gitSignInChatNote, gitSignInHostIn, gitSignInRowNote, useGitSignIn } from '../src/lib/hostGitSignIn.ts';
import { fakeNative } from './support/ports/native.ts';

const require = createRequire(import.meta.url);
const { createGitSignInRead } = require('../electron/host/gitSignInRead.cjs');

mockStore();
let machineNow: { id: string; name: string; away: boolean } | null = { id: 'ssh:me@box', name: 'box', away: false };
autoMock('src/lib/chatMachine.ts', 'chatMachine', { useChatMachine: () => ({ machine: machineNow, pending: false }) });
const { useGitSignInNote, GitSignInNote } = await import('../src/components/composer/GitSignInNote.tsx');

test('main: one short connection per ask, closed after; a Host answers per repository host and anything else is unknown', async () => {
  let closed = 0;
  const order: string[] = [];
  const open =
    (answer: unknown, fail = false) =>
    async () => ({
      call: async (method: string, params: any, opts: any) => {
        order.push(method);
        // `host.status` is a request of the versioned protocol: the connection says hello first (#5050)
        if (method === 'host.hello') return {};
        assert.equal(method, 'host.status');
        assert.equal(order.at(-2), 'host.hello');
        assert.deepEqual(params, { signIn: ['github.com'] });
        assert.equal(opts.timeoutMs, 8000);
        if (fail) throw new Error('x');
        return answer;
      },
      close: () => void closed++,
    });
  const read = (o: any) => createGitSignInRead({ open: o });
  assert.deepEqual(await read(open({ gitSignIn: { 'github.com': 'no' } }))('m'), { 'github.com': 'no' });
  assert.deepEqual(await read(open({ gitSignIn: { 'github.com': 'yes' } }))('m'), { 'github.com': 'yes' });
  assert.deepEqual(await read(open({ gitSignIn: { 'github.com': 'maybe' } }))('m'), { 'github.com': 'unknown' });
  assert.deepEqual(await read(open({}))('m'), { 'github.com': 'unknown' }, 'an older Host says nothing');
  assert.deepEqual(await read(open(null))('m'), { 'github.com': 'unknown' });
  assert.deepEqual(await read(open(null, true))('m'), { 'github.com': 'unknown' }, 'a failed read');
  assert.equal(closed, 6, 'every connection is closed, answered or not');
  const unreachable = async () => {
    throw new Error('no route');
  };
  assert.deepEqual(await read(unreachable)('m'), { 'github.com': 'unknown' });
});

test('the lines: short, naming the host and the machine; the Host’s own line is found in command and tool results', () => {
  assert.equal(gitSignInRowNote('github.com'), 'Git isn’t signed in to github.com');
  assert.equal(gitSignInChatNote('github.com', 'box'), 'Git isn’t signed in to github.com on box');
  const line =
    'MoPilot: git has no sign-in on this machine for https://github.com. Sign in here (for example gh auth login), or do this from the Mac.';
  assert.equal(gitSignInHostIn([{ type: 'commandExecution', aggregatedOutput: `fatal: x\n${line}\nfatal: y` }]), 'github.com');
  assert.equal(gitSignInHostIn([{ type: 'mcpToolCall', result: { content: [{ type: 'text', text: line }] } }]), 'github.com');
  assert.equal(gitSignInHostIn([{ type: 'mcpToolCall', error: { message: line } }]), 'github.com');
  // text that only talks about the line (the Host's own source, a doc) names no address and is not the line
  assert.equal(gitSignInHostIn([{ aggregatedOutput: 'MoPilot: git has no sign-in on this machine%s. Sign in here' }]), null);
  assert.equal(gitSignInHostIn([{ aggregatedOutput: 'fatal: could not read Username' }, null, 'text', {}]), null);
  assert.equal(gitSignInHostIn([]), null);
  for (const item of [
    { type: 'commandExecution', aggregatedOutput: 'To get started with GitHub CLI, please run:  gh auth login' },
    { type: 'mcpToolCall', result: { content: [{ type: 'text', text: 'To get started with GitHub CLI, please run:\n  gh auth login' }] } },
  ])
    assert.equal(gitSignInHostIn([item]), 'github.com');
});

const row = (id: string, status: 'online' | 'offline' | 'attention' = 'online') => ({ id, name: id, status }) as any;

test('the row’s reading: once per online machine, again when it comes back, never on a timer; a failed or unclear read shows nothing', async () => {
  const asked: string[] = [];
  let answer: Record<string, any> = { 'ssh:a': { 'github.com': 'no' }, 'ssh:b': { 'github.com': 'yes' }, 'ssh:d': {} };
  native.host = {
    ...fakeNative().host,
    gitSignIn: async (id: string) => (asked.push(id), id === 'ssh:c' ? Promise.reject(new Error('x')) : answer[id]),
  } as any;
  let seen: ReadonlyMap<string, string> = new Map();
  let machines = [row('ssh:a'), row('ssh:b'), row('ssh:c'), row('ssh:d'), row('ssh:e', 'offline')];
  const Probe = () => ((seen = useGitSignIn(machines)), null);
  const view = await render(h(Probe));
  await settle(() => undefined);
  assert.deepEqual([...asked].sort(), ['ssh:a', 'ssh:b', 'ssh:c', 'ssh:d'], 'the offline machine is not asked');
  assert.deepEqual([...seen].sort(), [
    ['ssh:a', 'no'],
    ['ssh:b', 'yes'],
  ]);
  // listed again with the same online set: no new read
  machines = [...machines];
  await view.rerender(h(Probe));
  await settle(() => undefined);
  assert.equal(asked.length, 4);
  // a machine goes offline and comes back: its old answer is dropped, then read again
  machines = [row('ssh:a', 'offline'), row('ssh:b'), row('ssh:c'), row('ssh:d')];
  await view.rerender(h(Probe));
  await settle(() => undefined);
  assert.equal(seen.has('ssh:a'), false);
  answer = { ...answer, 'ssh:a': { 'github.com': 'yes' } };
  machines = [row('ssh:a'), row('ssh:b'), row('ssh:c'), row('ssh:d')];
  await view.rerender(h(Probe));
  await settle(() => undefined);
  assert.equal(asked.filter((id) => id === 'ssh:a').length, 2);
  assert.equal(seen.get('ssh:a'), 'yes');
  // an answer that arrives for a machine that went offline meanwhile is dropped
  let late!: (v: any) => void;
  native.host = { ...fakeNative().host, gitSignIn: () => new Promise((r) => (late = r)) } as any;
  machines = [row('ssh:z')];
  await view.rerender(h(Probe));
  machines = [];
  await view.rerender(h(Probe));
  late({ 'github.com': 'no' });
  await settle(() => undefined);
  assert.equal(seen.has('ssh:z'), false);
  await view.unmount();
});

test('the row’s reading: a machine that could not say is asked again when its status changes, and an older read never overwrites a newer one', async () => {
  const waiting: ((v: any) => void)[] = [];
  const answers: any[] = [{ 'github.com': 'unknown' }];
  native.host = {
    ...fakeNative().host,
    gitSignIn: () => (answers.length ? Promise.resolve(answers.shift()) : new Promise((r) => waiting.push(r))),
  } as any;
  let seen: ReadonlyMap<string, string> = new Map();
  let machines = [row('ssh:a', 'attention')];
  const Probe = () => ((seen = useGitSignIn(machines)), null);
  const view = await render(h(Probe));
  await settle(() => undefined);
  assert.equal(seen.has('ssh:a'), false, 'unknown shows nothing');
  // it comes online: asked again, and this time the answer waits
  machines = [row('ssh:a', 'online')];
  await view.rerender(h(Probe));
  assert.equal(waiting.length, 1);
  // it goes away and comes back: a third read; the first of the two answers late, after the newer one
  machines = [row('ssh:a', 'offline')];
  await view.rerender(h(Probe));
  machines = [row('ssh:a', 'online')];
  await view.rerender(h(Probe));
  assert.equal(waiting.length, 2);
  waiting[1]({ 'github.com': 'yes' });
  await settle(() => undefined);
  waiting[0]({ 'github.com': 'no' });
  await settle(() => undefined);
  assert.equal(seen.get('ssh:a'), 'yes');
  await view.unmount();
});

const turn = (items: unknown[], running = false) =>
  setStore({
    runtime: { t1: { loaded: true, activeTurnId: running ? 'turn1' : null, turns: [{ id: 'turn1', status: 'completed', items }] } },
  });
const LINE =
  'MoPilot: git has no sign-in on this machine for https://github.com. Sign in here (for example gh auth login), or do this from the Mac.';

test('the chat’s line: the machine’s name and the host, only for a Host chat whose finished turn carries the Host’s line', async () => {
  resetStore();
  let note: string | null = null;
  const Probe = ({ id }: { id: string | null }) => ((note = useGitSignInNote(id)), null);
  turn([{ type: 'commandExecution', aggregatedOutput: LINE }]);
  const view = await render(h(Probe, { id: 't1' }));
  assert.equal(note, 'Git isn’t signed in to github.com on box');
  await settle(() => turn([{ type: 'commandExecution', aggregatedOutput: LINE }], true));
  assert.equal(note, null, 'not while a turn runs');
  await settle(() => turn([{ type: 'commandExecution', aggregatedOutput: 'fatal: could not read Username' }]));
  assert.equal(note, null, 'git’s own words alone say nothing');
  await settle(() => turn([{ type: 'commandExecution', aggregatedOutput: LINE }]));
  machineNow = null;
  await view.rerender(h(Probe, { id: 't1' }));
  assert.equal(note, null, 'a chat on this Mac');
  machineNow = { id: 'ssh:me@box', name: 'box', away: false };
  await view.rerender(h(Probe, { id: null }));
  assert.equal(note, null, 'no chat');
  await view.unmount();
});

test('the component draws the sign-in action for the failed turn, then clears it on the next turn', async () => {
  native.host = fakeNative().host;
  resetStore();
  turn([{ type: 'commandExecution', aggregatedOutput: LINE }]);
  const view = await render(h(GitSignInNote, { threadId: 't1' }));
  const el = view.host.querySelector('[data-git-signin-note]')!;
  assert.equal(el.querySelector('.fa-title')?.textContent, 'Git isn’t signed in to github.com on box');
  assert.equal(el.getAttribute('title'), null, 'the recovery action needs no separate terminal instruction');
  assert.ok(el.querySelector('button'), 'the missing sign-in offers an actionable recovery');
  await settle(() => turn([]));
  assert.equal(view.host.querySelector('[data-git-signin-note]'), null);
  await view.unmount();
});
