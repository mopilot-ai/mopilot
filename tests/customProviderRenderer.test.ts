// Renderer send entrypoint consumes real delivery receipts; a queued failure never creates a second draft.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { parseSync } from 'vite';
import { touched } from '../src/lib/chatActivity.ts';
import { installNativeStub } from './support/ports/native.ts';

const fixture: any = { state: {}, messages: [], sends: [], reply: null, held: false, flushed: [] };
(globalThis as any).__sendReceiptRenderer = fixture;
(globalThis as any).window = {
  native: {
    session: {
      send: async (...args: any[]) => {
        fixture.sends.push(args);
        if (fixture.reply instanceof Error) throw fixture.reply;
        return fixture.reply;
      },
    },
  },
};
// the window's bridge, installed in the native port (src/lib/native.ts)
installNativeStub((globalThis as any).window.native);
const core: any = {
  get: () => fixture.state,
  set: (change: any) => Object.assign(fixture.state, typeof change === 'function' ? change(fixture.state) : change),
  toast: (text: string, level: string) => fixture.messages.push([text, level]),
  patchRuntime(id: string, change: any) {
    const runtime = fixture.state.runtime[id] ?? { turns: [], activeTurnId: null };
    fixture.state.runtime[id] = { ...runtime, ...change(runtime) };
  },
  newTurn(id: string) {
    return { id, status: 'inProgress', items: [] };
  },
  patchTurn() {},
  setDraft: (...args: any[]) => fixture.drafts.push(args),
  touchChat: (id: string, started?: { text: string }) => core.set((s: any) => touched(s, id, Date.now() / 1000, started)),
};
(globalThis as any).__sendReceiptCore = core;
const source = new URL('../src/store/send.ts', import.meta.url);
const imported = parseSync(source.pathname, readFileSync(source, 'utf8')).module.staticImports;
const stubs = new Map<string, string>();
for (const statement of imported) {
  const specifier = statement.moduleRequest.value;
  if (
    specifier.startsWith('../../shared/') ||
    specifier === '../harness/adapters/proxy' ||
    specifier === '../harness/codexSettings' ||
    specifier === '../lib/ignored'
  )
    continue;
  // the early turn is real, over the same core
  if (specifier === './pendingTurns' || specifier === './earlyTurn') continue;
  const names = statement.entries
    .filter((e: any) => !e.isType)
    .map((e: any) => e.importName.name)
    .filter(Boolean);
  if (!names.length) continue;
  let code = names.map((name: string) => `export const ${name}=()=>undefined;`).join('\n');
  if (specifier === './core') code = names.map((name: string) => `export const ${name}=globalThis.__sendReceiptCore.${name};`).join('\n');
  if (specifier === './session/useSession')
    code =
      'export const sessionOf=()=>globalThis.__sendReceiptRenderer.session;export const setSession=()=>Promise.resolve(true);' +
      "export const flushSessionPatches=()=>{globalThis.__sendReceiptRenderer.flushed.push('session')};";
  if (specifier === './notifications')
    code = names
      .map((name: string) =>
        name === 'flushStreamNotifications'
          ? "export const flushStreamNotifications=()=>{globalThis.__sendReceiptRenderer.flushed.push('text')};"
          : `export const ${name}=()=>undefined;`,
      )
      .join('\n');
  if (specifier === './session/sessionState') code = 'export const turnBusy=(s)=>!!s.busy;';
  if (specifier === './stop')
    code = 'export const interrupt=()=>Promise.resolve();export const stopOnStart=new Map();export const stopSeenTurns=new Map();';
  if (specifier === '../lib/hostChats')
    code =
      "export const onMachineNow=()=>!!globalThis.__sendReceiptRenderer.remote;export const hostOfChatNow=()=>globalThis.__sendReceiptRenderer.remote?'box':'';";
  if (specifier === './threads')
    code =
      'export const shouldHold=()=>globalThis.__sendReceiptRenderer.held;export const hold=()=>undefined;export const onLease=()=>{};export const setElsewhere=()=>{};';
  stubs.set(specifier, code);
}
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === source.href && stubs.has(specifier))
      return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(stubs.get(specifier)!) };
    return next(specifier, context);
  },
});
const earlyTurn = new URL('../src/store/earlyTurn.ts', import.meta.url);
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === earlyTurn.href && specifier === './core')
      return {
        shortCircuit: true,
        url:
          'data:text/javascript,' +
          encodeURIComponent(
            'export const newTurn=globalThis.__sendReceiptCore.newTurn;export const patchRuntime=globalThis.__sendReceiptCore.patchRuntime;',
          ),
      };
    return next(specifier, context);
  },
});
const connection = new URL('../src/store/connection.ts', import.meta.url);
const connectionStubs = new Map<string, string>();
for (const statement of parseSync(connection.pathname, readFileSync(connection, 'utf8')).module.staticImports) {
  const names = statement.entries
    .filter((e: any) => !e.isType)
    .map((e: any) => e.importName.name)
    .filter(Boolean);
  if (!names.length) continue;
  const specifier = statement.moduleRequest.value;
  const code =
    specifier === './core'
      ? names.map((name: string) => `export const ${name}=globalThis.__sendReceiptCore.${name};`).join('\n')
      : names.map((name: string) => `export const ${name}=()=>undefined;`).join('\n');
  connectionStubs.set(specifier, code);
}
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === connection.href && connectionStubs.has(specifier))
      return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(connectionStubs.get(specifier)!) };
    return next(specifier, context);
  },
});
const { onCrashed } = await import('../src/store/connection.ts');
const { sendMessage, sendOrDraft, onCodexItem } = await import('../src/store/send.ts');

