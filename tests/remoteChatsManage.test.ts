// A chat renamed, archived or brought back from a phone (electron/remote/methods/chatsManage.cjs, app/phoneChatOps.cjs): the sidebar's own operations on Codex, Claude Code and ACP chats with no window, the name checked first, a chat main doesn't know refused, and the capabilities an older Mac lacks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rig } from './support/remote-kit.ts';
import { parseParams, MAX_CHAT_TITLE } from '../shared/remote/schema.mjs';

const require = createRequire(import.meta.url);
const { createPhoneChatOps } = require('../electron/app/phoneChatOps.cjs');
const { createPhoneLists } = require('../electron/app/chromePanelPhoneLists.cjs');

const ok = (r: any) => (assert.equal(r.ok, true, JSON.stringify(r.error)), r.result);
const fail = (r: any, code: string, message?: RegExp) => {
  assert.equal(r.ok, false, JSON.stringify(r.result));
  assert.equal(r.error.code, code, r.error.message);
  if (message) assert.match(r.error.message, message);
};

test('chats.rename and chats.archive from a phone reach main’s operations; a chat main doesn’t know is gone', async () => {
  const done: any[] = [];
  const r = rig({
    ops: {
      renameChat: async (...a: any[]) => void done.push(['rename', ...a]),
      archiveChat: async (...a: any[]) => void done.push(['archive', ...a]),
    },
  });
  const p = r.phone('p1');
  const caps = ok(await p.ask('machine.hello')).capabilities;
  assert.deepEqual([caps.renameChats, caps.archiveChats], [true, true]);
  assert.equal(caps.olderRowsHeld, true, 'this Mac pages older rows from held rows: a phone may fill them in the background (#5379)');
  assert.ok(caps.methods.includes('chats.rename') && caps.methods.includes('chats.archive'));
  assert.deepEqual(ok(await p.ask('chats.rename', { chatId: 'c1', title: '  Fix   the  build \n' })), { title: 'Fix the build' });
  assert.deepEqual(ok(await p.ask('chats.archive', { chatId: 'c1', archived: true })), { archived: true });
  assert.deepEqual(ok(await p.ask('chats.archive', { chatId: 'c2', archived: false })), { archived: false });
  assert.deepEqual(done, [
    ['rename', 'c1', 'Fix the build'],
    ['archive', 'c1', true],
    ['archive', 'c2', false],
  ]);
  fail(await p.ask('chats.rename', { chatId: 'nope', title: 'x' }), 'gone');
  fail(await p.ask('chats.archive', { chatId: 'nope', archived: true }), 'gone');
  assert.equal(done.length, 3);
  // main's refusal reaches the phone
  r.ops.renameChat = async () => {
    throw new Error('Codex did not rename it.');
  };
  fail(await p.ask('chats.rename', { chatId: 'c1', title: 'x' }), 'failed', /did not rename/);
  // the side panel never calls them
  await assert.rejects(r.service.call({ kind: 'panel' }, 'chats.rename', { chatId: 'c1', title: 'x' }), /doesn't allow/);
  // a removed phone changes nothing
  const client = r.service.phones.get('p1').client;
  r.service.phones.delete('p1');
  await assert.rejects(r.service.call(client, 'chats.archive', { chatId: 'c1', archived: true }), /no longer paired/);
  assert.equal(done.length, 3);
});

test('a Mac without the operations says so in hello, and refuses with what to do', async () => {
  const p = rig().phone('p1');
  const caps = ok(await p.ask('machine.hello')).capabilities;
  assert.deepEqual([caps.renameChats, caps.archiveChats], [false, false]);
  fail(await p.ask('chats.rename', { chatId: 'c1', title: 'x' }), 'failed', /Update MoPilot on your Mac/);
  fail(await p.ask('chats.archive', { chatId: 'c1', archived: true }), 'failed', /Update MoPilot on your Mac/);
});

test('the name and the switch are checked before anything runs', () => {
  const rename = (p: object) => parseParams('chats.rename', p) as any;
  assert.deepEqual(rename({ chatId: 'c1', title: 'a\tb' }), { chatId: 'c1', title: 'a b' });
  assert.equal(rename({ chatId: 'c1', title: 'x'.repeat(MAX_CHAT_TITLE) }).title.length, MAX_CHAT_TITLE);
  assert.throws(() => rename({ chatId: 'c1', title: 'x'.repeat(MAX_CHAT_TITLE + 1) }), /under 200/);
  assert.throws(() => rename({ chatId: 'c1', title: '   ' }), /Give the chat a name/);
  assert.throws(() => rename({ chatId: 'c1', title: 7 }), /Give the chat a name/);
  assert.throws(() => rename({ chatId: 'c1', title: 'a​b' }), /plain text/);
  assert.throws(() => rename({ title: 'x' }), /isn't in MoPilot/);
  assert.deepEqual(parseParams('chats.archive', { chatId: 'c1', archived: false }), { chatId: 'c1', archived: false });
  assert.throws(() => parseParams('chats.archive', { chatId: 'c1' }), /archive the chat or bring it back/);
  assert.throws(() => parseParams('chats.archive', { chatId: 'c1', archived: 'yes' }), /archive the chat or bring it back/);
});

for (const harness of ['codex', 'claude', 'acp:kimi']) {
  test(`main’s side for a ${harness} chat: rename on its own harness, the app’s archive, restore from it; nothing before the tools exist`, async () => {
    const calls: any[] = [];
    const live: any = {
      sessionHost: {
        setTitle: async (...a: any[]) => void calls.push(['setTitle', harness, ...a]),
        unarchive: async (...a: any[]) => void calls.push(['unarchive', ...a]),
      },
      archiveChat: (id: string) => (calls.push(['archive', id]), id !== 'stuck'),
    };
    const ops = createPhoneChatOps({ live });
    await ops.renameChat('c', 'New');
    await ops.archiveChat('c', true);
    await ops.archiveChat('c', false);
    await assert.rejects(ops.archiveChat('stuck', true), /couldn't be archived/);
    assert.deepEqual(calls, [
      ['setTitle', harness, 'c', 'New'],
      ['archive', 'c'],
      ['unarchive', 'c'],
      ['archive', 'stuck'],
    ]);
    const early = createPhoneChatOps({ live: {} });
    await assert.rejects(early.renameChat('c', 'x'), /right now/);
    await assert.rejects(early.archiveChat('c', false), /right now/);
    await assert.rejects(early.archiveChat('c', true), /couldn't be archived/);
  });
}

test('the phone lists carry the chat operations into the service’s operations', () => {
  const lists = createPhoneLists({
    live: {},
    reachable: () => true,
    historyOf: async () => ({ turns: [] }),
    recent: async () => [],
    cwdOf: async () => null,
  });
  assert.equal(typeof lists.renameChat, 'function');
  assert.equal(typeof lists.archiveChat, 'function');
});
