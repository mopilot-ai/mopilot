// A side chat started from a phone (electron/remote/methods/chatsManage.cjs chat.sideChat, app/phoneSideChat.cjs): the Mac's temporary fork made in main with no window, per harness; what a phone is told of it in hello; and what an older Mac or a harness without a fork says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rig } from './support/remote-kit.ts';
import { parseParams } from '../shared/remote/schema.mjs';

const require = createRequire(import.meta.url);
const { createPhoneSideChat } = require('../electron/app/phoneSideChat.cjs');

const ok = (r: any) => (assert.equal(r.ok, true, JSON.stringify(r.error)), r.result);
const fail = (r: any, code: string, message?: RegExp) => {
  assert.equal(r.ok, false, JSON.stringify(r.result));
  assert.equal(r.error.code, code, r.error.message);
  if (message) assert.match(r.error.message, message);
};

test('chat.sideChat from a phone reaches main’s operation and answers the new chat’s id; a chat main doesn’t know is gone', async () => {
  const asked: string[] = [];
  const r = rig({ ops: { sideChat: async (chatId: string) => (asked.push(chatId), 'side-1') } });
  const p = r.phone('p1');
  const caps = ok(await p.ask('machine.hello')).capabilities;
  assert.equal(caps.sideChats, true);
  assert.ok(caps.methods.includes('chat.sideChat'));
  assert.deepEqual(ok(await p.ask('chat.sideChat', { chatId: 'c1' })), { chatId: 'side-1' });
  assert.deepEqual(asked, ['c1']);
  fail(await p.ask('chat.sideChat', { chatId: 'nope' }), 'gone');
  assert.deepEqual(asked, ['c1']);
  // the side panel never calls it, and a phone the Mac removed changes nothing
  await assert.rejects(r.service.call({ kind: 'panel' }, 'chat.sideChat', { chatId: 'c1' }), /doesn't allow/);
  const client = r.service.phones.get('p1').client;
  r.service.phones.delete('p1');
  await assert.rejects(r.service.call(client, 'chat.sideChat', { chatId: 'c1' }), /no longer paired/);
  assert.deepEqual(asked, ['c1']);
});

test('main’s own refusal reaches the phone with its code, and any other failure is a failure', async () => {
  const r = rig({ ops: { sideChat: async () => undefined } });
  const p = r.phone('p1');
  r.ops.sideChat = async () => {
    throw Object.assign(new Error("Side chats aren't available for this agent."), { code: 'side_chat_unavailable' });
  };
  fail(await p.ask('chat.sideChat', { chatId: 'c1' }), 'side_chat_unavailable', /aren't available for this agent/);
  r.ops.sideChat = async () => {
    throw new Error('Codex could not fork it.');
  };
  fail(await p.ask('chat.sideChat', { chatId: 'c1' }), 'failed', /could not fork/);
});

test('a Mac without the operation says so in hello, and refuses with what to do', async () => {
  const p = rig().phone('p1');
  assert.equal(ok(await p.ask('machine.hello')).capabilities.sideChats, false);
  fail(await p.ask('chat.sideChat', { chatId: 'c1' }), 'failed', /Update MoPilot on your Mac/);
});

test('the request names a chat', () => {
  assert.deepEqual(parseParams('chat.sideChat', { chatId: 'c1', selection: 'ignored' }), { chatId: 'c1' });
  assert.throws(() => parseParams('chat.sideChat', {}), /isn't in MoPilot/);
});

/** The services main late-binds that a side chat reads: the parent's native ref, Claude's sessions and own picks, Codex's fork and logins. */
function live(kind: string, key: string, extra: Record<string, any> = {}) {
  const calls: any[] = [];
  const own = new Map<string, any>(extra.own ?? []);
  return {
    calls,
    live: {
      controller: {
        ref: () => ({ kind, key }),
        // the parent's state tells what its session reports; any other id is a fork being made known
        state: { get: (id: string) => (id === 'c1' ? { permission: extra.reported ?? null } : (calls.push(['state', id]), {})) },
      },
      claudeTurns: {
        own,
        sessions: new Map<string, any>(extra.sessions ?? []),
        registerSession: (id: string, info: any) => calls.push(['register', id, info]),
        setOwn: (id: string, o: any) => calls.push(['own', id, o]),
      },
      codex: {
        meta: new Map<string, any>(extra.meta ?? []),
        fork: async (params: any, hold: boolean) => (calls.push(['fork', params, hold]), { thread: { id: 'thread-2' } }),
      },
      chats: { records: new Map<string, any>(extra.config ? [['c1', { meta: { config: extra.config } }]] : []) },
      accounts: extra.accounts,
    },
  };
}
/** The side chat service for these services, on an app whose default permission is `permission`. */
const service = (l: any, cwd: string | null = '/work', permission = 'default') =>
  createPhoneSideChat({ live: l, cwdOf: async () => cwd, prefs: () => ({ permission }) });
const side = (l: any, cwd: string | null = '/work', permission = 'default') => service(l, cwd, permission).sideChat('c1');

test('a Claude Code chat’s side chat is a new unpersisted session that forks the parent’s on its first message, on the parent’s own picks', async () => {
  const k = live('claude', 'claude:parent-uuid', { own: [['c1', { model: 'opus', effort: 'high', account: 'work' }]] });
  const id = await side(k.live);
  assert.match(id, /^claude:[0-9a-f-]{36}$/);
  assert.deepEqual(k.calls, [
    ['register', id, { cwd: '/work', ephemeral: true, forkFrom: 'parent-uuid' }],
    ['own', id, { model: 'opus', effort: 'high', account: 'work' }],
    ['state', id],
  ]);
  // a chat with no pick of its own passes none, and a chat with no folder none
  const bare = live('claude', 'claude:p2');
  const id2 = await side(bare.live, null);
  assert.notEqual(id2, id);
  assert.deepEqual(bare.calls, [
    ['register', id2, { cwd: null, ephemeral: true, forkFrom: 'p2' }],
    ['state', id2],
  ]);
});

test('a Codex chat’s side chat is an ephemeral fork without its turns, held, on the login the chat is pinned to', async () => {
  const pinned = new Map([['thr-1', { id: 'login-b', sticky: true }]]);
  const pins: any[] = [];
  const k = live('codex', 'thr-1', { accounts: { pins: pinned, pinChat: (...a: any[]) => pins.push(a) } });
  assert.equal(await side(k.live), 'thread-2');
  assert.deepEqual(k.calls, [
    ['fork', { threadId: 'thr-1', excludeTurns: true, ephemeral: true }, true],
    ['state', 'thread-2'],
  ]);
  assert.deepEqual(pins, [['thread-2', 'login-b']]);
  // not pinned (the pool's choice), pinned but not for good, or no account relay: nothing to carry over
  for (const accounts of [
    { pins: new Map(), pinChat: (...a: any[]) => pins.push(a) },
    { pins: new Map([['thr-1', { id: 'x', sticky: false }]]), pinChat: (...a: any[]) => pins.push(a) },
    undefined,
  ]) {
    assert.equal(await side(live('codex', 'thr-1', { accounts }).live), 'thread-2');
  }
  assert.equal(pins.length, 1);
});

test('a side chat is not forked again: the Mac’s own or a phone’s is refused, from the harness’s record of the session, and nothing is made', async () => {
  const nested = [
    live('claude', 'claude:temp', { sessions: [['claude:temp', { ephemeral: true }]] }),
    live('codex', 'thr-temp', { meta: [['thr-temp', { id: 'thr-temp', ephemeral: true }]] }),
  ];
  for (const k of nested) {
    await assert.rejects(side(k.live), (e: any) => e.code === 'side_chat_unavailable' && /can't start another side chat/.test(e.message));
    assert.deepEqual(k.calls, []);
  }
  // a durable chat (a session or thread the harness records as not temporary, or does not record at all) is forked
  const durable = live('claude', 'claude:main', { sessions: [['claude:main', { ephemeral: false }]] });
  assert.match(await side(durable.live), /^claude:/);
  assert.equal(await side(live('codex', 'thr-1', { meta: [['thr-1', { id: 'thr-1', ephemeral: false }]] }).live), 'thread-2');
});

test('a chat has one side chat, as the Mac reuses its side pane: asking again, or twice at once, answers the same fork; a failure is tried again', async () => {
  const k = live('codex', 'thr-1');
  const svc = service(k.live);
  const [a, b] = await Promise.all([svc.sideChat('c1'), svc.sideChat('c1')]);
  assert.equal(a, 'thread-2');
  assert.equal(b, 'thread-2');
  assert.equal(await svc.sideChat('c1'), 'thread-2');
  assert.equal(k.calls.filter((c: any[]) => c[0] === 'fork').length, 1);
  // a fork that fails is not kept: the next ask makes one
  const flaky = live('codex', 'thr-1');
  let fails = 1;
  flaky.live.codex.fork = async () => {
    if (fails-- > 0) throw new Error('Codex could not fork it.');
    return { thread: { id: 'thread-3' } };
  };
  const again = service(flaky.live);
  await assert.rejects(again.sideChat('c1'), /could not fork/);
  assert.equal(await again.sideChat('c1'), 'thread-3');
  // the Claude fork too: one session for the chat
  const claude = live('claude', 'claude:parent');
  const cs = service(claude.live);
  assert.equal(await cs.sideChat('c1'), await cs.sideChat('c1'));
  assert.equal(claude.calls.filter((c: any[]) => c[0] === 'register').length, 1);
});

test('what a phone sent to a side chat is kept, oldest first and bounded, and nothing is kept for any other chat', async () => {
  const svc = service(live('claude', 'claude:parent').live);
  const id = await svc.sideChat('c1');
  assert.deepEqual(svc.sideChatIds(), new Set([id]));
  svc.sideChatAsked('claude:not-a-fork', 'ignored');
  assert.deepEqual(svc.sideChatQuestions('claude:not-a-fork'), []);
  svc.sideChatAsked(id, 'first');
  svc.sideChatAsked(id, 'second');
  assert.deepEqual(svc.sideChatQuestions(id), ['first', 'second']);
  for (let i = 0; i < 60; i++) svc.sideChatAsked(id, `q${i}`);
  const kept = svc.sideChatQuestions(id);
  assert.equal(kept.length, 50);
  assert.deepEqual([kept[0], kept.at(-1)], ['q10', 'q59'], 'the oldest go first');
});

test('a login that cannot be kept leaves the Codex fork on the pool’s choice instead of losing it', async () => {
  const accounts = {
    pins: new Map([['thr-1', { id: 'login-b', sticky: true }]]),
    pinChat: () => {
      throw new Error('That login is gone.');
    },
  };
  const k = live('codex', 'thr-1', { accounts });
  assert.equal(await side(k.live), 'thread-2');
  assert.deepEqual(k.calls.at(-1), ['state', 'thread-2']);
});

test('a side chat never has more permission than the chat it came from: refused when the app’s default is broader, with what to do', async () => {
  const refused = (e: any) => e.code === 'side_chat_unavailable' && /Change it to default first/.test(e.message);
  // the chat is read-only by its file, or by what its session reports; the app's default is broader
  for (const extra of [{ config: { permission: 'read-only' } }, { reported: 'readOnly' }]) {
    const k = live('claude', 'claude:p', extra);
    await assert.rejects(side(k.live), refused);
    assert.deepEqual(k.calls, []);
  }
  // as broad (its own pick, or the default) or broader than the default: forked
  assert.match(await side(live('claude', 'claude:p', { config: { permission: 'default' } }).live), /^claude:/);
  assert.match(await side(live('claude', 'claude:p', { config: { permission: 'full-access' } }).live), /^claude:/);
  assert.match(await side(live('claude', 'claude:p').live), /^claude:/);
  // a chat in Plan mode is named so, not by its id
  await assert.rejects(
    side(live('claude', 'claude:p', { config: { permission: 'plan' } }).live),
    /This chat is set to Plan mode. Change it to default first/,
  );
  // an app whose default is read-only forks a read-only chat; one whose default is broader refuses it, naming the mode
  assert.match(await side(live('claude', 'claude:p', { config: { permission: 'read-only' } }).live, '/work', 'read-only'), /^claude:/);
  await assert.rejects(
    side(live('claude', 'claude:p', { config: { permission: 'read-only' } }).live, '/work', 'auto-review'),
    /This chat is set to read-only. Change it to auto-review first/,
  );
});

test('a basic (ACP) harness has no temporary fork: refused with the code the phone reads, and nothing is made', async () => {
  // a chat on a machine is a basic harness's id on this Mac (acp:host-…): the Mac refuses it too
  for (const kind of ['acp:kimi', 'acp', 'acp:host-claude', 'something-else']) {
    const k = live(kind, 'x');
    await assert.rejects(side(k.live), (e: any) => e.code === 'side_chat_unavailable' && /aren't available for this agent/.test(e.message));
    assert.deepEqual(k.calls, []);
  }
});

test('the stand-in Mac forks an unlisted side chat, refuses a basic agent and an unknown chat, and still renames and archives', async () => {
  const { fakeChatOps } = await import('../scripts/mobile-dev-host/fakeChatOps.mjs');
  const chats = new Map<string, any>([
    ['c1', { id: 'c1', title: 'One', harness: 'claude' }],
    ['a1', { id: 'a1', title: 'Basic', harness: 'acp:kimi' }],
  ]);
  const log: string[] = [];
  const ops = fakeChatOps({ chats, add: (c: any) => (chats.set(c.id, c), c), log: (l: string) => log.push(l), now: () => 7 });
  assert.equal(await ops.sideChat('c1'), 'c1-side-1');
  assert.equal(await ops.sideChat('c1'), 'c1-side-1', 'asked again, the same side chat');
  assert.deepEqual(chats.get('c1-side-1'), { id: 'c1-side-1', title: 'Side chat', harness: 'claude', at: 7, unlisted: true });
  await assert.rejects(ops.sideChat('a1'), (e: any) => e.code === 'side_chat_unavailable');
  await assert.rejects(ops.sideChat('nope'), /isn't in MoPilot/);
  await ops.renameChat('c1', 'Two');
  await ops.archiveChat('c1', true);
  await ops.archiveChat('c1', false);
  assert.deepEqual([chats.get('c1').title, chats.get('c1').archived], ['Two', false]);
  assert.equal(log.length, 4);
});

test('on the stand-in a side chat is in no list but a phone can follow it and send to it, and an unknown chat is not', async () => {
  const { createFakeApp } = await import('../scripts/mobile-dev-host/fakeApp.mjs');
  const app = createFakeApp({
    repo: '/repo',
    log: () => undefined,
    now: () => 5_000_000,
    sleep: async () => undefined,
    status: async () => '',
  });
  const id = await app.ops.sideChat('dev-seed-readme');
  assert.equal(id, 'dev-seed-readme-side-1');
  assert.equal(app.ops.reachable(id), true);
  assert.equal(app.ops.reachable('dev-seed-readme'), true);
  assert.ok(!(await app.ops.recent(50)).some((c: any) => c.id === id), 'in no list');
  assert.equal(app.ops.reachable('nope'), false);
});

test('the stand-in’s side-chat scenario makes a Claude Code chat and a basic agent’s, each with a finished reply', async () => {
  const { createFakeApp } = await import('../scripts/mobile-dev-host/fakeApp.mjs');
  const { createScenarios } = await import('../scripts/mobile-dev-host/scenarios.mjs');
  const app = createFakeApp({
    repo: '/repo',
    log: () => undefined,
    now: () => 5_000_000,
    sleep: async () => undefined,
    status: async () => '',
  });
  const out = await createScenarios({ app, now: () => 5_000_000, after: (_ms: number, fn: () => void) => fn() }).run('side-chat');
  const [claude, basic] = [...out.matchAll(/dev-bench-\d+/g)].map((m) => m[0]);
  assert.equal(await app.ops.sideChat(claude), `${claude}-side-1`);
  assert.equal(await app.ops.sideChat(claude), `${claude}-side-1`);
  await assert.rejects(app.ops.sideChat(basic), (e: any) => e.code === 'side_chat_unavailable');
  assert.match(out, /--fake-hosts/);
});
