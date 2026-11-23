// Ask MoMo in Quick Chat, main's side (electron/momo/askIpc.cjs, #2139): only the Quick Chat window, only while MoMo is allowed, and only to MoMo's main chat, which main picks; a retry never sends twice, but one after a failed send sends again; a revoke or a closed Quick Chat while the main chat is being made sends nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { deferred } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { registerMomoAskIpc, KEEP } = require('../electron/momo/askIpc.cjs');

const mini = { id: 7 };
const other = { id: 1 };

function rig() {
  const h = new Map<string, any>();
  const state = {
    allowed: true,
    quick: mini as any,
    mainChat: async () => ({ chatId: 'claude:momo-main', warning: null }) as any,
    ready: async () => {},
  };
  const sent: any[] = [];
  const opened: number[] = [];
  let receipt: (id: string) => any = (id) => ({ action: 'started', id });
  registerMomoAskIpc(
    { handle: (ch: string, f: any) => h.set(ch, f) },
    {
      isQuickChat: (sender: unknown) => sender === state.quick,
      allowed: () => state.allowed,
      mainChat: () => state.mainChat(),
      ready: () => state.ready(),
      send: async (chatId: string, item: any, senderId: number) => (sent.push([chatId, item, senderId]), receipt(item.id)),
      openMomo: () => void opened.push(1),
    },
  );
  const call = (ch: string, sender: any, ...args: any[]) => h.get(ch)({ sender }, ...args);
  return { h, state, sent, opened, call, setReceipt: (f: (id: string) => any) => (receipt = f) };
}

test('Quick Chat reads MoMo’s main chat and sends there, a queued note included; a retry with the same id sends once', async () => {
  const r = rig();
  assert.deepEqual([...r.h.keys()], ['momoAsk:chat', 'momoAsk:send', 'momoAsk:open']);
  assert.deepEqual(await r.call('momoAsk:chat', mini), { value: { chatId: 'claude:momo-main' } });
  const item = { id: 'r1', text: '  What’s on today? ', followUp: 'steer', chatId: 'claude:coding-1' };
  assert.deepEqual(await r.call('momoAsk:send', mini, item), { value: { chatId: 'claude:momo-main', note: null } });
  assert.deepEqual(await r.call('momoAsk:send', mini, item), { value: { chatId: 'claude:momo-main', note: null } });
  // the chat a window names is ignored: main sends to MoMo's main chat
  assert.deepEqual(r.sent, [
    ['claude:momo-main', { id: 'r1', text: 'What’s on today?', attachments: [], opts: { human: true }, followUp: 'steer' }, 7],
  ]);
  r.setReceipt((id) => ({ action: 'queued', id, error: 'Codex is busy' }));
  assert.deepEqual(await r.call('momoAsk:send', mini, { id: 'r2', text: 'hi', followUp: 'later' }), {
    value: { chatId: 'claude:momo-main', note: 'Codex is busy' },
  });
  assert.equal((r.sent as any[])[1][1].followUp, 'queue');
  await r.call('momoAsk:open', mini);
  assert.deepEqual(r.opened, [1]);
});

