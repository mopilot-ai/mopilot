// MoMo's suggestions on the app side (A7): momoSuggestions:list and :act in main (electron/momo/suggestionsIpc.cjs) are refused while MoMo is not allowed and unavailable while the Tasks panel is off; Start sends the first step as the user's own message through the chat's send (app/momoSuggestions.cjs) and a refusal puts the suggestion back; momo_suggest (suggestionTools.cjs) is MoMo's own tool, listed only in its chats while it is allowed and the panel is on, and has no way to start anything; a sealed file keeps the suggestions across a restart and Reset erases it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeSafe } from './support/momo-memory.ts';

const require = createRequire(import.meta.url);
const S = require('../electron/momo/suggestions.cjs');
const { registerSuggestionsIpc, startText, NOT_ALLOWED, UNAVAILABLE } = require('../electron/momo/suggestionsIpc.cjs');
const { registerSuggestionTools, OFF } = require('../electron/momo/suggestionTools.cjs');
const { openSuggestions, createStarter, FILE, PAUSED } = require('../electron/app/momoSuggestions.cjs');
const { pendingMomoChat } = require('../electron/momo/contract/toolIsolation.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');

const NOW = new Date(2026, 10, 16, 9, 0).getTime();
const one = (over: Record<string, unknown> = {}) => ({
  title: 'Reply to Sam',
  why: 'He asked on Monday.',
  source: 'Mail: Sam, Lease',
  step: 'Draft a reply to Sam',
  from: 'mail',
  ref: 't1',
  kind: 'reply',
  state: 'm1',
  ...over,
});

function ipcRig(o: { broadcast?: boolean; start?: (s: any, text: string) => Promise<unknown>; store?: any } = {}) {
  const handlers = new Map<string, Function>();
  const ipcMain = { handle: (ch: string, fn: Function) => handlers.set(ch, fn), removeHandler: (ch: string) => handlers.delete(ch) };
  const gate = { allowed: true, enabled: true };
  const told: string[] = [];
  const started: [any, string][] = [];
  const store = o.store ?? S.createSuggestions({ storage: S.memoryStorage({ now: () => NOW }), now: () => NOW });
  const off = registerSuggestionsIpc(ipcMain, {
    store,
    allowed: () => gate.allowed,
    enabled: () => gate.enabled,
    start: o.start ?? (async (s: any, text: string) => void started.push([s, text])),
    ...(o.broadcast === false ? {} : { broadcast: (ch: string) => told.push(ch) }),
    now: () => NOW,
  });
  const call = (ch: string, ...a: unknown[]) => handlers.get(ch)!({}, ...a);
  return { gate, told, started, store, call, off, handlers };
}

test('list answers the live suggestions with the shown count; act takes Add, Hide and Start, and each is told to the windows', async () => {
  const r = ipcRig();
  assert.deepEqual(await r.call('momoSuggestions:list'), { ok: true, v: 1, suggestions: [], shown: 6, done: {}, now: NOW });
  const a = await r.store.add(one());
  const b = await r.store.add(one({ ref: 't2' }));
  const c = await r.store.add(one({ ref: 't3' }));
  const listed: any = await r.call('momoSuggestions:list');
  assert.equal(listed.suggestions.length, 3);
  assert.equal(listed.suggestions[0].why, 'He asked on Monday.');
  assert.deepEqual(await r.call('momoSuggestions:act', a.id, 'add'), { ok: true, id: a.id, action: 'add', channel: 'main' });
  assert.deepEqual(await r.call('momoSuggestions:act', b.id, 'hide'), { ok: true, id: b.id, action: 'hide', channel: 'main' });
  assert.deepEqual(await r.call('momoSuggestions:act', c.id, 'start'), { ok: true, id: c.id, action: 'start', channel: 'main' });
  assert.deepEqual(r.told, ['momoSuggestions:changed', 'momoSuggestions:changed', 'momoSuggestions:changed']);
  assert.deepEqual(
    r.started.map(([s, text]) => [s.id, text]),
    [[c.id, startText(c)]],
  );
  assert.equal(((await r.call('momoSuggestions:list')) as any).suggestions.length, 1);
});

test('what Start sends says it is the suggestion’s first step with its source, never a bare request', () => {
  assert.equal(
    startText({ title: 'Reply to Sam', step: 'Draft a reply', source: 'Mail: Sam' }),
    'Start: Reply to Sam\nFirst step: Draft a reply\n(From your suggestion, Mail: Sam)',
  );
});

test('both are refused while MoMo is not allowed, and unavailable while the Tasks panel is off; nothing is sent', async () => {
  const r = ipcRig();
  const s = await r.store.add(one());
  r.gate.allowed = false;
  for (const call of [() => r.call('momoSuggestions:list'), () => r.call('momoSuggestions:act', s.id, 'start')])
    assert.deepEqual(await call(), NOT_ALLOWED);
  r.gate.allowed = true;
  r.gate.enabled = false;
  for (const call of [() => r.call('momoSuggestions:list'), () => r.call('momoSuggestions:act', s.id, 'start')])
    assert.deepEqual(await call(), UNAVAILABLE);
  assert.deepEqual(r.started, []);
  assert.equal(r.store.list().suggestions.length, 1);
});

