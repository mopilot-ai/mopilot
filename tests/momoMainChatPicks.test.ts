// electron/momo/mainChat.cjs (#2139): a new main chat goes on its brain's account and model through each harness's own
// mechanism: Codex pins its thread in the account pool and keeps the model in the chat's config, Claude Code pins the
// login in the chat and keeps the model with it, a basic (ACP) harness has one sign-in and names neither.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { world } from './support/momoWorld.ts';

const require = createRequire(import.meta.url);
const { brainOf, labelOf } = require('../electron/momo/mainChat.cjs');

test('Codex: the thread is pinned to the account and the model is the chat’s own', async () => {
  const w = world({ prefs: { momo: { brain: { main: { harness: 'codex', account: 'cx-work', model: 'gpt-5-codex' } } } } });
  const { chatId, warning } = await w.svc.ensureMainChat();
  assert.equal(warning, null);
  assert.equal(w.pool.pins.get(chatId), 'cx-work');
  assert.equal(w.chats.records.get(chatId).meta.config.model, 'gpt-5-codex');
  // a chat whose own config is gone gets one
  w.chats.patchMeta(chatId, { config: null });
  w.svc.applyPicks(chatId, brainOf({ harness: 'codex', model: 'gpt-5' }));
  assert.deepEqual(w.chats.records.get(chatId).meta.config, { model: 'gpt-5' });
});

test('Claude Code: the login is pinned in the chat and the model goes with it, in MoMo’s workspace', async () => {
  const w = world({ prefs: { momo: { brain: { main: { harness: 'claude', account: 'du@work', model: 'sonnet' } } } } });
  const { chatId } = await w.svc.ensureMainChat();
  assert.deepEqual(w.chats.records.get(chatId).meta.account, { id: 'du@work', pinned: true });
  assert.deepEqual(w.claude.own.get(chatId), { model: 'sonnet', effort: null, account: 'du@work' });
  assert.deepEqual(w.log[0], ['claude', chatId, { cwd: path.join(w.root, 'momo', 'workspace') }]);
  // no project: the chat names none
  assert.equal(w.chats.records.get(chatId).meta.projectId, null);
});

test('a basic harness starts on its one sign-in, with nothing to pin', async () => {
  const w = world({ prefs: { momo: { brain: { main: { harness: 'acp:opencode', account: 'x', model: 'k2' } } } } });
  const { chatId, warning } = await w.svc.ensureMainChat();
  assert.match(chatId, /^acp:opencode:/);
  assert.equal(warning, null);
  assert.equal(w.claude.own.size, 0);
  assert.equal(w.pool.pins.size, 0);
  assert.deepEqual(w.log.at(-1), ['started', chatId, 'main']);
  assert.deepEqual(brainOf({ harness: 'acp:kimi', account: 'x', model: 'k2' }), {
    harness: 'acp:kimi',
    account: null,
    model: null,
    modelLabel: null,
    effort: null,
  });
});

test('an account that is gone is told as a warning; the chat goes on the one in use', async () => {
  const w = world({ prefs: { momo: { brain: { main: { harness: 'codex', account: 'cx-gone' } } } } });
  const r = await w.svc.ensureMainChat();
  assert.match(r.warning, /Couldn't put MoMo on that Codex account \(that account was removed\)/);
  assert.equal(w.pool.pins.size, 0);
});

test('a brain is read as saved: no harness is no brain, and odd fields are dropped', () => {
  for (const v of [null, 'codex', {}, { harness: 'gemini' }]) assert.equal(brainOf(v), null);
  assert.deepEqual(brainOf({ harness: 'codex', account: '', model: 5, extra: 1 }), {
    harness: 'codex',
    account: null,
    model: null,
    modelLabel: null,
    effort: null,
  });
  assert.equal(labelOf('claude'), 'Claude Code');

  assert.equal(labelOf('acp:kimi'), 'Kimi Code');
  // a basic harness the quirks don't describe goes by its id
  assert.equal(labelOf('acp:zzz'), 'zzz');
});