beforeEach(() => {
  fixture.state = { chatConfig: {}, prefs: { followUp: 'queue' }, handoffCarry: {}, runtime: {}, drafts: {}, pending: [], threads: {} };
  fixture.remote = false;
  fixture.messages = [];
  fixture.sends = [];
  fixture.drafts = [];
  fixture.held = false;
  fixture.session = { pendingSwitch: null, busy: false };
  fixture.reply = { action: 'started', id: 'request' };
});

test('conditional Retry refuses a writer lock instead of holding or merging a delayed duplicate prompt', async () => {
  fixture.held = true;
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal(await sendMessage('chat', 'retry original', [], { human: true, retryAtRevision: 7 }), false);
  }
  assert.equal(fixture.sends.length, 0);
  assert.match(fixture.messages.at(-1)[0], /another app/);
});

test('ordinary held input and messages for known active turns retain their existing send behavior', async () => {
  fixture.held = true;
  assert.equal(await sendMessage('chat', 'ordinary held input'), undefined);
  assert.equal(fixture.sends.length, 0);
  fixture.session.busy = true;
  assert.equal(await sendMessage('chat', 'a normal follow-up'), true);
  fixture.session.busy = false;
  fixture.state.runtime.chat = { activeTurnId: 'live' };
  assert.equal(await sendMessage('chat', 'another normal follow-up'), true);
  assert.equal(fixture.sends.length, 2);
});

test('queued history failure is accepted exactly once and visibly explains main-owned retry', async () => {
  fixture.reply = { action: 'queued', id: 'request', error: 'list_turns is not supported yet' };
  assert.equal(await sendOrDraft('chat', 'keep this', { human: true }), true);
  assert.equal(fixture.sends.length, 1);
  assert.deepEqual(fixture.drafts, []);
  assert.match(fixture.messages[0][0], /list_turns.*kept in the queue/);
  // a reason that already says what happened to the message is not followed by it again
  fixture.remote = false;
  fixture.messages = [];
  fixture.reply = { action: 'queued', id: 'request', error: 'The switch failed. Your message is kept in the queue: send it again.' };
  await sendMessage('chat', 'again');
  assert.equal(fixture.messages[0][0], "Couldn't send: The switch failed. Your message is kept in the queue: send it again.");
});

test('a message a machine refused is said by its queue row, not again in a toast', async () => {
  fixture.messages = [];
  fixture.reply = { action: 'queued', id: 'request', error: 'Ask for approval is not allowed on box.', waitingFor: 'hostRefused' };
  assert.equal(await sendMessage('chat', 'refused'), true);
  assert.deepEqual(fixture.messages, []);
});

