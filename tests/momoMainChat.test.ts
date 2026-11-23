// electron/momo/mainChat.cjs (#2139): MoMo's one main chat, made once however many ask at a time, kept across restarts,
// replaced when it is gone or archived, tagged before any window hears of it, and refused while MoMo is off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { gate, world } from './support/momoWorld.ts';

const require = createRequire(import.meta.url);
const { ChatsStore } = require('../electron/platform/chats.cjs');

test('refused while MoMo is off, everything but telling whether a chat is MoMo’s', async () => {
  const w = world();
  const id = (await w.svc.ensureMainChat()).chatId;
  w.allowed = false;
  await assert.rejects(w.svc.ensureMainChat(), { code: 'not_allowed' });
  assert.throws(() => w.svc.getBrain(), { code: 'not_allowed' });
  assert.throws(() => w.svc.mainChatId(), { code: 'not_allowed' });
  // the lists keep skipping its chat whatever the invite says
  assert.equal(w.svc.isMomoChat(id), true);
  assert.equal(w.svc.isMomoChat('other'), false);
});

test('concurrent calls make one chat, in MoMo’s workspace, tagged before any window hears of it, and its id persists', async () => {
  const w = world();
  const g = gate();
  w.codexGate = g.p;
  const a = w.svc.ensureMainChat();
  const b = w.svc.ensureMainChat();
  g.open();
  const [ra, rb] = await Promise.all([a, b]);
  assert.deepEqual(ra, { chatId: 'th1', warning: null });
  assert.deepEqual(rb, ra);
  const workspace = path.join(w.root, 'momo', 'workspace');
  assert.deepEqual(
    w.log.filter((l: any) => l[0] === 'codex'),
    [['codex', workspace]],
  );
  assert.ok(fs.statSync(workspace).isDirectory());
  // owner-only, like the rest of MoMo's folder (open-mode, docs/bug-prevention/data-at-rest.md)
  assert.equal(fs.statSync(workspace).mode & 0o777, 0o700);
  assert.deepEqual(w.log.at(-1), ['started', 'th1', 'main']);
  assert.equal(JSON.parse(fs.readFileSync(w.stateFile, 'utf8')).mainChatId, 'th1');
  assert.equal(w.svc.mainChatId(), 'th1');
  // a later call (another window, a restart) finds the same chat
  assert.deepEqual(await w.svc.ensureMainChat(), { chatId: 'th1', warning: null });
  const again = world({ dir: w.root, prefs: w.prefs });
  assert.deepEqual(await again.svc.ensureMainChat(), { chatId: 'th1', warning: null });
  assert.equal(again.log.length, 0);
});

test('a failed start makes no chat and the next call tries again', async () => {
  const w = world();
  w.codexFails = true;
  await assert.rejects(w.svc.ensureMainChat(), /Codex is down/);
  assert.equal(fs.existsSync(w.stateFile), false);
  assert.equal(w.svc.mainChatId(), null);
  w.codexFails = false;
  assert.equal((await w.svc.ensureMainChat()).chatId, 'th1');
});

test('a saved chat that is archived, gone or untagged is replaced; an archived one stays MoMo’s as previous', async () => {
  const w = world();
  const first = (await w.svc.ensureMainChat()).chatId;
  w.chats.patchMeta(first, { archived: 1 });
  const second = (await w.svc.ensureMainChat()).chatId;
  assert.notEqual(second, first);
  assert.equal(w.chats.records.get(first).meta.momo, 'previous');
  assert.equal(w.svc.isMomoChat(first), true);
  // deleted: a new one
  w.chats.isDeleted = (id: string) => id === second;
  const third = (await w.svc.ensureMainChat()).chatId;
  assert.ok(![first, second].includes(third));
  // named nowhere (never saved, or its record is gone): the chat still tagged main
  w.chats.isDeleted = () => false;
  w.chats.records.delete(second);
  fs.writeFileSync(w.stateFile, JSON.stringify({ mainChatId: 'nowhere' }));
  w.svc = w.make();
  assert.equal(w.svc.mainChatId(), third);
  // a chat with no MoMo tag is never taken for MoMo's
  w.chats.patchMeta('plain', { pinned: true });
  fs.writeFileSync(w.stateFile, JSON.stringify({ mainChatId: 'plain' }));
  w.svc = w.make();
  assert.equal(w.svc.mainChatId(), third);
  assert.equal(w.chats.records.get('plain').meta.momo, null);
});

