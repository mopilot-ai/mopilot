// A message from another chat reaches a running chat at its next tool round, as Claude Code's cross-session messages
// do (electron/session/peerMessages.cjs enqueue -> deliverNow), without jumping an older one or failing the sender.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { tick } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { PeerMessageService } = require('../electron/session/peerMessages.cjs');
const { ChatController } = require('../electron/session/controller.cjs');
const { SessionStore } = require('../electron/session/state.cjs');

function setup(t: any, target = 'claude') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-next-round-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const records = new Map([
    ['A', { segments: [{ kind: 'codex', nativeId: 'native-A' }] }],
    ['C', { segments: [{ kind: 'codex', nativeId: 'native-C' }] }],
    ['B', { segments: [{ kind: target, nativeId: 'native-B' }] }],
  ]);
  const state = new SessionStore();
  const calls: any[] = [];
  let service: any;
  const startTurn = async (chatId: string, ref: any, item: any) => {
    calls.push({ chatId, kind: ref.kind, item });
    return { started: true, turnId: `turn-${item.id}` };
  };
  // as the Claude Code and Codex adapters answer a peer steer: the turn it joined
  const steer = async (chatId: string, ref: any, item: any) => {
    calls.push({ chatId, kind: ref.kind, item, steered: true });
    return { started: true, turnId: state.get(chatId).activeTurn?.id ?? null };
  };
  const controller = new ChatController({
    state,
    chats: { records, record: (id: string) => records.get(id) },
    codex: { startTurn, steer, peerCapabilities: () => ({ steer: true }) },
    claudeTurns: { startTurn, steer, peerCapabilities: () => ({ steer: true }) },
    acpTurns: { startTurn, peerCapabilities: () => ({ steer: false }) },
    beforeDispatch: (e: any) => service.beforeDispatch(e),
    onDispatchResult: (e: any) => service.result(e),
    onFinished: (e: any) => service.finished(e),
  });
  service = new PeerMessageService({
    file: path.join(dir, 'journal.json'),
    controller,
    exists: (id: string) => records.has(id),
    authorize: () => true,
    gate: () => null,
  });
  return { service, controller, state, calls };
}
const ask = (requestId: string, body = 'Which screens first?') => ({ targetChatId: 'B', requestId, body });

test('a running chat takes a message at its next tool round: no Steer click, its turn keeps running', async (t) => {
  const { service, state, calls } = setup(t);
  state.patch('B', { turn: 'running', activeTurn: { id: 'working', human: true } });
  const m = await service.send('A', ask('r1'));
  await tick();
  assert.equal(service.get('A', m.id).delivery, 'delivered');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].item.peer.messageId, m.id);
  assert.equal(state.get('B').activeTurn.id, 'working');
  assert.equal(state.get('B').queue.length, 0);
});

test('an older message from another chat still waiting keeps its place: the next one queues behind it', async (t) => {
  const { service, controller, state, calls } = setup(t);
  // the first arrives while B waits on an approval, so it queues; then B runs again
  state.patch('B', { turn: 'awaitingUser', activeTurn: { id: 'working' } });
  const first = await service.send('A', ask('r1', 'first'));
  state.patch('B', { turn: 'running' });
  const second = await service.send('C', ask('r2', 'second'));
  await tick();
  assert.equal(calls.length, 0);
  assert.deepEqual(
    state.get('B').queue.map((q: any) => q.id),
    [first.id, second.id],
  );
  assert.equal(service.get('C', second.id).errorCode, null);
  controller.end('B');
  await tick();
  assert.equal(calls[0].item.peer.messageId, first.id);
});

test('a turn that ends, or a message the user removes, while the gate is read leaves the sender a record, not an error', async (t) => {
  for (const code of ['cannot_send_now', 'queued_input_missing']) {
    const { service, state } = setup(t);
    state.patch('B', { turn: 'running', activeTurn: { id: 'working' } });
    service.deliverNow = async () => {
      throw Object.assign(new Error(code), { code });
    };
    const m = await service.send('A', ask(`r-${code}`));
    assert.equal(m.delivery, 'queued', code);
  }
  // any other failure of this early delivery is noted; the message stays queued for the turn's end
  const { service, state } = setup(t);
  state.patch('B', { turn: 'running', activeTurn: { id: 'working' } });
  service.deliverNow = async () => {
    throw new Error('gate unreadable');
  };
  assert.equal((await service.send('A', ask('r-other'))).delivery, 'queued');
});

test('requests steered into a turn get its final answer as their reply, as one that started a turn does', async (t) => {
  const { service, controller, state } = setup(t);
  // C's request starts B's turn; A's two arrive mid-turn and are steered into it
  const own = await service.send('C', ask('c1', 'start here'));
  await tick();
  const turn = state.get('B').activeTurn.id;
  const first = await service.send('A', ask('a1', 'and this'));
  const second = await service.send('A', ask('a2', 'and that'));
  await tick();
  for (const m of [first, second]) assert.equal(service.get('A', m.id).targetTurnId, turn);
  controller.rt('B').lastText = 'All three handled';
  controller.end('B');
  await tick();
  for (const m of [own, first, second]) {
    const reply = service.data.messages.find((x: any) => x.replyTo === m.id);
    assert.equal(reply?.body, 'All three handled', m.id);
  }
  // a turn that ends without completing, or with no answer, replies to nobody
  await service.finished({ chatId: 'B', turnId: turn, text: '  ', completed: true });
  await service.finished({ chatId: 'B', turnId: null, inputToken: null, text: 'late', completed: true });
  assert.equal(service.data.messages.filter((x: any) => x.replyTo).length, 3);
});

test('an older message from a linked session still queued keeps its place too', async (t) => {
  const { service, state, calls } = setup(t);
  state.patch('B', {
    turn: 'running',
    activeTurn: { id: 'working' },
    queue: [{ id: 'side', text: 'from a child', sideSession: true, opts: {} }],
  });
  const m = await service.send('A', ask('r1'));
  await tick();
  assert.equal(calls.length, 0);
  assert.equal(service.get('A', m.id).delivery, 'queued');
  assert.deepEqual(
    state.get('B').queue.map((q: any) => q.id),
    ['side', m.id],
  );
});
