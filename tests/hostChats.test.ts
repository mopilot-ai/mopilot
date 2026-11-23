// Which chats run on a machine (src/lib/hostChats.ts): one shared read answers every reader, a read not answered keeps folders unread, a failed read is tried again and never says "on a machine", and a chat just started there is known at once.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h, act } from 'react';
import { createRoot } from 'react-dom/client';
import { fakeNative } from './support/ports/native.ts';
import { installNative } from '../src/lib/native.ts';

let allowed = true;
let answered = true;
mock.module('../src/lib/host.ts', {
  namedExports: { useHostAccess: () => allowed, useHostAnswered: () => answered, hostAllowedNow: () => allowed },
});
const lib = await import('../src/lib/hostChats.ts');
const { useReloadHostChatsOn } = await import('../src/lib/hostChatsSync.ts');
const { onMachineNow, useHostChats, machineOfChat, chatFolderHere, reloadHostChats, noteHostChat, resetHostChats, retryDelay } = lib;

let rows: { chatId: string; hostId: string }[] | 'fail' | 'junk' = [];
let fake: ReturnType<typeof fakeNative>;
const install = () => {
  fake = fakeNative({
    host: {
      remoteChats: async () => {
        if (rows === 'fail') throw new Error('ipc closed');
        return rows as never;
      },
    },
  });
  installNative(fake);
};
let seen: ReturnType<typeof useHostChats>[] = [];
function Probe({ count = 0 }: { count?: number }) {
  seen.push(useHostChats());
  useReloadHostChatsOn(count);
  return null;
}
const mounts: (() => void)[] = [];
async function mount(count = 0) {
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  await act(async () => root.render(h(Probe, { count })));
  mounts.push(() => root.unmount());
  return { rerender: (c: number) => act(async () => root.render(h(Probe, { count: c }))) };
}
const last = () => seen.at(-1)!;

beforeEach(() => {
  while (mounts.length) mounts.pop()!();
  resetHostChats();
  allowed = true;
  answered = true;
  rows = [];
  seen = [];
  install();
});

test('nothing is known until main answers; then the chats on machines, and a chat not among them is this Mac’s', async () => {
  rows = [{ chatId: 'c1', hostId: 'ssh:me@box' }];
  answered = false;
  await mount();
  assert.equal(last().status, 'unknown');
  assert.equal(machineOfChat(last(), 'c1'), null, 'not answered: unknown');
  answered = true;
  seen = [];
  await mount();
  assert.equal(machineOfChat(last(), 'c1'), 'ssh:me@box');
  assert.equal(machineOfChat(last(), 'c2'), '');
  assert.equal(machineOfChat(last(), null), '', 'no chat yet: this Mac');
  assert.equal(await chatFolderHere('c1', '/w'), '');
  assert.equal(await chatFolderHere('c2', '/w'), '/w');
  assert.equal(await chatFolderHere(null, '/w'), '/w');
});

test('without Host there are none, rows share one read, and a changed chat list reads again', async () => {
  allowed = false;
  await mount();
  assert.deepEqual([last().status, last().owners.size], ['ready', 0]);
  assert.equal(fake.callsTo('host.remoteChats').length, 0);
  while (mounts.length) mounts.pop()!();
  allowed = true;
  seen = [];
  await mount(3);
  await mount(3);
  await mount(3);
  assert.equal(fake.callsTo('host.remoteChats').length, 1, 'rows that mount together ask once');
  const again = await mount(3);
  await again.rerender(5);
  assert.equal(fake.callsTo('host.remoteChats').length, 2, 'a changed chat list reads again');
  await again.rerender(5);
  assert.equal(fake.callsTo('host.remoteChats').length, 2, 'the same list does not');
});

test('a failed read says nothing about any chat and is tried again; an answer that is no list names none', async () => {
  retryDelay.ms = 5;
  rows = 'fail';
  await mount();
  assert.equal(last().status, 'failed');
  assert.equal(machineOfChat(last(), 'c1'), '', 'failed: this Mac’s, not a machine');
  rows = [{ chatId: 'c1', hostId: 'box' }];
  await act(async () => void (await new Promise((r) => setTimeout(r, 40))));
  assert.equal(machineOfChat(last(), 'c1'), 'box');
  rows = 'junk' as never;
  fake = fakeNative({ host: { remoteChats: async () => ({}) as never } });
  installNative(fake);
  await act(async () => reloadHostChats());
  assert.equal(last().owners.size, 0);
});