test('refused: another window, MoMo off, nothing to send, a refused receipt, the service’s own error', async () => {
  const r = rig();
  for (const ch of ['momoAsk:chat', 'momoAsk:send', 'momoAsk:open'])
    assert.deepEqual(await r.call(ch, other, { id: 'x', text: 'hi' }), {
      error: { message: 'Only Quick Chat can ask MoMo here.', code: 'not_quick_chat' },
    });
  r.state.allowed = false;
  for (const ch of ['momoAsk:chat', 'momoAsk:send', 'momoAsk:open'])
    assert.deepEqual(await r.call(ch, mini, { id: 'x', text: 'hi' }), {
      error: { message: 'MoMo is not available for this account.', code: 'not_allowed' },
    });
  assert.deepEqual(r.opened, []);
  r.state.allowed = true;
  for (const bad of [undefined, null, { id: 'x' }, { id: 'x', text: '   ' }, { id: 'x', text: 3 }])
    assert.deepEqual(await r.call('momoAsk:send', mini, bad), { error: { message: 'Nothing to send.', code: 'bad_args' } });
  for (const bad of [{ text: 'hi' }, { id: '', text: 'hi' }, { id: 'x'.repeat(129), text: 'hi' }])
    assert.deepEqual(await r.call('momoAsk:send', mini, bad), { error: { message: 'Invalid request.', code: 'bad_args' } });
  r.state.ready = async () => {
    throw new Error('The app window was closed');
  };
  assert.deepEqual(await r.call('momoAsk:send', mini, { id: 'r0', text: 'hi' }), {
    error: { message: 'The app window was closed', code: null },
  });
  r.state.ready = async () => {};
  r.state.mainChat = async () => {
    throw Object.assign(new Error('Sign in to a harness for MoMo.'), { code: 'unavailable' });
  };
  assert.deepEqual(await r.call('momoAsk:chat', mini), { error: { message: 'Sign in to a harness for MoMo.', code: 'unavailable' } });
  r.state.mainChat = async () => {
    throw 'plain';
  };
  assert.deepEqual(await r.call('momoAsk:send', mini, { id: 'r4', text: 'hi' }), { error: { message: 'plain', code: null } });
  assert.equal(r.sent.length, 0);
});

test('a send that failed or was refused is sent again on retry; one in flight or accepted is not', async () => {
  const r = rig();
  r.setReceipt((id) => ({ action: 'failed', id, error: 'The harness did not accept the message.' }));
  assert.deepEqual(await r.call('momoAsk:send', mini, { id: 'r3', text: 'hi' }), {
    error: { message: 'The harness did not accept the message.', code: null },
  });
  r.setReceipt(() => {
    throw new Error('Codex stopped');
  });
  assert.deepEqual(await r.call('momoAsk:send', mini, { id: 'r3', text: 'hi' }), { error: { message: 'Codex stopped', code: null } });
  const accepted = deferred<any>();
  r.setReceipt(() => accepted.promise);
  const first = r.call('momoAsk:send', mini, { id: 'r3', text: 'hi' });
  const again = r.call('momoAsk:send', mini, { id: 'r3', text: 'hi' });
  accepted.resolve({ action: 'started', id: 'r3' });
  assert.deepEqual(await first, { value: { chatId: 'claude:momo-main', note: null } });
  assert.deepEqual(await again, { value: { chatId: 'claude:momo-main', note: null } });
  await r.call('momoAsk:send', mini, { id: 'r3', text: 'hi' });
  assert.equal(r.sent.length, 3);
  // only the latest are remembered
  r.setReceipt((id) => ({ action: 'started', id }));
  for (let i = 0; i < KEEP; i++) await r.call('momoAsk:send', mini, { id: `k${i}`, text: 'hi' });
  await r.call('momoAsk:send', mini, { id: 'r3', text: 'hi' });
  assert.equal(r.sent.length, 3 + KEEP + 1);
});

test('revoked, or Quick Chat closed, while the main chat is being made: nothing is sent or read', async () => {
  const r = rig();
  for (const change of [() => (r.state.allowed = false), () => (r.state.quick = null)]) {
    const made = deferred<{ chatId: string }>();
    r.state.mainChat = () => made.promise;
    const sending = r.call('momoAsk:send', mini, { id: 'late', text: 'hi' });
    const reading = r.call('momoAsk:chat', mini);
    change();
    made.resolve({ chatId: 'claude:momo-main' });
    assert.match((await sending).error.code, /^(not_allowed|not_quick_chat)$/);
    assert.match((await reading).error.code, /^(not_allowed|not_quick_chat)$/);
    r.state.allowed = true;
    r.state.quick = mini;
  }
  assert.deepEqual(r.sent, []);
});