test('actually started, busy-queued and held receipts do not invent failures', async () => {
  for (const action of ['started', 'queued', 'held', 'steered', 'discarded']) {
    fixture.reply = { action, id: 'request' };
    assert.equal(await sendMessage('chat', 'text'), true);
  }
  assert.deepEqual(fixture.messages, []);
});

test('transport and malformed receipts retain the carry for the caller without reporting acceptance', async () => {
  for (const reply of [null, {}, { action: 'failed', id: 'request', error: 'not accepted' }, new Error('IPC failed')]) {
    fixture.reply = reply;
    const carry = { text: 'summary' };
    fixture.state.handoffCarry = { chat: carry };
    assert.equal(await sendMessage('chat', 'text'), false);
    assert.deepEqual(fixture.state.handoffCarry.chat, carry);
  }
  assert.ok(fixture.messages.every(([text]: any) => text.startsWith("Couldn't send:")));
});

test('a rejected send cannot overwrite a newer carry written while it was pending', async () => {
  let reject!: (error: Error) => void;
  fixture.reply = new Promise((_resolve, fail) => {
    reject = fail;
  });
  fixture.state.handoffCarry = { chat: { text: 'old' } };
  const pending = sendMessage('chat', 'text');
  fixture.state.handoffCarry.chat = { text: 'new' };
  reject(new Error('failed'));
  assert.equal(await pending, false);
  assert.deepEqual(fixture.state.handoffCarry.chat, { text: 'new' });
});

test('a refused chat without a turn retains a visible error across later snapshots', () => {
  onCrashed('new-chat', 'list_turns is not supported yet');
  assert.equal(fixture.state.runtime['new-chat'].error, 'list_turns is not supported yet');
  assert.equal(fixture.state.runtime['new-chat'].turns.length, 0);
  fixture.state.runtime['empty-chat'] = { turns: [], activeTurnId: null };
  onCrashed('empty-chat', 'connection refused');
  assert.equal(fixture.state.runtime['empty-chat'].error, 'connection refused');
  onCrashed('without-error', null);
  assert.equal(fixture.state.runtime['without-error'], undefined);
});

test('explicit steer and Quick Chat request IDs survive the shared proxy', async () => {
  const { chatProxy } = await import('../src/harness/adapters/proxy.ts');
  assert.equal(await sendMessage('chat', 'nudge', [], { steer: true }), true);
  assert.equal(fixture.sends.at(-1)[1].followUp, 'steer');
  fixture.state.prefs.followUp = 'steer';
  assert.equal(await sendMessage('chat', 'after this', [], { steer: false }), true);
  assert.equal(fixture.sends.at(-1)[1].followUp, 'queue');
  assert.equal(await sendMessage('chat', 'default delivery'), true);
  assert.equal(fixture.sends.at(-1)[1].followUp, 'steer');
  await chatProxy.send('chat', 'quick', [], {}, undefined, 'request-id');
  assert.equal(fixture.sends.at(-1)[1].id, 'request-id');
  assert.equal(Object.hasOwn(fixture.sends.at(-1)[1], 'followUp'), false);
});

test('a pre-turn refusal cannot replace a historical failed or completed turn error', () => {
  for (const status of ['failed', 'completed']) {
    const old = { id: 'old', status, error: { message: 'previous failure' } };
    fixture.state.runtime.chat = { turns: [old], activeTurnId: null };
    onCrashed('chat', 'list_turns is not supported yet');
    assert.deepEqual(fixture.state.runtime.chat.turns, [old]);
    assert.equal(fixture.state.runtime.chat.error, 'list_turns is not supported yet');
    Object.assign(fixture.state, { chatConfig: {}, models: [], threadOrder: [] });
    onCodexItem({ kind: 'turnStarting', chatId: 'chat', clientId: 'retry', text: 'retry', attachments: [], opts: {} } as any);
    onCodexItem({ kind: 'turnStarted', chatId: 'chat', clientId: 'retry', turnId: 'new-turn', text: 'retry' } as any);
    assert.deepEqual(fixture.state.runtime.chat.turns[0], old);
    assert.equal(fixture.state.runtime.chat.error, null);
    assert.equal(fixture.state.runtime.chat.activeTurnId, 'new-turn');
  }
});