test('a chat just started on a machine is known before the next read', async () => {
  await mount();
  await act(async () => noteHostChat('new', 'box'));
  assert.equal(machineOfChat(last(), 'new'), 'box');
  assert.equal(await chatFolderHere('new', '/w'), '');
});

test('code outside a component waits for the first read, sees none without Host, and takes a failed read as this Mac’s', async () => {
  rows = [{ chatId: 'c1', hostId: 'box' }];
  assert.equal(await chatFolderHere('c1', '/w'), '', 'asked before any read: it waits for one');
  assert.equal(fake.callsTo('host.remoteChats').length, 1);
  resetHostChats();
  allowed = false;
  assert.equal(await chatFolderHere('c1', '/w'), '/w', 'no Host: nothing is on a machine');
  allowed = true;
  rows = 'fail';
  retryDelay.ms = 60_000;
  assert.equal(await chatFolderHere('c1', '/w'), '/w', 'a failed read says nothing about the chat');
  resetHostChats();
});

test('a read asked for while one is under way runs again when it ends, so a move or a new chat meanwhile is in its answer', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let call = 0;
  fake = fakeNative({
    host: {
      remoteChats: async () => {
        call++;
        if (call === 1) await gate;
        return call === 1 ? [] : [{ chatId: 'moved', hostId: 'box' }];
      },
    },
  });
  installNative(fake);
  await mount();
  const first = reloadHostChats();
  const second = reloadHostChats();
  assert.equal(first, second, 'the one under way is joined');
  await act(async () => {
    release();
    await first;
    await new Promise((r) => setTimeout(r, 10));
  });
  assert.equal(call, 2, 'one more read followed it');
  assert.equal(machineOfChat(last(), 'moved'), 'box');
});

test('a read with nothing new does not draw the rows again, and a window that takes focus reads again while Host exists', async () => {
  rows = [{ chatId: 'c1', hostId: 'box' }];
  const probe = await mount();
  const drawn = seen.length;
  await act(async () => reloadHostChats());
  assert.equal(seen.length, drawn, 'the same answer publishes nothing');
  const before = fake.callsTo('host.remoteChats').length;
  await act(async () => void window.dispatchEvent(new Event('focus')));
  assert.equal(fake.callsTo('host.remoteChats').length, before + 1);
  allowed = false;
  await probe.rerender(0);
  await act(async () => void window.dispatchEvent(new Event('focus')));
  assert.equal(fake.callsTo('host.remoteChats').length, before + 1, 'without Host nothing is read');
});

test('code that must not touch this Mac’s disk asks whether a chat is on a machine, or may be', async () => {
  rows = [{ chatId: 'c1', hostId: 'box' }];
  assert.equal(onMachineNow(null), false, 'no chat');
  allowed = false;
  assert.equal(onMachineNow('c1'), false, 'no Host: nothing is on a machine');
  allowed = true;
  assert.equal(onMachineNow('c1'), true, 'Host exists and the chats are not read yet: it may be');
  await act(async () => reloadHostChats());
  assert.equal(onMachineNow('c1'), true, 'read: it is');
  assert.equal(onMachineNow('c2'), false, 'read: it is not');
});

test('live destination identity and change subscriptions distinguish every remote owner', async () => {
  allowed = false;
  assert.equal(lib.hostOfChatNow('c'), '');
  allowed = true;
  assert.equal(lib.hostOfChatNow(null), '');
  assert.equal(lib.hostOfChatNow('c'), null);
  let changes = 0;
  const off = lib.subscribeHostChats(() => changes++);
  noteHostChat('c', 'A');
  assert.equal(lib.hostOfChatNow('c'), null, 'unknown list remains unresolved');
  rows = [{ chatId: 'c', hostId: 'A' }];
  await reloadHostChats();
  assert.equal(lib.hostOfChatNow('c'), 'A');
  noteHostChat('c', 'B');
  assert.equal(lib.hostOfChatNow('c'), 'B');
  assert.equal(lib.hostOfChatNow('local-chat'), '');
  assert.ok(changes >= 2);
  off();
});