test('a gone suggestion says so by reason, a bad action says what to pick, a failed send keeps the suggestion and says why; no broadcast, no tell', async () => {
  const sendFails = ipcRig({
    broadcast: false,
    start: async () => {
      throw new Error('MoMo is paused. Resume it first.');
    },
  });
  const s = await sendFails.store.add(one());
  assert.deepEqual(await sendFails.call('momoSuggestions:act', 'nope', 'hide'), {
    ok: false,
    error: 'That suggestion is gone.',
    reason: 'gone',
  });
  assert.deepEqual(await sendFails.call('momoSuggestions:act', s.id, 'finish'), { ok: false, error: 'Pick Add, Start or Hide.' });
  assert.deepEqual(await sendFails.call('momoSuggestions:act', s.id, 'start'), { ok: false, error: 'MoMo is paused. Resume it first.' });
  assert.equal(sendFails.store.list().suggestions.length, 1, 'still there');
  // a hide with no broadcast given still works
  assert.equal(((await sendFails.call('momoSuggestions:act', s.id, 'hide')) as any).ok, true);
});

test('a store that cannot be read answers its error; removing the handlers removes both', async () => {
  const broken = {
    list: () => {
      throw new Error('MoMo can’t encrypt its data right now');
    },
    act: async () => undefined,
  };
  const r = ipcRig({ store: broken });
  assert.deepEqual(await r.call('momoSuggestions:list'), { ok: false, error: 'MoMo can’t encrypt its data right now' });
  r.off();
  assert.equal(r.handlers.size, 0);
});

test('Start’s send goes to the chat of the channel as the user’s own message, and is held while MoMo is paused', async () => {
  const sent: any[] = [];
  const gate = { paused: false, receipt: { id: 'x', action: 'started' } as any };
  const controller = { send: async (...a: any[]) => (sent.push(a), gate.receipt) };
  const mainChat = { ensureMainChat: async () => ({ chatId: 'main-chat' }) };
  const start = createStarter({
    mainChat,
    controller,
    paused: () => gate.paused,
    chatOfChannel: (c: string) =>
      c === 'ch_0123456789abcdef' ? 'work-chat' : c === 'ch_1111111111111111' ? Promise.reject(new Error('gone')) : null,
    newId: () => 'm1',
  });
  await start({ channel: 'main' }, 'hello');
  await start({ channel: 'ch_0123456789abcdef' }, 'again');
  assert.deepEqual(sent[0], [
    'main-chat',
    { id: 'm1', text: 'hello', attachments: [], opts: { human: true }, followUp: 'queue' },
    null,
    true,
  ]);
  assert.equal(sent[1][0], 'work-chat');
  await assert.rejects(start({ channel: 'ch_2222222222222222' }, 'x'), (e: any) => e.code === 'gone' && /channel is gone/.test(e.message));
  // a channel whose chat could not be made is gone too
  await assert.rejects(start({ channel: 'ch_1111111111111111' }, 'x'), (e: any) => e.code === 'gone');
  gate.receipt = { id: 'x', action: 'queued', error: 'The harness is busy.' };
  await assert.rejects(start({ channel: 'main' }, 'x'), /harness is busy/);
  gate.receipt = { id: '', action: 'failed' };
  await assert.rejects(start({ channel: 'main' }, 'x'), /did not accept/);
  gate.paused = true;
  const count = sent.length;
  await assert.rejects(start({ channel: 'main' }, 'x'), (e: any) => e.message === PAUSED);
  assert.equal(sent.length, count, 'nothing is sent while paused');
  // defaults: no channel feature, a random id
  const plain = createStarter({
    mainChat,
    controller: { send: async (...a: any[]) => (sent.push(a), { id: 'y', action: 'started' }) },
    paused: () => false,
  });
  await plain({ channel: 'main' }, 'ok');
  assert.match(sent.at(-1)[1].id, /^[0-9a-f-]{36}$/);
  await assert.rejects(plain({ channel: 'ch_2222222222222222' }, 'ok'), /channel is gone/);
});

