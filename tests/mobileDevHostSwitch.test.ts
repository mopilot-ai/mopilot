// The dev host's agent switch and pace (scripts/mobile-dev-host/fakeSwitch.mjs): a move waits for the chat's next message as the Mac holds it, the menus name it, its own agent calls it off, the next message settles it with a note row, and `latency` slows the calls of a chat's controls (#4986 F3 timings).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeApp } from '../scripts/mobile-dev-host/fakeApp.mjs';
import { createFakeSwitch } from '../scripts/mobile-dev-host/fakeSwitch.mjs';

const rig = (latency = 0) => {
  const slept: number[] = [];
  const log: string[] = [];
  const app = createFakeApp({
    repo: '/repo',
    log: (l: string) => log.push(l),
    now: () => 1,
    sleep: async (ms: number) => void slept.push(ms),
    status: async () => '',
    latency,
  });
  const chat = [...app.chats.values()].find((c: any) => c.harness === 'claude') ?? [...app.chats.values()][0];
  return { app, chat, slept, log };
};

test('a move waits: the menus name the agent it goes to and say switching; its own agent again calls it off', async () => {
  const { app, chat, log } = rig();
  const other = chat.harness === 'codex' ? 'claude' : 'codex';
  assert.equal((await app.ops.options({ chatId: chat.id })).switching, false);
  await app.ops.switchHarness({ chatId: chat.id, harness: other });
  const held = await app.ops.options({ chatId: chat.id });
  assert.deepEqual([held.harnessId, held.switching], [other, true]);
  assert.equal(chat.harness === other, false, 'the chat still runs where it was');
  await app.ops.switchHarness({ chatId: chat.id, harness: chat.harness });
  const back = await app.ops.options({ chatId: chat.id });
  assert.deepEqual([back.harnessId, back.switching], [chat.harness, false]);
  assert.ok(log.some((l) => l.startsWith('app: switch ')));
  await assert.rejects(app.ops.switchHarness({ chatId: 'nope', harness: other }), /isn't in MoPilot/);
});

test('the chat’s next message settles a waiting move with a note row; a chat with none moves nothing', async () => {
  const rows: string[] = [];
  const chats = new Map<string, any>([['c', { id: 'c', harness: 'claude', rows: [] }]]);
  const sw = createFakeSwitch({ chats, log: () => undefined, sleep: async () => undefined });
  const note = (_chat: unknown, role: string, text: string) => rows.push(`${role}:${text}`);
  sw.settle('c', note);
  assert.deepEqual(rows, []);
  await sw.switchHarness({ chatId: 'c', harness: 'codex' });
  assert.equal(sw.shownFor('c'), 'codex');
  sw.settle('c', note);
  assert.deepEqual(rows, ['note:Moved to Codex']);
  assert.deepEqual([chats.get('c').harness, sw.held('c'), sw.shownFor('c')], ['codex', false, 'codex']);
  // an agent the list does not name reads by its id
  await sw.switchHarness({ chatId: 'c', harness: 'acp:x' });
  sw.settle('c', note);
  assert.equal(rows.at(-1), 'note:Moved to acp:x');
});

test('latency slows the calls of a chat’s controls and nothing else; none leaves the app as it is', async () => {
  const slow = rig(150);
  await slow.app.ops.options({ chatId: slow.chat.id });
  await slow.app.ops.harnesses();
  await slow.app.ops.choose({ chatId: slow.chat.id, model: 'm', effort: null });
  await slow.app.ops.permit({ chatId: slow.chat.id, value: 'default' });
  assert.deepEqual(slow.slept, [150, 150, 150, 150]);
  slow.slept.length = 0;
  slow.app.ops.reachable(slow.chat.id);
  assert.deepEqual(slow.slept, []);
  const quick = rig();
  await quick.app.ops.options({ chatId: quick.chat.id });
  assert.deepEqual(quick.slept, []);
  // a call the app does not have is skipped, not invented
  const bare = createFakeSwitch({ chats: new Map(), log: () => undefined, sleep: async () => undefined, latency: 5 });
  assert.deepEqual(Object.keys(bare.slow({ other: () => 1 })), ['other']);
});

test('a refused switch says its message and holds nothing', async () => {
  const chats = new Map<string, any>([['c', { id: 'c', harness: 'claude', rows: [] }]]);
  const sw = createFakeSwitch({ chats, log: () => undefined, sleep: async () => undefined, refuse: 'Codex is not signed in on this Mac.' });
  await assert.rejects(sw.switchHarness({ chatId: 'c', harness: 'codex' }), /not signed in/);
  assert.equal(sw.held('c'), false);
});
