// The stream batcher wired into main (electron/app/windows.cjs, electron/main.cjs, electron/app/sessions.cjs,
// electron/app/ipc/chats.cjs): every family's channel passes it, over a fake Electron, and every flush point sends.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain, unloadMain } from './support/electron-main-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
after(() => unloadMain());

const ready = async () => {
  const h = await loadMain();
  await h.ready();
  return h;
};
const T = 'turn';
const codexDelta = (chat: string, delta: string) => ({
  kind: 'notification',
  chatId: chat,
  method: 'item/agentMessage/delta',
  params: { threadId: chat, turnId: T, itemId: 'm', delta },
});
const claudeDelta = (key: string, text: string) => ({
  kind: 'message',
  key,
  msg: { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
});
const acpChunk = (key: string, text: string) => ({
  kind: 'update',
  key,
  turnId: T,
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
});
/** What each window got on a channel, without the primer: a delta that goes out at once and starts the tick the others wait for. */
const PRIME = '__prime__';
const texts = (w: any, channel: string) =>
  w.webContents
    .on_(channel)
    .filter(([e]: any[]) => (e.params?.threadId ?? e.chatId) !== PRIME)
    .map(([e]: any[]) => e.params?.delta ?? e.msg?.event?.delta?.text ?? e.update?.content?.text ?? e.kind);
/** the chat store knows these ids as chats (others, like a sub-agent's thread, are not chats) */
const knowChats = (h: any, ...ids: string[]) => {
  h.one('ChatsStore').get = (id: string) => (ids.includes(id) ? { id } : undefined);
};
const prime = (h: any) => h.one('CodexAdapter').opts.emit(codexDelta(PRIME, 'p'));

test('each family channel joins deltas per chat and key until the tick; other channels go straight out', async () => {
  const h = await ready();
  const w = h.windows[0];
  const codexEmit = h.one('CodexAdapter').opts.emit;
  const claudeBroadcast = h.claude.register.mock.calls[0].arguments[1];
  const acpBroadcast = h.mod('harness/acp.cjs').register.mock.calls[0].arguments[2].broadcast;
  w.hide(); // Establish background timing explicitly; startup now presents the native window immediately.
  prime(h);
  assert.equal(h.windows[0].webContents.on_('codex:item').length, 1, 'the first delta goes out at once');
  for (const t of ['a1', 'b1', 'a2', 'b2']) {
    codexEmit(codexDelta(`codex-${t[0]}`, t));
    claudeBroadcast('claude:event', claudeDelta(`claude-${t[0]}`, t));
    acpBroadcast('acp:event', acpChunk(`acp-${t[0]}`, t));
  }
  assert.deepEqual(texts(w, 'codex:item'), []);
  assert.deepEqual(texts(w, 'claude:event'), []);
  assert.deepEqual(texts(w, 'acp:event'), []);
  // the window is not on screen: the background tick
  mock.timers.tick(16);
  assert.deepEqual(texts(w, 'codex:item'), []);
  mock.timers.tick(234);
  assert.deepEqual(texts(w, 'codex:item'), ['a1a2', 'b1b2']);
  assert.deepEqual(texts(w, 'claude:event'), ['a1a2', 'b1b2']);
  assert.deepEqual(texts(w, 'acp:event'), ['a1a2', 'b1b2']);
  assert.equal(w.webContents.on_('codex:item')[0][0].mine, false, 'each window learns whether the message was its own');
  // a window on screen, even without focus (watched while typing in another app): a frame. The tick that followed
  // the send runs out first (a quiet tick), then a delta after the pause goes out at once and the next ones wait one
  // frame
  w.show();
  w.focused = false;
  mock.timers.tick(250);
  codexEmit(codexDelta('codex-a', 'fast'));
  assert.deepEqual(texts(w, 'codex:item').at(-1), 'fast');
  codexEmit(codexDelta('codex-a', 'f1'));
  codexEmit(codexDelta('codex-a', 'f2'));
  mock.timers.tick(15);
  assert.deepEqual(texts(w, 'codex:item').at(-1), 'fast');
  mock.timers.tick(1);
  assert.deepEqual(texts(w, 'codex:item').at(-1), 'f1f2');
  // a minimized window is not on screen: the background tick again
  w.minimized = true;
  mock.timers.tick(16);
  codexEmit(codexDelta('codex-a', 'm0'));
  codexEmit(codexDelta('codex-a', 'm1'));
  mock.timers.tick(16);
  assert.deepEqual(texts(w, 'codex:item').at(-1), 'm0');
  mock.timers.tick(234);
  assert.deepEqual(texts(w, 'codex:item').at(-1), 'm1');
  w.minimized = false;
  // another channel goes straight out, after what is pending
  claudeBroadcast('claude:event', claudeDelta('claude-a', 'pending'));
  claudeBroadcast('claude:accounts', { key: 'claude-a', accounts: [] });
  acpBroadcast('acp:other', { x: 1 });
  assert.deepEqual(texts(w, 'claude:event').at(-1), 'pending');
  assert.deepEqual(
    w.webContents.sent.slice(-3).map((s: any[]) => s[0]),
    ['claude:event', 'claude:accounts', 'acp:other'],
  );
});

test("an adapter's own event flushes its chat first: Claude's, ACP's and Codex's main-side emits share the queue", async () => {
  const h = await ready();
  const w = h.windows[0];
  // the controller maps each native session to its chat
  h.one('ChatController').chatOf = (key: string) => (key.startsWith('s-') ? 'chat' : key);
  prime(h);
  const claudeBroadcast = h.claude.register.mock.calls[0].arguments[1];
  claudeBroadcast('claude:event', claudeDelta('s-1', 'streamed'));
  h.one('ClaudeAdapter').opts.emit({ kind: 'interrupting', key: 's-1' });
  assert.deepEqual(texts(w, 'claude:event'), ['streamed', 'interrupting']);
  const acpBroadcast = h.mod('harness/acp.cjs').register.mock.calls[0].arguments[2].broadcast;
  acpBroadcast('acp:event', acpChunk('s-2', 'chunk'));
  assert.equal(h.one('AcpTurns').opts.emit({ kind: 'turnFailed', key: 's-2', chatId: 'chat' }, 'any'), true);
  assert.deepEqual(texts(w, 'acp:event'), ['chunk', 'turnFailed']);
  // a switch to Codex: its first event goes out after what the old segment streamed
  claudeBroadcast('claude:event', claudeDelta('s-1', 'old'));
  h.one('CodexAdapter').opts.emit({ kind: 'turnStarted', chatId: 'chat' });
  assert.deepEqual(texts(w, 'claude:event').at(-1), 'old');
  assert.deepEqual(texts(w, 'codex:item'), ['turnStarted']);
});

test('flush points: a window closing, the app-server exiting, a switch, a state change, a harness answer and quitting send what is pending', async () => {
  const h = await ready();
  const w = h.windows[0];
  const codexEmit = h.one('CodexAdapter').opts.emit;
  // every flush point ends the tick, so each step starts one again: a first delta (the primer) goes out at once, and
  // the delta under test then waits behind it
  const pending = (text: string) => {
    prime(h);
    codexEmit(codexDelta('chat', text));
  };
  const last = () => texts(w, 'codex:item').at(-1);

  await h.invoke('window:open', 'settings');
  pending('before close');
  h.windows[1].close();
  assert.equal(last(), 'before close');

  pending('before exit');
  h.one('CodexAdapter').opts.onExit();
  assert.equal(last(), 'before exit');

  const switcher = h.one('SwitchRunner').opts;
  pending('before claim');
  switcher.claim('new-session', 'chat');
  assert.equal(last(), 'before claim');
  assert.deepEqual(h.one('ChatController').claim.mock.calls.at(-1).arguments, ['new-session', 'chat']);

  // a state change of the chat (its turn's end, an approval card) goes out after what the chat streamed
  pending('before patch');
  h.one('SessionStore').opts.publish({ chatId: 'chat', rev: 1, patch: { turn: 'idle' } });
  const sentNames = w.webContents.sent.map((s: any[]) => s[0]);
  assert.deepEqual(sentNames.slice(-2), ['codex:item', 'session:patch']);
  assert.equal(last(), 'before patch');

  // a harness request's answer goes out after what is pending, a failed one too; other channels are not held
  pending('before read');
  const read = h.invoke('codex:api', 'threadTurns', ['chat']);
  assert.equal(last(), 'before patch', 'not before the handler ran');
  await read;
  assert.equal(last(), 'before read');
  h.one('CodexAdapter').api = () => {
    throw new Error('gone');
  };
  pending('before failed read');
  assert.equal((await h.invoke('codex:api', 'threadTurns', ['chat'])).error.message, 'gone');
  assert.equal(last(), 'before failed read');
  pending('kept');
  assert.equal(typeof h.invoke('state:read')?.then, 'undefined', 'state:read answers as it did');
  assert.equal(last(), 'before failed read');

  pending('before quit');
  h.app.emit('before-quit', { preventDefault: mock.fn() });
  assert.equal(last(), 'keptbefore quit');
});

test('deltas go to the windows that show the chat on the frame tick and to the others on the slow tick, in order', async () => {
  const h = await ready();
  const [a] = h.windows;
  await h.invoke('window:open', 'settings');
  const b = h.windows[1];
  const codexEmit = h.one('CodexAdapter').opts.emit;
  knowChats(h, 'X', 'Y');
  // a shows chat X, b shows chat Y: b's view is known and lacks X
  await h.invokeFrom(a.webContents, 'app:viewing', { visible: ['X'], primary: 'X', focused: 'X' });
  await h.invokeFrom(b.webContents, 'app:viewing', { visible: ['Y'], primary: 'Y', focused: 'Y' });
  prime(h);
  codexEmit(codexDelta('X', 'x1'));
  codexEmit(codexDelta('X', 'x2'));
  codexEmit(codexDelta('X', 'x3'));
  mock.timers.tick(16);
  assert.deepEqual(texts(a, 'codex:item'), ['x1x2x3'], 'the window showing the chat gets it on the frame tick');
  assert.deepEqual(texts(b, 'codex:item'), [], 'the other waits for the slow tick');
  // a non-delta event of the chat sends what is pending to both first, so b is never behind its own state
  codexEmit(codexDelta('X', 'x4'));
  codexEmit(codexDelta('X', 'x5'));
  codexEmit({ kind: 'turnStarted', chatId: 'X' });
  assert.deepEqual(texts(b, 'codex:item'), ['x1x2x3x4x5', 'turnStarted'], 'one joined delta, then the event');
  assert.deepEqual(texts(a, 'codex:item'), ['x1x2x3', 'x4x5', 'turnStarted']);
  // a window that starts showing the chat first gets what was pending for it
  codexEmit(codexDelta('X', 'y1'));
  mock.timers.tick(16);
  codexEmit(codexDelta('X', 'y2'));
  await h.invokeFrom(b.webContents, 'app:viewing', { visible: ['X'], primary: 'X', focused: 'X' });
  assert.equal(texts(b, 'codex:item').at(-1), 'y1y2', 'a view change sent what was pending under the old view');
  codexEmit(codexDelta('X', 'y3'));
  mock.timers.tick(16);
  assert.equal(texts(b, 'codex:item').at(-1), 'y3', 'now b is on the frame tick');
  assert.equal(texts(a, 'codex:item').at(-1), 'y3');
  mock.timers.tick(250);
  assert.equal(texts(b, 'codex:item').at(-1), 'y3', 'nothing more for the slow tick');
});

test('a window that has not reported a view is treated as showing every chat; the slow tick sends once per window', async () => {
  const h = await ready();
  const [a] = h.windows;
  await h.invoke('window:open', 'settings');
  const b = h.windows[1];
  const codexEmit = h.one('CodexAdapter').opts.emit;
  knowChats(h, 'X', 'Y');
  await h.invokeFrom(a.webContents, 'app:viewing', { visible: ['Y'], primary: 'Y', focused: 'Y' });
  prime(h);
  codexEmit(codexDelta('X', 'n1'));
  codexEmit(codexDelta('X', 'n2'));
  mock.timers.tick(16);
  assert.deepEqual(texts(b, 'codex:item'), ['n1n2'], 'b has no view yet: frame tick');
  assert.deepEqual(texts(a, 'codex:item'), [], 'a shows another chat');
  mock.timers.tick(234);
  assert.deepEqual(texts(a, 'codex:item'), ['n1n2'], 'a gets it on the slow tick, once');
  assert.deepEqual(texts(b, 'codex:item'), ['n1n2']);
  // a reload forgets the view and sends what is pending first
  codexEmit(codexDelta('X', 'r0'));
  codexEmit(codexDelta('X', 'r1'));
  codexEmit(codexDelta('X', 'r2'));
  a.webContents.emit('did-start-loading');
  assert.deepEqual(texts(a, 'codex:item').at(-1), 'r1r2');
});

test('a broadcast during a stream sends what is pending but keeps the tick', async () => {
  const h = await ready();
  const w = h.windows[0];
  const codexEmit = h.one('CodexAdapter').opts.emit;
  prime(h);
  codexEmit(codexDelta('chat', 'a'));
  // a broadcast that names no chat has no text to overtake: the delta keeps its tick
  h.one('Accounts').opts.broadcast({ kind: 'changed' });
  assert.equal(texts(w, 'codex:item').at(-1), undefined, 'the pending delta waits for the tick');
  mock.timers.tick(16);
  assert.equal(texts(w, 'codex:item').at(-1), 'a');
  codexEmit(codexDelta('chat', 'b'));
  assert.equal(texts(w, 'codex:item').at(-1), 'a', 'the delta after the tick waits for the next');
  mock.timers.tick(16);
  assert.equal(texts(w, 'codex:item').at(-1), 'b');
});

test('an id that is no chat (a sub-agent thread) and a failing chat lookup are shown everywhere; an empty view is background', async () => {
  const h = await ready();
  const [a] = h.windows;
  await h.invoke('window:open', 'settings');
  const b = h.windows[1];
  const codexEmit = h.one('CodexAdapter').opts.emit;
  knowChats(h, 'P');
  await h.invokeFrom(a.webContents, 'app:viewing', { visible: ['P'], primary: 'P', focused: 'P' });
  await h.invokeFrom(b.webContents, 'app:viewing', { visible: [] });
  prime(h);
  codexEmit(codexDelta('sub', 's1'));
  codexEmit(codexDelta('sub', 's2'));
  mock.timers.tick(16);
  assert.deepEqual(texts(a, 'codex:item'), ['s1s2'], 'a sub-agent thread of the shown chat is on the frame tick');
  assert.deepEqual(texts(b, 'codex:item'), ['s1s2'], 'and everywhere');
  mock.timers.tick(250);
  codexEmit(codexDelta('P', 'p0'));
  codexEmit(codexDelta('P', 'p1'));
  codexEmit(codexDelta('P', 'p2'));
  mock.timers.tick(16);
  assert.deepEqual(texts(a, 'codex:item').at(-1), 'p1p2');
  assert.equal(texts(b, 'codex:item').at(-1), 'p0', 'the Home window waits for the slow tick');
  mock.timers.tick(234);
  assert.deepEqual(texts(b, 'codex:item').at(-1), 'p1p2');
  // a store that throws: every id counts as unknown, so nothing is slowed
  h.one('ChatsStore').get = () => {
    throw new Error('closed');
  };
  mock.timers.tick(250);
  codexEmit(codexDelta('P', 'q0'));
  codexEmit(codexDelta('P', 'q1'));
  codexEmit(codexDelta('P', 'q2'));
  mock.timers.tick(16);
  assert.equal(texts(b, 'codex:item').at(-1), 'q1q2');
});

test('a window coming on screen takes what the slow queues hold', async () => {
  const h = await ready();
  const [a] = h.windows;
  const codexEmit = h.one('CodexAdapter').opts.emit;
  knowChats(h, 'X', 'Y');
  await h.invokeFrom(a.webContents, 'app:viewing', { visible: ['Y'], primary: 'Y', focused: 'Y' });
  prime(h);
  codexEmit(codexDelta('X', 'w1'));
  codexEmit(codexDelta('X', 'w2'));
  a.emit('show');
  assert.equal(texts(a, 'codex:item').at(-1), 'w1w2');
  codexEmit(codexDelta('X', 'w3'));
  a.emit('restore');
  assert.equal(texts(a, 'codex:item').at(-1), 'w3');
});

test('an ACP event every window gets is translated once here: its items go first, and it says what was running', async () => {
  const h = await ready();
  const w = h.windows[0];
  const ctl = h.one('ChatController');
  ctl.chatOf = () => 'chat';
  ctl.nativeOf = () => 's-3';
  const acpBroadcast = h.mod('harness/acp.cjs').register.mock.calls[0].arguments[2].broadcast;
  const user = { id: 'u', clientId: 'c', content: [] };
  acpBroadcast('acp:event', { key: 's-3', kind: 'turnStart', turnId: 'tt', user, human: true });
  acpBroadcast('acp:event', { key: 's-3', kind: 'turnEnd', turnId: 'tt', stopReason: 'end_turn', error: null });
  const sent = w.webContents.sent.map((s: any[]) => s[0]);
  assert.ok(sent.includes('acp:items'), String(sent));
  const items = w.webContents.on_('acp:items').map(([e]: any[]) => e.method);
  // the turn, the user's message in it, its end
  assert.deepEqual(items, ['turn/started', 'item/completed', 'turn/completed']);
  assert.equal(w.webContents.on_('acp:items')[0][0].chatId, 'chat');
  assert.equal(w.webContents.on_('acp:event').at(-1)[0].running, true);
  // the history, through acp:turns, comes from the same translation
  const opts = h.mod('harness/acp.cjs').register.mock.calls[0].arguments[2];
  assert.ok(opts.items.history);
  // a targeted event (the window the message came from) is no one's to translate
  assert.equal(h.one('AcpTurns').opts.emit({ kind: 'turnStarting', key: 's-3', chatId: 'chat' }, 'any'), true);
  assert.equal(w.webContents.on_('acp:items').length, 3);
});

test('a delta the slow lane sends again for a window that has its chat in the background is translated once', async () => {
  const h = await ready();
  const [a] = h.windows;
  await h.invoke('window:open', 'settings');
  const b = h.windows[1];
  knowChats(h, 'chat');
  const ctl = h.one('ChatController');
  ctl.chatOf = () => 'chat';
  ctl.nativeOf = () => 'acp-s';
  await h.invokeFrom(a.webContents, 'app:viewing', { visible: ['chat'], primary: 'chat', focused: 'chat' });
  await h.invokeFrom(b.webContents, 'app:viewing', { visible: [] });
  const acpBroadcast = h.mod('harness/acp.cjs').register.mock.calls[0].arguments[2].broadcast;
  const claudeBroadcast = h.claude.register.mock.calls[0].arguments[1];
  acpBroadcast('acp:event', { key: 'acp-s', kind: 'turnStart', turnId: T, user: { id: 'u', clientId: 'c', content: [] }, human: true });
  claudeBroadcast('claude:event', {
    key: 'claude-s',
    kind: 'turnStarting',
    chatId: 'chat',
    turnId: 'ct-c',
    clientId: 'c',
    text: 'hi',
    attachments: [],
  });
  prime(h);
  for (const t of ['Hel', 'lo']) {
    acpBroadcast('acp:event', acpChunk('acp-s', t));
    claudeBroadcast('claude:event', claudeDelta('claude-s', t));
  }
  mock.timers.tick(16);
  mock.timers.tick(250);
  assert.ok(texts(b, 'acp:event').length > 0, 'the background window got the slow lane');
  const said = (channel: string) =>
    a.webContents
      .on_(channel)
      .filter(([e]: any[]) => e.method === 'item/agentMessage/delta')
      .map(([e]: any[]) => e.params.delta)
      .join('');
  assert.equal(said('acp:items'), 'Hello');
  assert.equal(said('claude:items'), 'Hello');
});