test('an explicitly active or still-in-progress turn remains the crash owner', () => {
  for (const [status, activeTurnId] of [
    ['failed', 'active'],
    ['inProgress', null],
  ]) {
    fixture.state.runtime.chat = { turns: [{ id: 'active', status }], activeTurnId };
    onCrashed('chat', 'harness exited');
    assert.equal(fixture.state.runtime.chat.turns[0].error.message, 'harness exited');
    assert.equal(fixture.state.runtime.chat.turns[0].status, 'failed');
    assert.equal(fixture.state.runtime.chat.activeTurnId, null);
  }
});

test('the native send receipt declaration adds no runtime initialization', async () => {
  const declarations = await import('../src/lib/native/session.ts');
  assert.ok(Object.values(declarations).every((value) => Object.keys(value as object).length === 0));
});

/* The send that carries a harness switch shows the message at once (#1663). */
const SWITCH = { harness: 'codex', model: 'gpt-6.1-sol', modelLabel: 'GPT-6.1 Sol', mode: 'auto' };
const userTexts = (chat = 'chat') =>
  fixture.state.runtime[chat].turns.map((t: any) => [
    t.id,
    t.status,
    t.items.filter((i: any) => i.type === 'userMessage').map((i: any) => i.content[0].text),
  ]);
/** A send whose answer the test settles itself, with the window state as it is while main prepares the switch. */
function pendingSend(chat = 'chat', text = 'carry on') {
  let answer!: (r: any) => void;
  let fail!: (e: Error) => void;
  fixture.reply = new Promise((resolve, reject) => ((answer = resolve), (fail = reject)));
  fixture.session = { pendingSwitch: SWITCH, busy: false };
  const sent = sendMessage(chat, text);
  return { sent, answer, fail, itemId: () => fixture.sends.at(-1)[1].id as string };
}

test('Claude → Codex: the message shows before main settles the switch, and the Codex turn adopts it once', async () => {
  const { sent, answer, itemId } = pendingSend();
  assert.match(itemId(), /^[0-9a-f-]{36}$/, 'the request id main keeps as the queue item id');
  assert.deepEqual(userTexts(), [[`pending-${itemId()}`, 'inProgress', ['carry on']]]);
  assert.equal(fixture.state.runtime.chat.activeTurnId, `pending-${itemId()}`);
  // main's Codex adapter starts the turn after the switch: its turnStarting replaces the early copy
  Object.assign(fixture.state, { chatConfig: {}, models: [], threadOrder: [] });
  const starting = { kind: 'turnStarting', chatId: 'chat', clientId: 'k1', itemId: itemId(), text: 'carry on', attachments: [], opts: {} };
  onCodexItem(starting as any);
  assert.deepEqual(userTexts(), [['pending-k1', 'inProgress', ['carry on']]]);
  assert.equal(fixture.state.runtime.chat.activeTurnId, 'pending-k1');
  answer({ action: 'started', id: itemId() });
  assert.equal(await sent, true);
  // the receipt after the adoption changes nothing
  assert.deepEqual(userTexts(), [['pending-k1', 'inProgress', ['carry on']]]);
  assert.deepEqual(fixture.messages, []);
});

