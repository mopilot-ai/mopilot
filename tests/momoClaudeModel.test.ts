// A MoMo chat on Claude Code runs every turn on the model its brain names (#2304): after setup, a reload, a relaunch and a
// brain switch back, whatever a window pushes for the chat; and no `/model` command is sent or shown that no one typed. The
// MoMo service, the chats store and ClaudeTurns are real; the CLI behind ClaudeTurns is a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { switched, world } from './support/momoWorld.ts';
import { claudeOwnOf, ownInputsChanged } from '../src/harness/claude/own.ts';

const require = createRequire(import.meta.url);
const { SessionStore } = require('../electron/session/state.cjs');
const { ClaudeAdapter } = require('../electron/harness/claude/adapter.cjs');
const { registerChats } = require('../electron/platform/chats.cjs');
const { momoModelOf } = require('../shared/momoChat.mjs');
const { buildTurns } = await import('./support/claude-translate.ts');

const ref = (chatId: string) => ({ kind: 'claude', id: chatId.replace(/^claude:/, ''), instance: null, key: chatId });

/** ClaudeTurns as main makes it (electron/app/sessions.cjs): the model pinned from the chat's file, over a fake CLI. */
function turns(w: any) {
  const controls: any[] = [];
  const sent: any[] = [];
  const live = new Set<string>();
  const adapter = new ClaudeAdapter({
    api: {
      isLive: (k: string) => live.has(k),
      control: async (k: string, m: string, a?: unknown) => void controls.push([k, m, a]),
      title: async () => 'Title',
      rename: async () => {},
      info: async () => ({}),
      sessionCwd: () => '/w',
      accounts: () => ({ active: 'du@work', accounts: [{ id: 'du@work', loggedIn: true }] }),
      metered: () => false,
    },
    state: new SessionStore(),
    prefs: () => ({ claudeSelection: { model: 'opus', effort: 'high', fast: false } }),
    send: async (_c: string, key: string, opts: any) => (sent.push(opts), live.add(key), {}),
    enqueue: () => undefined,
    chatOf: (k: string) => k,
    ref,
    pinnedModel: (chatId: string) => momoModelOf(w.chats.records.get(chatId)?.meta),
    graceMs: 0,
    resumeMs: 0,
  });
  return { adapter, controls, sent };
}
const send = (a: any, chatId: string, n: number) => a.startTurn(chatId, ref(chatId), { id: `i${n}`, text: `hi ${n}`, opts: {} });

test('after setup, a reload and a relaunch every turn runs on the brain’s model, and no /model is sent for it', async () => {
  const w = world({ prefs: { momo: { brain: { main: { harness: 'claude', account: 'du@work', model: 'sonnet' } } } } });
  const { chatId } = await w.svc.ensureMainChat();
  assert.equal(w.chats.records.get(chatId).meta.momoModel, 'sonnet');
  const t = turns(w);
  // the window's first push knows no model for the chat yet (its settings unread)
  t.adapter.setOwn(chatId, { model: null, effort: null, account: 'du@work' });
  await send(t.adapter, chatId, 1);
  assert.equal(t.sent.at(-1).model, 'sonnet');
  // a reload: the window reads the transcript's model (an older turn's) and pushes it; then one that knows only the login
  t.adapter.setOwn(chatId, { model: 'opus', effort: 'high', account: 'du@work' });
  await send(t.adapter, chatId, 2);
  t.adapter.setOwn(chatId, { account: 'du@work' });
  await send(t.adapter, chatId, 3);
  assert.deepEqual(
    t.sent.map((o: any) => o.model),
    ['sonnet', 'sonnet', 'sonnet'],
  );
  // the live CLI started on the brain's model: nothing switched it (the hidden "/model default")
  assert.deepEqual(
    t.controls.filter(([, m]: any[]) => m === 'setModel'),
    [],
  );
  // a relaunch: a new service and ClaudeTurns on the same files, nothing in memory
  const again = turns(w);
  w.svc = w.make();
  assert.deepEqual(await w.svc.ensureMainChat(), { chatId, warning: null });
  assert.equal(again.adapter.settings(chatId, {}).model, 'sonnet');
  // a message's own model (a scheduled task's) still wins for its run
  assert.equal(again.adapter.settings(chatId, { model: 'haiku' }).model, 'haiku');
  // the chat's own effort goes with the model it was picked for, never onto the brain's
  again.adapter.setOwn(chatId, { model: 'opus', effort: 'max', account: 'du@work' });
  assert.deepEqual([again.adapter.settings(chatId, {}).model, again.adapter.settings(chatId, {}).effort], ['sonnet', 'high']);
  again.adapter.setOwn(chatId, { model: 'sonnet', effort: 'low', account: 'du@work' });
  assert.equal(again.adapter.settings(chatId, {}).effort, 'low');
  // a brain that names no model, or one on another harness, leaves no pin
  await w.svc.setBrain({ harness: 'claude', account: 'du@work', model: null });
  assert.equal(w.chats.records.get(chatId).meta.momoModel, null);
  assert.equal(again.adapter.settings(chatId, {}).model, 'sonnet', 'the chat’s own pick');
});