test('state.json missing or unreadable: the newest chat still tagged main is MoMo’s, and the file is kept aside', async () => {
  let t = 1000;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-'));
  const chats = new ChatsStore(path.join(root, 'threads'), { legacyMirror: false, now: () => t });
  chats.patchMeta('old', { momo: 'main' });
  t = 2000;
  chats.patchMeta('new', { momo: 'main' });
  t = 3000;
  chats.patchMeta('previous', { momo: 'previous' });
  const w = world({ dir: root });
  // the same records, read again by the service's store; there is one main chat from now
  assert.equal(w.svc.mainChatId(), 'new');
  assert.equal(w.chats.records.get('old').meta.momo, 'previous');
  assert.equal(JSON.parse(fs.readFileSync(w.stateFile, 'utf8')).mainChatId, 'new');
  // the file is read once: a restart finds it unreadable
  fs.writeFileSync(w.stateFile, '{not json');
  assert.equal(w.svc.mainChatId(), 'new');
  w.svc = w.make();
  assert.equal(w.svc.mainChatId(), 'new');
  assert.equal(fs.readFileSync(`${w.stateFile}.unreadable`, 'utf8'), '{not json');
  assert.equal((await w.svc.ensureMainChat()).chatId, 'new');
  assert.equal(w.log.filter((l: any) => l[0] !== 'started').length, 0);
});

test('MoMo turned off while a call waits its turn refuses it, and makes no chat', async () => {
  const w = world();
  const g = gate();
  w.codexGate = g.p;
  const made = w.svc.ensureMainChat();
  // a call queued behind the first sees MoMo off when its turn comes
  const { chatId } = await (async () => {
    g.open();
    return made;
  })();
  w.chats.patchMeta(chatId, { archived: 1 });
  const late = w.svc.ensureMainChat();
  w.allowed = false;
  await assert.rejects(late, { code: 'not_allowed' });
  assert.equal(w.log.filter((l: any) => l[0] === 'codex').length, 1);
});

test('every window hears of the tag before the chat, and of each meta change main makes after', async () => {
  const w = world({ prefs: { momo: { brain: { main: { harness: 'claude', account: 'du@work' } } } } });
  const { chatId } = await w.svc.ensureMainChat();
  assert.deepEqual(
    w.log.filter((l: any) => l[0] !== 'claude'),
    [
      ['changed', chatId, 'main'],
      ['started', chatId, 'main'],
    ],
  );
  // the pin it put on the chat
  assert.deepEqual(w.changes, [chatId]);
  w.chats.patchMeta(chatId, { archived: 1 });
  const next = await w.svc.ensureMainChat();
  // the archived one retired, then the new one
  assert.deepEqual(w.changes.slice(1), [chatId, next.chatId]);
  // a retag that changes nothing tells nobody
  w.svc.retire(chatId);
  assert.equal(w.changes.length, 3);
});

test('before a brain is picked: Claude Code on Opus with the first Claude login, else the first harness that can run', async () => {
  const w = world({ prefs: { momo: { feed: true, brain: 'not a record' } } });
  assert.equal(w.svc.getBrain(), null);
  const { chatId } = await w.svc.ensureMainChat();
  assert.match(chatId, /^claude:/);
  assert.deepEqual(w.svc.getBrain(), { harness: 'claude', account: 'du@work', model: 'opus', modelLabel: 'Opus', effort: null });
  assert.deepEqual(w.claude.own.get(chatId), { model: 'opus', effort: null, account: 'du@work' });
  assert.deepEqual(w.prefs.momo.feed, true);
  // another brain kept beside the main one stays as it is
  const side = world({ prefs: { momo: { brain: { side: { harness: 'codex' } } } } });
  await side.svc.ensureMainChat();
  assert.deepEqual(side.prefs.momo.brain.side, { harness: 'codex' });
  // no Claude login known: Opus on the login in use
  const n = world({ prefs: {} });
  n.logins = [];
  await n.svc.ensureMainChat();
  assert.equal(n.svc.getBrain().account, null);
  // Claude Code can't run: the first harness that can, on its own defaults
  const c = world({ prefs: {} });
  c.unusable.add('claude');
  const made = await c.svc.ensureMainChat();
  assert.equal(made.chatId, 'th1');
  assert.deepEqual(c.svc.getBrain(), { harness: 'codex', account: null, model: null, modelLabel: null, effort: null });
  // none can: nothing is made, and the user is told
  const none = world({ prefs: {} });
  for (const k of ['claude', 'codex', 'acp:opencode']) none.unusable.add(k);
  await assert.rejects(none.svc.ensureMainChat(), { code: 'no_harness' });
  assert.equal(none.log.length, 0);
  assert.equal(none.svc.getBrain(), null);
  // turned off while it looked
  const off = world({ prefs: {} });
  off.svc.o.usable = async () => ((off.allowed = false), true);
  await assert.rejects(off.svc.ensureMainChat(), { code: 'not_allowed' });
  off.allowed = true;
  assert.equal(off.svc.getBrain(), null);
  // prefs that can't be saved: said so, and no chat is made
  const unsaved = world({ prefs: {} });
  unsaved.failPatch = true;
  await assert.rejects(unsaved.svc.ensureMainChat(), { code: 'save_failed' });
  assert.equal(unsaved.log.length, 0);
});

