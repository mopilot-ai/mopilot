// electron/momo/mainChat.cjs, #2502: a main chat whose session the harness no longer holds (a restart forgot the one a held
// first message never started) is not resumed: MoMo opens on a new chat, says so, and keeps the old one as previous.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { world } from './support/momoWorld.ts';

const claudeBrain = { momo: { brain: { main: { harness: 'claude' } } } };

test('a main chat with no session behind it is replaced by a new one, saying so; the old one stays as previous', async () => {
  const w = world({ prefs: claudeBrain });
  const first = (await w.svc.ensureMainChat()).chatId;
  // the app restarts: the service reads state.json again, and the harness knows nothing of the chat
  w.gone.add(first);
  w.svc = w.make();
  const again = await w.svc.ensureMainChat();
  assert.notEqual(again.chatId, first);
  assert.match(again.warning, /MoMo started a new conversation/);
  assert.equal(JSON.parse(fs.readFileSync(w.stateFile, 'utf8')).mainChatId, again.chatId);
  assert.equal(w.chats.records.get(first).meta.momo, 'previous');
  assert.equal(w.chats.records.get(again.chatId).meta.momo, 'main');
  // the new chat is fine: the next open keeps it, with no warning
  assert.deepEqual(await w.svc.ensureMainChat(), { chatId: again.chatId, warning: null });
});

test('a main chat whose session exists is kept', async () => {
  const w = world({ prefs: claudeBrain });
  const first = (await w.svc.ensureMainChat()).chatId;
  w.svc = w.make();
  assert.deepEqual(await w.svc.ensureMainChat(), { chatId: first, warning: null });
});

test('a chat with a message waiting is not asked about its session: the message is not dropped from under it', async () => {
  const w = world({ prefs: claudeBrain });
  const first = (await w.svc.ensureMainChat()).chatId;
  w.gone.add(first);
  w.state.patch(first, { queue: [{ id: 'q1' }] });
  assert.deepEqual(await w.svc.ensureMainChat(), { chatId: first, warning: null });
});

test('the replacement follows the saved brain, or the default one when none was saved', async () => {
  const w = world({ prefs: {} });
  const first = (await w.svc.ensureMainChat()).chatId;
  assert.equal(w.chats.record(first).segments.at(-1).kind, 'claude');
  // the brain is forgotten (prefs lost) while the chat stays
  w.prefs = { claudeSelection: { model: 'opus' } };
  w.gone.add(first);
  const again = await w.svc.ensureMainChat();
  assert.notEqual(again.chatId, first);
  assert.equal(w.chats.record(again.chatId).segments.at(-1).kind, 'claude');
  // and with no harness that can run, the old chat stays with the reason
  w.prefs = {};
  w.gone.add(again.chatId);
  w.unusable = new Set(['claude', 'codex', 'acp:opencode']);
  const stuck = await w.svc.ensureMainChat();
  assert.equal(stuck.chatId, again.chatId);
  assert.match(stuck.warning, /No harness can run MoMo now/);
});

test('a start that fails leaves the old chat in place and says why; the next open tries again', async () => {
  const w = world();
  const first = (await w.svc.ensureMainChat()).chatId;
  w.gone.add(first);
  w.codexFails = true;
  const failed = await w.svc.ensureMainChat();
  assert.equal(failed.chatId, first);
  assert.match(failed.warning, /Couldn't start a new MoMo conversation \(Codex is down\)/);
  assert.equal(w.chats.records.get(first).meta.momo, 'main');
  w.codexFails = false;
  const again = await w.svc.ensureMainChat();
  assert.notEqual(again.chatId, first);
  assert.match(again.warning, /MoMo started a new conversation/);
});

test('MoMo turned off while the new chat starts refuses the open, and leaves the old chat as it was', async () => {
  const w = world({ prefs: claudeBrain });
  const first = (await w.svc.ensureMainChat()).chatId;
  w.gone.add(first);
  const started = w.svc.o.chatStarter.startClaude.bind(w.svc.o.chatStarter);
  w.svc.o.chatStarter.startClaude = (...a: any[]) => {
    w.allowed = false;
    return started(...a);
  };
  await assert.rejects(w.svc.ensureMainChat(), { code: 'not_allowed' });
  assert.equal(w.chats.records.get(first).meta.momo, 'main');
});

test('a probe that fails leaves the chat as it is: MoMo still opens', async () => {
  const w = world({ prefs: claudeBrain });
  const first = (await w.svc.ensureMainChat()).chatId;
  w.controller.sessionGone = async () => {
    throw new Error('EACCES');
  };
  assert.deepEqual(await w.svc.ensureMainChat(), { chatId: first, warning: null });
});