test('a brain change reaches the next turn; a switch back from Codex lands on the brain’s model', async () => {
  const w = world({ prefs: { momo: { brain: { main: { harness: 'claude', account: 'du@work', model: 'sonnet' } } } } });
  const { chatId } = await w.svc.ensureMainChat();
  const t = turns(w);
  await w.svc.setBrain({ harness: 'claude', account: 'du@work', model: 'haiku' });
  assert.equal(t.adapter.settings(chatId, {}).model, 'haiku');
  // to Codex and back: the switch back names Sonnet, and the chat's Claude turns run on it once it lands
  await w.svc.setBrain({ harness: 'codex', account: null, model: 'gpt-5' });
  switched(w, chatId, 'codex', 'th-1');
  await w.svc.setBrain({ harness: 'claude', account: 'du@work', model: 'sonnet' });
  assert.equal(w.state.get(chatId).pendingSwitch.model, 'sonnet');
  switched(w, chatId, 'claude', 'sess-2');
  assert.equal(t.adapter.settings(chatId, {}).model, 'sonnet');
  // a chat made before the model was kept in its file gets the brain's on the next open
  w.chats.patchMeta(chatId, { momoModel: null });
  const told = w.changes.length;
  await w.svc.ensureMainChat();
  assert.equal(w.chats.records.get(chatId).meta.momoModel, 'sonnet');
  assert.equal(w.changes.length, told + 1);
});

test('a model picked in a MoMo chat’s composer is the brain’s for the main chat, the chat’s own for another', async () => {
  const w = world({ prefs: { momo: { brain: { main: { harness: 'claude', account: 'du@work', model: 'sonnet' } } } } });
  const { chatId } = await w.svc.ensureMainChat();
  assert.deepEqual(await w.svc.setChatModel(chatId, 'haiku', 'Haiku'), { chatId, model: 'haiku', warning: null });
  assert.deepEqual(w.svc.getBrain(), { harness: 'claude', account: 'du@work', model: 'haiku', modelLabel: 'Haiku', effort: null });
  assert.equal(w.chats.records.get(chatId).meta.momoModel, 'haiku');
  // no label: the model's id names it
  await w.svc.setChatModel(chatId, 'opus');
  assert.equal(w.svc.getBrain().modelLabel, 'opus');
  // a routine's run keeps its own, and the brain stays
  const run = await w.svc.startBackground({ harness: 'claude', account: 'du@work', model: 'sonnet' }, { momo: 'routine' });
  await w.svc.setChatModel(run, 'haiku');
  assert.equal(w.chats.records.get(run).meta.momoModel, 'haiku');
  assert.equal(w.svc.getBrain().model, 'opus');
  // refused: no model, a chat that isn't MoMo's, one on Codex, MoMo off
  await assert.rejects(w.svc.setChatModel(chatId, ''), { code: 'invalid_model' });
  const code = await w.svc.o.chatStarter.startClaude('/w', null);
  await assert.rejects(w.svc.setChatModel(code, 'haiku'), { code: 'invalid_model' });
  switched(w, run, 'codex', 'th-9');
  await assert.rejects(w.svc.setChatModel(run, 'haiku'), /picked with its brain on Codex/);
  w.allowed = false;
  await assert.rejects(w.svc.setChatModel(chatId, 'haiku'), { code: 'not_allowed' });
});

test('only main writes a MoMo chat’s model; it is read only for MoMo’s chats', () => {
  const w = world();
  const h = new Map<string, any>();
  registerChats(
    { handle: (ch: string, f: any) => h.set(ch, f) },
    { store: w.chats, uiState: `${w.root}/ui.json`, broadcast: () => undefined },
  );
  w.chats.patchMeta('m', { momo: 'main', momoModel: 'sonnet' });
  assert.equal(h.get('chats:patchMeta')({ sender: 'w1' }, 'm', { momoModel: 'opus', unread: true }), true);
  assert.deepEqual([w.chats.records.get('m').meta.momoModel, w.chats.records.get('m').meta.unread], ['sonnet', true]);
  assert.equal(momoModelOf({ momo: 'main', momoModel: 'haiku' }), 'haiku');
  assert.equal(momoModelOf({ momo: 'main', momoModel: '' }), null);
  assert.equal(momoModelOf({ momoModel: 'haiku' }), null);
  assert.equal(momoModelOf(null), null);
});