test('a switch that cannot settle: the message stays as a failed turn with the reason, in either order of crash and receipt', async () => {
  const why =
    "Couldn't start Codex: signed out. Your message is kept in the queue: fix that and send it again, or cancel the switch to send it here.";
  // the crash patch first (marks the active turn), then the receipt that names the same reason
  const first = pendingSend();
  onCrashed('chat', why);
  assert.equal(fixture.state.runtime.chat.turns[0].status, 'failed');
  first.answer({ action: 'queued', id: first.itemId(), error: why });
  assert.equal(await first.sent, true);
  assert.deepEqual(userTexts(), [[`pending-${first.itemId()}`, 'failed', ['carry on']]]);
  assert.equal(fixture.state.runtime.chat.turns[0].error.message, why);
  assert.equal(fixture.state.runtime.chat.activeTurnId, null);
  // the failed turn says it: no toast beside it
  assert.deepEqual(fixture.messages, []);
  // the receipt first, then the crash patch
  fixture.state.runtime = {};
  const second = pendingSend();
  second.answer({ action: 'queued', id: second.itemId(), error: why });
  await second.sent;
  onCrashed('chat', why);
  assert.deepEqual(userTexts(), [[`pending-${second.itemId()}`, 'failed', ['carry on']]]);
  assert.equal(fixture.state.runtime.chat.error, null, 'the reason is not shown a second time as a banner');
  assert.deepEqual(fixture.messages, []);
  // a different refusal after it is still said
  onCrashed('chat', 'something else broke');
  assert.equal(fixture.state.runtime.chat.error, 'something else broke');
  // the retry from the queue carries the same id: its harness turn replaces the failed copy instead of repeating the message
  Object.assign(fixture.state, { chatConfig: {}, models: [], threadOrder: [] });
  onCodexItem({
    kind: 'turnStarting',
    chatId: 'chat',
    clientId: 'k2',
    itemId: second.itemId(),
    text: 'carry on',
    attachments: [],
    opts: {},
  } as any);
  assert.deepEqual(userTexts(), [['pending-k2', 'inProgress', ['carry on']]]);
});

test('a send main keeps in the queue without a reason, holds or discards leaves no copy beside the queue chip', async () => {
  for (const action of ['queued', 'held', 'discarded']) {
    fixture.state.runtime = {};
    const { sent, answer, itemId } = pendingSend();
    answer({ action, id: itemId() });
    assert.equal(await sent, true);
    assert.deepEqual(fixture.state.runtime.chat.turns, [], action);
    assert.equal(fixture.state.runtime.chat.activeTurnId, null);
  }
});

test('a Stop that took the start over leaves no failed copy: the queue shows the message', async () => {
  const { sent, answer, itemId } = pendingSend();
  answer({ action: 'queued', id: itemId(), error: 'turn_changed' });
  assert.equal(await sent, true);
  assert.deepEqual(fixture.state.runtime.chat.turns, []);
  assert.equal(fixture.state.runtime.chat.activeTurnId, null);
});

test('a refusal with the same words as an earlier, unrelated failed turn is still said', () => {
  const old = { id: 'turn-9', status: 'failed', error: { message: 'Codex is signed out' } };
  fixture.state.runtime.chat = { turns: [old], activeTurnId: null };
  onCrashed('chat', 'Codex is signed out');
  assert.equal(fixture.state.runtime.chat.error, 'Codex is signed out');
  assert.deepEqual(fixture.messages, [['Codex is signed out', 'error']]);
});

test('settling the early copy leaves the other turns and a different active turn alone', async () => {
  const { settleEarlyTurn } = await import('../src/store/earlyTurn.ts');
  const other = { id: 'running', status: 'inProgress', items: [] };
  const early = { id: 'pending-req', status: 'inProgress', items: [] };
  fixture.state.runtime.chat = { turns: [other, early], activeTurnId: 'running' };
  settleEarlyTurn('chat', 'req', 'why');
  assert.deepEqual(fixture.state.runtime.chat.turns, [other, { ...early, status: 'failed', error: { message: 'why' } }]);
  assert.equal(fixture.state.runtime.chat.activeTurnId, 'running');
  fixture.state.runtime.chat = { turns: [other, early], activeTurnId: 'running' };
  settleEarlyTurn('chat', 'req', null);
  assert.deepEqual(fixture.state.runtime.chat.turns, [other]);
  assert.equal(fixture.state.runtime.chat.activeTurnId, 'running');
  // a copy its harness already adopted is gone: a late answer changes nothing
  settleEarlyTurn('chat', 'req', 'late');
  assert.deepEqual(fixture.state.runtime.chat.turns, [other]);
});

test('a send main refuses or cannot reach leaves no copy, and the caller still holds the text', async () => {
  for (const reply of [new Error('IPC failed'), { action: 'failed', id: 'x', error: 'not accepted' }]) {
    fixture.state.runtime = {};
    const { sent, answer, fail } = pendingSend();
    if (reply instanceof Error) fail(reply);
    else answer(reply);
    assert.equal(await sent, false);
    assert.deepEqual(fixture.state.runtime.chat.turns, []);
    assert.equal(fixture.state.runtime.chat.activeTurnId, null);
  }
});