test('a start that can’t be saved, or that MoMo was turned off during, leaves no second main chat behind', async () => {
  const w = world();
  const { chatId: first } = await w.svc.ensureMainChat();
  w.chats.patchMeta(first, { archived: 1 });
  // the start succeeds, the pointer can't be written
  fs.chmodSync(w.root + '/momo', 0o500);
  try {
    await assert.rejects(w.svc.ensureMainChat());
  } finally {
    fs.chmodSync(w.root + '/momo', 0o700);
  }
  const orphan = [...w.chats.records.keys()].find((id) => id !== first && w.svc.isMomoChat(id))!;
  assert.equal(w.chats.records.get(orphan).meta.momo, 'previous');
  // turned off while the harness started
  const g = gate();
  w.codexGate = g.p;
  const late = w.svc.ensureMainChat();
  await new Promise((r) => setImmediate(r));
  w.allowed = false;
  g.open();
  await assert.rejects(late, { code: 'not_allowed' });
  w.allowed = true;
  const mains = [...w.chats.records.values()].filter((r: any) => r.meta.momo === 'main');
  assert.equal(mains.length, 0);
  // and a chat left tagged main beside the saved one (an older build, a crash) is retired the next time
  const { chatId } = await w.svc.ensureMainChat();
  w.chats.patchMeta('stray', { momo: 'main' });
  assert.equal(w.svc.mainChatId(), chatId);
  assert.equal(w.chats.records.get('stray').meta.momo, 'previous');
});

test('a background chat (a routine’s run) starts in MoMo’s workspace on its brain, tagged before any window hears of it', async () => {
  const w = world();
  const acp = await w.svc.startBackground({ harness: 'acp:opencode' }, { momo: 'routine', routineId: 'momo.a' });
  // owner-only, like the rest of MoMo's folder (open-mode, docs/bug-prevention/data-at-rest.md)
  assert.equal(fs.statSync(path.join(w.root, 'momo', 'workspace')).mode & 0o777, 0o700);
  assert.equal(w.chats.records.get(acp).meta.routineId, 'momo.a');
  assert.deepEqual(
    w.log.find((e: any) => e[0] === 'changed' && e[1] === acp),
    ['changed', acp, 'routine'],
  );
  const claude = await w.svc.startBackground(
    { harness: 'claude', account: 'du@home', model: 'sonnet' },
    { momo: 'routine', routineId: 'momo.r' },
  );
  assert.equal(w.claude.own.get(claude).account, 'du@home');
  assert.ok(w.changes.includes(claude));
  await assert.rejects(w.svc.startBackground({ harness: 'nope' }, { momo: 'routine' }), (e: any) => e.code === 'no_harness');
  w.allowed = false;
  await assert.rejects(w.svc.startBackground({ harness: 'claude' }, { momo: 'routine' }), (e: any) => e.code === 'not_allowed');
});

test('the earlier main chats, newest first, each with the harness it last ran on; refused while MoMo is off', async () => {
  const w = world();
  const { chatId: first } = await w.svc.ensureMainChat();
  assert.deepEqual(w.svc.previousChats(), [], 'the main chat is not an earlier one');
  w.chats.patchMeta(first, { archived: 1 });
  const { chatId: second } = await w.svc.ensureMainChat();
  w.chats.patchMeta('kimi', { momo: 'previous' });
  w.chats.commit({
    ...w.chats.record('kimi'),
    segments: [{ kind: 'acp:kimi', nativeId: 'k1', start: 0, count: null, model: null, handoff: null }],
  });
  w.chats.patchMeta('gone', { momo: 'previous' });
  // a chat an older build made for a topic is not an earlier main chat either
  w.chats.patchMeta('topic', { momo: 'topic' });
  w.chats.isDeleted = (id: string) => id === 'gone';
  w.chats.records.get(first).updatedAt = 10;
  w.chats.records.get('kimi').updatedAt = 20;
  assert.deepEqual(w.svc.previousChats(), [
    { chatId: 'kimi', harness: 'Kimi Code', at: 20 },
    { chatId: first, harness: 'Codex', at: 10 },
  ]);
  assert.ok(!w.svc.previousChats().some((c: any) => c.chatId === second));
  w.allowed = false;
  assert.throws(() => w.svc.previousChats(), { code: 'not_allowed' });
});