test('a window that hasn’t read a chat’s model sends only its login, and main keeps the model it had', () => {
  const models = [{ id: 'opus' }, { id: 'sonnet' }];
  const s = (runtime: any, list = models) => ({ runtime, claudeChats: { c: { id: 'du@work' } }, claude: { models: list } });
  // settings unread, or the model list not in yet (a reload)
  assert.deepEqual(claudeOwnOf(s({}), 'c'), { account: 'du@work' });
  assert.deepEqual(claudeOwnOf(s({ c: { settings: { model: 'sonnet' } } }, []), 'c'), { account: 'du@work' });
  // known: its model and effort; a model the list doesn't have, or none, is no pick of its own
  assert.deepEqual(claudeOwnOf(s({ c: { settings: { model: 'sonnet', effort: 'low' } } }), 'c'), {
    model: 'sonnet',
    effort: 'low',
    account: 'du@work',
  });
  assert.deepEqual(claudeOwnOf(s({ c: { settings: { model: 'sonnet' } } }), 'c'), { model: 'sonnet', effort: null, account: 'du@work' });
  assert.deepEqual(claudeOwnOf(s({ c: { settings: { model: 'gone', effort: 'low' } } }), 'c'), {
    model: null,
    effort: null,
    account: 'du@work',
  });
  assert.deepEqual(claudeOwnOf({ runtime: {}, claudeChats: {}, claude: { models } }, 'x'), { account: null });
  // a MoMo chat's model is its brain's; an effort picked for another model does not follow it
  assert.deepEqual(claudeOwnOf({ ...s({ c: { settings: { model: 'opus', effort: 'low' } } }), momoModels: { c: 'sonnet' } }, 'c'), {
    model: 'sonnet',
    effort: null,
    account: 'du@work',
  });
  // what it reads, MoMo's models included, is what the window watches
  const st = s({});
  assert.equal(ownInputsChanged(st, st), false);
  assert.equal(ownInputsChanged({ ...st, momoModels: {} }, st), true);
  assert.equal(ownInputsChanged({ ...st, claude: { models: [] } }, st), true);
  // main: a push without a model keeps the one it has, and an explicit null still clears it
  const t = turns(world());
  t.adapter.setOwn('c', { model: 'sonnet', effort: 'low', account: 'du@work' });
  t.adapter.setOwn('c', { account: 'du@home' });
  assert.deepEqual(t.adapter.own.get('c'), { model: 'sonnet', effort: 'low', account: 'du@home' });
  t.adapter.setOwn('c', { model: null, effort: null, account: 'du@home' });
  assert.deepEqual(t.adapter.own.get('c'), { model: null, effort: null, account: 'du@home' });
});

test('the /model command the CLI records for an SDK model switch is not a user message; one a person sent is', () => {
  const cmd =
    '<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>haiku</command-args>';
  const prompts = (message: object) => buildTurns([{ type: 'user', uuid: 'u', ...message }], 'c', '/w').length;
  assert.equal(prompts({ message: { role: 'user', content: cmd } }), 0);
  assert.equal(prompts({ message: { content: [{ type: 'text', text: cmd }] } }), 0);
  assert.equal(prompts({ origin: { kind: 'human' }, message: { content: cmd } }), 1);
  assert.equal(prompts({ message: { content: '<command-name>/compact</command-name>' } }), 1);
});

test('replayed, an app’s model switch is no user message, in any chat; a /model the person sent still is', () => {
  const cmd = (args: string) =>
    `<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>${args}</command-args>`;
  const turns = buildTurns(
    [
      { type: 'user', uuid: 'u1', origin: { kind: 'human' }, message: { content: 'hi' } },
      { type: 'user', uuid: 'm1', message: { content: cmd('haiku') } },
      { type: 'user', uuid: 'o1', message: { content: '<local-command-stdout>Set model to haiku</local-command-stdout>' } },
      { type: 'user', uuid: 'm2', origin: { kind: 'human' }, message: { content: [{ type: 'text', text: cmd('opus') }] } },
    ],
    't',
    '/r',
  );
  assert.deepEqual(
    turns.map((t: any) => t.items[0].content.map((c: any) => c.text)),
    [['hi'], ['/model opus']],
  );
});