test('the sealed file keeps the suggestions across a restart, is private and unreadable as text, and Reset erases it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suggestions-'));
  const safe = fakeSafe();
  try {
    const a = openSuggestions({ dir, safeStorage: safe, now: () => NOW });
    await a.store.add(one());
    const file = path.join(dir, FILE);
    assert.equal(fs.statSync(file).mode & 0o077, 0);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /Reply to Sam|Draft a reply/);
    const b = openSuggestions({ dir, safeStorage: safe, now: () => NOW });
    assert.equal(b.store.list().suggestions[0].title, 'Reply to Sam');
    await b.erase();
    assert.equal(fs.existsSync(file), false);
    assert.equal(openSuggestions({ dir, safeStorage: safe }).store.list().suggestions.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function toolRig(o: { owner?: any; store?: any } = {}) {
  const store = o.store ?? S.createSuggestions({ storage: S.memoryStorage({ now: () => NOW }), now: () => NOW });
  const registry = new Registry();
  registry.setApprover(async () => true);
  const gate = { allowed: true, enabled: true, momo: new Set(['momo-main', 'momo-pass']), pass: new Set(['momo-pass']) };
  let changes = 0;
  const off = registerSuggestionTools(registry, {
    store,
    allowed: () => gate.allowed,
    enabled: () => gate.enabled,
    isMomoChat: (id: string) => gate.momo.has(id),
    owner: o.owner ?? ((ctx: any) => ctx.chatId),
    passChat: (id: string) => gate.pass.has(id),
    changed: () => void changes++,
    channelOpen: (id: string) => id === 'ch_0123456789abcdef',
  });
  const call = (args: any, chatId = 'momo-main') => registry.invoke(chatId, 'claude:s1', 'momo_suggest', args);
  return { store, registry, gate, off, call, changes: () => changes };
}

test('momo_suggest is listed only in MoMo’s own chats while MoMo is allowed and the panel is on; a call from elsewhere is refused', async () => {
  const t = toolRig();
  const names = (chatId: string) => t.registry.list({ chatId }).map((x: any) => x.name);
  assert.deepEqual(names('momo-main'), ['momo_suggest']);
  assert.deepEqual(names('coding-1'), []);
  assert.deepEqual(names('momo-pass'), [], 'a data-only pass chat never sees it');
  t.gate.allowed = false;
  assert.deepEqual(names('momo-main'), []);
  t.gate.allowed = true;
  t.gate.enabled = false;
  assert.deepEqual(names('momo-main'), []);
  // a Codex thread that listed the tool before the flag went off (its chat is not known yet) is refused by the handler
  const pending = pendingMomoChat('t');
  const late = await t.call(one(), pending);
  assert.deepEqual([late.error.code, late.error.message], ['off', OFF]);
  assert.equal(t.store.list().suggestions.length, 0);
  t.gate.enabled = true;
  for (const chat of ['coding-1', 'momo-pass']) assert.equal((await t.call(one(), chat)).error.code, 'unavailable');
  const stranger = toolRig({ owner: () => null });
  assert.equal((await stranger.call(one())).error.code, 'unavailable');
  assert.equal(t.store.list().suggestions.length, 0);
  t.off();
  assert.deepEqual(names('momo-main'), []);
});

test('a call adds one to Up next and tells the windows; the model is told it waits for the user', async () => {
  const t = toolRig();
  const r = await t.call(one({ cost: 'person', dueAt: NOW + 1000 }));
  assert.equal(r.ok, true);
  assert.match(r.content[0].text, /Added to Up next: "Reply to Sam" \(id .+\)\. It waits there for the user; do not act on it yourself\./);
  assert.equal(t.changes(), 1);
  assert.equal(t.store.list().suggestions[0].inputs.cost, 'person');
});

test('a suggestion for a channel is added only when that channel is open', async () => {
  const t = toolRig();
  assert.equal((await t.call(one({ channel: 'ch_0123456789abcdef' }))).ok, true);
  const closed = await t.call(one({ ref: 'b', channel: 'ch_ffffffffffffffff' }));
  assert.deepEqual([closed.error.code, /not open/.test(closed.error.message)], ['bad_args', true]);
  assert.equal((await t.call(one({ ref: 'c', channel: 'main' }))).ok, true);
  assert.equal(t.store.list().suggestions.length, 2);
});

test('what the store refuses is told to the model by its code: bad input, a duplicate, the day’s cap; an unexpected failure says it could not be changed', async () => {
  const t = toolRig();
  assert.equal((await t.call(one({ title: '' }))).error.code, 'bad_args');
  await t.call(one());
  assert.equal((await t.call(one())).error.code, 'duplicate');
  await t.call(one({ ref: 'b' }));
  await t.call(one({ ref: 'c' }));
  assert.equal((await t.call(one({ ref: 'd' }))).error.code, 'capped');
  assert.equal(t.changes(), 3, 'a refusal changes nothing');
  const broken = toolRig({
    store: {
      add: async () => {
        throw new Error('disk');
      },
    },
  });
  const r = await broken.call(one());
  assert.deepEqual([r.error.code, r.error.message], ['failed', "MoMo's suggestions could not be changed: disk"]);
  const weird = toolRig({
    store: {
      add: async () => {
        throw 'x';
      },
    },
  });
  assert.match((await weird.call(one())).error.message, /could not be changed: x/);
});

test('the tool takes only what a suggestion needs: no id, no action, so it cannot start, hide or add anything', () => {
  const t = toolRig();
  const tool = t.registry.list({ chatId: 'momo-main' })[0];
  const props = Object.keys((tool.inputSchema ?? tool.schema).properties);
  assert.deepEqual(props, ['title', 'why', 'source', 'step', 'from', 'ref', 'kind', 'state', 'channel', 'dueAt', 'cost', 'confidence']);
});