test('no early copy without a switch, while a turn runs, or when an earlier copy is still pending', async () => {
  fixture.session = { pendingSwitch: null, busy: false };
  await sendMessage('chat', 'plain');
  assert.equal(fixture.state.runtime.chat, undefined);
  assert.equal(fixture.sends.at(-1)[1].id, undefined);
  fixture.session = { pendingSwitch: SWITCH, busy: true };
  await sendMessage('chat', 'queued behind the turn');
  assert.equal(fixture.state.runtime.chat, undefined);
  fixture.session = { pendingSwitch: SWITCH, busy: false };
  fixture.state.runtime.chat = { turns: [], activeTurnId: 'pending-first' };
  await sendMessage('chat', 'second');
  assert.equal(fixture.sends.at(-1)[1].id, undefined);
  assert.deepEqual(fixture.state.runtime.chat.turns, []);
});

test('handoff receipt observer stays local and reports retained ownership without changing ordinary sends', async () => {
  const observed: unknown[] = [];
  const receive = (receipt: unknown) => observed.push(receipt);
  const opts = { human: true, chromeHandoff: { url: 'https://site.test/', token: 'current' } };
  for (const reply of [
    { action: 'queued', id: 'retained', error: 'controller changed' },
    { action: 'queued', id: 'healthy' },
  ]) {
    fixture.reply = reply;
    assert.equal(await sendMessage('chat', 'continue', [], opts, receive), true);
    assert.equal(observed.at(-1), reply);
    assert.deepEqual(fixture.sends.at(-1), ['chat', { text: 'continue', attachments: [], opts, followUp: 'queue' }]);
  }
  const count = observed.length;
  assert.equal(await sendMessage('chat', 'ordinary', [], {}, receive), true);
  assert.equal(observed.length, count);
  assert.equal(await sendMessage('chat', 'no observer', [], opts), true);
});

test('a Codex item lands after the text and session patches main sent before it; a streamed delta waits for the frame (#2847)', () => {
  fixture.state.runtime = {};
  fixture.flushed = [];
  const delta = { threadId: 'c', turnId: 't', itemId: 'm', delta: 'x' };
  // every append-only delta (shared/streamDelta.mjs TEXT_METHODS), not only those named .../delta
  for (const method of ['item/agentMessage/delta', 'item/reasoning/textDelta', 'item/commandExecution/outputDelta'])
    onCodexItem({ kind: 'notification', chatId: 'c', method, params: delta } as any);
  assert.deepEqual(fixture.flushed, []);
  onCodexItem({
    kind: 'notification',
    chatId: 'c',
    method: 'turn/started',
    params: { threadId: 'c', turn: { id: 't', items: [] } },
  } as any);
  assert.deepEqual(fixture.flushed, ['text', 'session'], 'the text first, as main sent it');
  onCodexItem({ kind: 'turnFailed', chatId: 'c', clientId: 'x', error: 'no' } as any);
  assert.deepEqual(fixture.flushed, ['text', 'session', 'text', 'session']);
});

test('machine sends snapshot their chat-scoped model pick while a local chat never takes it', async () => {
  const pick = { hostId: 'box', harness: 'claude', model: 'remote-model', effort: 'high' };
  const permission = { hostId: 'box', harness: 'claude', value: 'read-only' };
  fixture.state.chatConfig.chat = { hostSelection: pick, hostPermission: permission };
  fixture.remote = true;
  fixture.reply = { action: 'started', id: 'sent' };
  await sendMessage('chat', 'remote');
  assert.deepEqual(fixture.sends[0][1].opts.hostSelection, pick);
  assert.deepEqual(fixture.sends[0][1].opts.hostPermission, permission);
  fixture.remote = false;
  await sendMessage('chat', 'local');
  assert.equal(fixture.sends[1][1].opts.hostSelection, undefined);
  assert.equal(fixture.sends[1][1].opts.hostPermission, undefined);
});
