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
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { registerPeerTools } = require('../electron/capabilities/contract/peerMessages.cjs');

function setup(t: any, source = 'codex', target = 'codex', options: any = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-messages-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'journal.json');
  const records = new Map([
    ['A', { segments: [{ kind: source, nativeId: 'native-A' }] }],
    ['B', { segments: [{ kind: target, nativeId: 'native-B' }] }],
  ]);
  const state = new SessionStore();
  const calls: any[] = [];
  let service: any;
  const startTurn = async (chatId: string, ref: any, item: any) => {
    calls.push({ chatId, ref, item });
    assert.equal(service.get('A', item.id).delivery, 'submitting');
    if (!service.get('A', item.id).temporary)
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).messages.find((m: any) => m.id === item.id).delivery, 'submitting');
    return options.dispatch ? options.dispatch(chatId, ref, item) : { started: true, turnId: `turn-${item.id}` };
  };
  const controller = new ChatController({
    state,
    chats: { records, record: (id: string) => records.get(id) },
    codex: { startTurn, steer: startTurn, peerCapabilities: () => ({ steer: true }) },
    claudeTurns: { startTurn, steer: startTurn, peerCapabilities: () => ({ steer: true }) },
    acpTurns: { startTurn, peerCapabilities: () => ({ steer: false }) },
    beforeDispatch: (e: any) => service.beforeDispatch(e),
    onDispatchResult: (e: any) => service.result(e),
    onFinished: (e: any) => service.finished(e),
  });
  service = new PeerMessageService({
    file,
    controller,
    exists: (id: string) => records.has(id),
    authorize: options.authorize ?? (() => true),
    gate: options.gate ?? (() => null),
    temporary: options.temporary,
    write: options.write,
  });
  return { file, controller, service, calls, state, records };
}
const request = (requestId = 'request-1', body = `Review the schema (${requestId})`) => ({ targetChatId: 'B', requestId, body });

test('corrupt or unreadable recovery state disables only messaging and preserves the original journal', async (t) => {
  const { file } = setup(t);
  for (const body of [
    '{broken',
    JSON.stringify({ schemaVersion: 99, messages: [] }),
    JSON.stringify({ schemaVersion: 1, messages: [], pausedChats: {} }),
  ]) {
    fs.writeFileSync(file, body);
    let submitted = false;
    const service = new PeerMessageService({
      file,
      controller: {
        send: () => {
          submitted = true;
        },
      },
      exists: () => true,
      authorize: () => true,
      gate: () => null,
    });
    assert.equal(service.startupError, 'journal_unavailable');
    await assert.rejects(service.send('A', request()), /journal_unavailable/);
    assert.throws(() => service.commit({ schemaVersion: 1, messages: [] }), /journal_unavailable/);
    assert.equal(submitted, false);
    assert.equal(fs.readFileSync(file, 'utf8'), body);
  }
});

test('two busy chats message each other: one that steers takes it at its next tool round, an ACP chat after its turn', async (t) => {
  const { service, controller, state, calls } = setup(t, 'claude', 'acp:test');
  for (const id of ['A', 'B']) state.patch(id, { turn: 'running', activeTurn: { id: `busy-${id}` } });
  const ab = await service.send('A', request('a-b'));
  const ba = await service.send('B', { ...request('b-a'), targetChatId: 'A' });
  await tick();
  // A (Claude Code) takes B's message into its running turn; B (ACP) keeps A's queued, and a bounded wait returns
  assert.equal(calls.map((c) => c.chatId).join(), 'A');
  assert.equal(state.get('A').activeTurn.id, 'busy-A');
  assert.equal((await service.wait('A', ab.id, { timeoutMs: 1 })).timedOut, true);
  assert.equal(service.get('A', ab.id).errorCode, 'native_steer_unavailable');
  controller.end('A');
  controller.end('B');
  await tick();
  assert.equal(service.get('A', ab.id).delivery, 'delivered');
  assert.equal(service.get('B', ba.id).delivery, 'delivered');
  assert.deepEqual(new Set(calls.map((c) => c.chatId)), new Set(['A', 'B']));
});

test('a message to a running chat steers in at once where the harness can; ACP or an approval keep it queued', async (t) => {
  for (const kind of ['codex', 'claude', 'acp:test']) {
    const { service, state, calls } = setup(t, 'codex', kind);
    state.patch('B', { turn: 'running', activeTurn: { id: 'existing', human: false } });
    const m = await service.send('A', request());
    await assert.rejects(service.sendNow('B', m.id), /cannot_send_now/);
    await tick();
    assert.equal(calls.length, kind === 'acp:test' ? 0 : 1);
    assert.equal(service.get('A', m.id).delivery, kind === 'acp:test' ? 'queued' : 'delivered');
    assert.equal(state.get('B').activeTurn.id, 'existing');
    assert.equal(state.get('B').activeTurn.human, false);
    if (kind === 'acp:test') assert.equal(service.get('A', m.id).errorCode, 'native_steer_unavailable');
  }
  const { service, state, calls } = setup(t);
  state.patch('B', { turn: 'awaitingUser', activeTurn: { id: 'approval', human: true } });
  const m = await service.send('A', request());
  await service.sendNow('A', m.id);
  assert.equal(service.get('A', m.id).errorCode, 'approval_pending');
  assert.equal(state.get('B').queue.length, 1);
  assert.equal(calls.length, 0);
});

test('approval arriving during immediate-delivery preflight restores the queue without native input', async (t) => {
  const { service, controller, state, calls } = setup(t);
  state.patch('B', { turn: 'running', activeTurn: { id: 'existing', human: false } });
  let checks = 0;
  service.gate = async () => {
    if (++checks === 2) state.patch('B', { turn: 'awaitingUser' });
    return null;
  };
  const m = await service.send('A', request());
  await tick();
  assert.equal(service.get('A', m.id).delivery, 'queued');
  assert.equal(service.get('A', m.id).errorCode, 'approval_pending');
  assert.equal(state.get('B').queue.length, 1);
  assert.equal(calls.length, 0);
  controller.end('B');
  await tick();
  assert.equal(service.get('A', m.id).delivery, 'delivered');
  assert.equal(calls.length, 1);
});

test('approval arriving during capability lookup preserves the queue and reports the actual reason', async (t) => {
  const { service, state, calls } = setup(t);
  state.patch('B', { turn: 'running', activeTurn: { id: 'existing' } });
  service.steerAvailability = async () => {
    state.patch('B', { turn: 'awaitingUser' });
    return null;
  };
  const result = await service.send('A', request());
  assert.equal(result.delivery, 'queued');
  assert.equal(result.errorCode, 'approval_pending');
  assert.equal(state.get('B').queue.length, 1);
  assert.equal(calls.length, 0);
});

test('immediate-delivery native rejection leaves the existing task running and permits only explicit retry', async (t) => {
  const { service, state, calls } = setup(t, 'codex', 'claude', { dispatch: () => ({ started: false, error: 'steer rejected' }) });
  state.patch('B', { turn: 'running', activeTurn: { id: 'existing', human: false } });
  const m = await service.send('A', request());
  await tick();
  assert.equal(service.get('A', m.id).delivery, 'failed');
  assert.equal(service.get('A', m.id).errorCode, 'steer rejected');
  assert.equal(state.get('B').turn, 'running');
  assert.equal(state.get('B').activeTurn.id, 'existing');
  assert.equal(calls.length, 1);
  await assert.rejects(service.sendNow('A', m.id), /cannot_send_now/);
  assert.equal(calls.length, 1);
});

test('pending switch prevents immediate delivery and retains stable routing for later dispatch', async (t) => {
  const { service, state, calls } = setup(t);
  state.patch('B', { turn: 'running', activeTurn: { id: 'existing', human: false }, pendingSwitch: { harness: 'claude' } });
  const m = await service.send('A', request());
  await service.sendNow('A', m.id);
  assert.equal(service.get('A', m.id).delivery, 'queued');
  assert.equal(service.get('A', m.id).errorCode, 'harness_switch_pending');
  assert.equal(state.get('B').queue[0].id, m.id);
  assert.equal(calls.length, 0);
});

test('disabled reply tools keep immediate requests queued rather than accepting an unanswerable steer', async (t) => {
  const { service, state, controller, calls } = setup(t);
  state.patch('B', { turn: 'running', activeTurn: { id: 'existing', human: false } });
  service.steerAvailability = () => 'tool_bridge_disabled';
  const m = await service.send('A', request());
  assert.equal(service.get('A', m.id).delivery, 'queued');
  assert.equal(service.get('A', m.id).errorCode, 'tool_bridge_disabled');
  assert.equal(calls.length, 0);
  controller.end('B');
  await tick();
  assert.equal(service.get('A', m.id).delivery, 'delivered');
  assert.equal(calls.length, 1);
});

for (const source of ['codex', 'claude', 'acp:test'])
  for (const target of ['codex', 'claude', 'acp:test']) {
    test(`${source} -> ${target}: durable delivery and authenticated reverse reply without windows`, async (t) => {
      const { service, controller, calls } = setup(t, source, target);
      const m = await service.send('A', request());
      await tick();
      assert.equal(service.get('A', m.id).delivery, 'delivered');
      assert.equal(calls[0].ref.kind, target);
      assert.equal(calls[0].item.opts.human, false);
      controller.end('B');
      const reply = await service.reply('B', { messageId: m.id, requestId: 'reply-1', body: 'Schema reviewed' });
      await tick();
      assert.equal(calls[1].ref.kind, source);
      assert.equal(service.get('A', m.id).reply, 'received');
      assert.equal(service.get('B', reply.id).reply, 'notRequested');
      // Retry after receipt stays idempotent and does not invoke another native turn.
      assert.equal((await service.reply('B', { messageId: m.id, requestId: 'reply-1', body: 'Schema reviewed' })).id, reply.id);
      assert.equal(calls.length, 2);
      controller.end('A');
    });
  }

test('busy and approval-waiting target queues FIFO and resolves switched harness at dispatch', async (t) => {
  const { service, controller, calls, state, records } = setup(t);
  state.patch('B', { turn: 'awaitingUser', activeTurn: { id: 'other', human: true } });
  const first = await service.send('A', request('first'));
  const second = await service.send('A', request('second', 'Next request'));
  assert.equal(calls.length, 0);
  assert.equal(service.get('A', first.id).delivery, 'queued');
  records.get('B')!.segments.push({ kind: 'claude', nativeId: 'switched-B' });
  controller.end('B');
  await tick();
  assert.equal(calls[0].item.id, first.id);
  assert.equal(calls[0].ref.id, 'switched-B');
  assert.equal(service.get('A', second.id).delivery, 'queued');
  controller.end('B');
  await tick();
  assert.equal(calls[1].item.id, second.id);
  controller.end('B');
});

test('blocked delivery, explicit resume, and cancellation leave no native input', async (t) => {
  let reason: string | null = 'login_required';
  const { service, calls, controller } = setup(t, 'codex', 'claude', { gate: () => reason });
  const m = await service.send('A', request());
  assert.equal(m.delivery, 'blocked');
  assert.equal(m.errorCode, reason);
  assert.equal(calls.length, 0);
  reason = null;
  await service.resume('A', m.id);
  await tick();
  assert.equal(calls.length, 1);
  assert.throws(() => service.cancel('A', m.id), /cannot_cancel/);
  controller.end('B');
  reason = 'archived';
  const cancelled = await service.send('A', request('cancel'));
  service.cancel('A', cancelled.id);
  await assert.rejects(service.resume('A', cancelled.id), /cannot_resume/);
  assert.equal(calls.length, 1);
});

test('idempotency races, conflicting bodies and identity validation', async (t) => {
  const { service, calls, controller } = setup(t);
  const pair = await Promise.all([service.send('A', request()), service.send('A', request())]);
  await tick();
  assert.equal(pair[0].id, pair[1].id);
  assert.equal(calls.length, 1);
  await assert.rejects(service.send('A', request('request-1', 'Changed body')), /idempotency_conflict/);
  await assert.rejects(service.send('missing', request()), /chat_unavailable/);
  await assert.rejects(service.send('A', { ...request(), targetChatId: 'A' }), /self_send/);
  assert.throws(() => service.get('missing', pair[0].id), /message_unavailable/);
  await assert.rejects(service.reply('A', { messageId: pair[0].id, requestId: 'fake', body: 'fake reply' }), /self_send|reply_unavailable/);
  controller.end('B');
});

test('no trusted sending grant and persistence failure both prevent dispatch', async (t) => {
  const denied = setup(t, 'claude', 'acp:test', { authorize: () => false });
  await assert.rejects(denied.service.send('A', request()), /send_not_authorized/);
  assert.equal(denied.calls.length, 0);
  const broken = setup(t, 'codex', 'claude', {
    write: () => {
      throw new Error('disk full');
    },
  });
  await assert.rejects(broken.service.send('A', request()), /disk full/);
  assert.equal(broken.calls.length, 0);
  assert.equal(broken.service.data.messages.length, 0);
});

test('native failure is not delivered; a fast completed turn still records acceptance', async (t) => {
  const broken = setup(t, 'codex', 'acp:test', { dispatch: () => ({ started: false, error: 'native offline' }) });
  const m = await broken.service.send('A', request());
  await tick();
  assert.equal(broken.service.get('A', m.id).delivery, 'failed');
  assert.equal(broken.service.get('A', m.id).errorCode, 'native offline');
  let controller: any;
  const fast = setup(t, 'claude', 'claude', {
    dispatch: () => {
      controller.end('B');
      return { started: true, turnId: 'fast-turn' };
    },
  });
  controller = fast.controller;
  const quick = await fast.service.send('A', request());
  await tick();
  assert.equal(fast.service.get('A', quick.id).delivery, 'delivered');
  assert.equal(fast.service.get('A', quick.id).targetTurnId, 'fast-turn');
});

test('restart marks submission uncertain and queued work blocked without automatic replay', async (t) => {
  const { file, service, state } = setup(t);
  state.patch('B', { turn: 'awaitingUser', activeTurn: { id: 'busy' } });
  const m = await service.send('A', request());
  const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
  journal.messages.push({ ...journal.messages[0], id: 'unknown', delivery: 'submitting' });
  fs.writeFileSync(file, JSON.stringify(journal));
  let submissions = 0;
  const recovered = new PeerMessageService({
    file,
    controller: { send: () => submissions++ },
    exists: () => true,
    authorize: () => true,
    gate: () => null,
  });
  assert.equal(recovered.get('A', m.id).delivery, 'blocked');
  assert.equal(recovered.get('A', 'unknown').delivery, 'uncertain');
  await assert.rejects(recovered.resume('A', 'unknown'), /cannot_resume/);
  assert.equal(submissions, 0);
});

test('registry tools derive source from authenticated ownership and enforce a separate sending grant', async (t) => {
  const { service, controller, calls } = setup(t, 'claude', 'acp:test', { authorize: (source: string) => source === 'A' });
  const registry = new Registry();
  const dispose = registerPeerTools(registry, {
    service,
    owner: (ctx: any) => (ctx.segmentId === `owned-${ctx.chatId}` ? ctx.chatId : null),
    directory: (_source: string, options: any) => ({ limit: options.limit }),
    read: () => ({ messages: [] }),
  });
  assert.equal(registry.list().length, 6);
  const forged = await registry.invoke('A', 'owned-B', 'send_message_to_chat', request());
  assert.equal(forged.error.code, 'no_owner');
  const sent = await registry.invoke('A', 'owned-A', 'send_message_to_chat', { ...request(), sourceChatId: 'B', replyTo: 'forged' });
  assert.equal(sent.ok, true);
  await tick();
  assert.equal(calls[0].chatId, 'B');
  assert.equal(service.data.messages[0].sourceChatId, 'A');
  assert.equal(service.data.messages[0].replyTo, null);
  const denied = await registry.invoke('B', 'owned-B', 'send_message_to_chat', { ...request(), targetChatId: 'A' });
  assert.equal(denied.error.code, 'send_not_authorized');
  const listing = await registry.invoke('A', 'owned-A', 'list_chats', { limit: 10000 });
  assert.equal(JSON.parse(listing.content[0].text).limit, 50);
  dispose();
  assert.equal(registry.list().length, 0);
  controller.end('B');
});

test('peer tool errors keep service codes while uncoded failures surface as generic tool failures', async (t) => {
  const { service } = setup(t);
  const registry = new Registry();
  registerPeerTools(registry, {
    service,
    owner: (ctx: any) => ctx.chatId,
    directory: () => {
      throw Object.assign(new Error('bad cursor'), { code: 'invalid_cursor' });
    },
    read: () => {
      throw new Error('disk exploded');
    },
  });
  const listing = await registry.invoke('A', 'seg', 'list_chats', {});
  assert.equal(listing.error.code, 'invalid_cursor');
  const read = await registry.invoke('A', 'seg', 'read_chat', { targetChatId: 'B' });
  assert.equal(read.error.code, 'failed');
  assert.equal(read.error.message, 'disk exploded');
});

test('wait times out or aborts without cancelling the remote request; concurrent waits observe receipt', async (t) => {
  const { service, controller, state } = setup(t, 'codex', 'acp:test'); // ACP takes it after its running turn
  state.patch('B', { turn: 'running', activeTurn: { id: 'busy' } });
  const m = await service.send('A', request());
  const timeout = await service.wait('A', m.id, { timeoutMs: 1 });
  assert.equal(timeout.timedOut, true);
  assert.equal(service.get('A', m.id).delivery, 'queued');
  const ac = new AbortController();
  const waiting = service.wait('A', m.id, { signal: ac.signal });
  ac.abort();
  await assert.rejects(waiting, /aborted/);
  assert.equal(service.listeners.size, 0);
  assert.equal(service.get('A', m.id).delivery, 'queued');
  const first = service.wait('A', m.id);
  const second = service.wait('B', m.id);
  controller.end('B');
  const outcomes = await Promise.all([first, second]);
  assert.equal(outcomes[0].timedOut, false);
  assert.equal(outcomes[1].timedOut, false);
  await tick();
  assert.equal(service.get('A', m.id).delivery, 'delivered');
  assert.equal(service.listeners.size, 0);
  controller.end('B');
});

test('cancellation during dispatch preflight cannot resurrect a request', async (t) => {
  let unblock: any;
  let gates = 0;
  const { service, calls } = setup(t, 'codex', 'claude', {
    gate: () =>
      ++gates === 1
        ? null
        : new Promise((resolve) => {
            unblock = resolve;
          }),
  });
  const m = await service.send('A', request());
  assert.equal(gates, 2);
  service.cancel('A', m.id);
  unblock(null);
  await tick();
  assert.equal(service.get('A', m.id).delivery, 'cancelled');
  assert.equal(calls.length, 0);
});

test('a submission journal write failure prevents the native call', async (t) => {
  const { service, calls } = setup(t);
  const write = service.write;
  service.write = (data: any) => {
    if (data.messages.some((m: any) => m.delivery === 'submitting')) throw new Error('disk full before native');
    write(data);
  };
  const m = await service.send('A', request());
  await tick();
  assert.equal(calls.length, 0);
  assert.equal(service.get('A', m.id).delivery, 'failed');
  assert.equal(service.get('A', m.id).errorCode, 'disk full before native');
});

test('reply receipt and parent status are committed together', async (t) => {
  const { service, controller } = setup(t);
  const m = await service.send('A', request());
  await tick();
  controller.end('B');
  const writes: any[] = [];
  const write = service.write;
  service.write = (data: any) => {
    writes.push(structuredClone(data));
    write(data);
  };
  const r = await service.reply('B', { messageId: m.id, requestId: 'reply', body: 'Done' });
  await tick();
  for (const data of writes) {
    const reply = data.messages.find((x: any) => x.id === r.id);
    if (reply?.delivery === 'delivered') assert.equal(data.messages.find((x: any) => x.id === m.id).reply, 'received');
  }
  assert.equal(service.get('A', m.id).reply, 'received');
  controller.end('A');
});

test('only a successful correlated final answer is forwarded; it does not create a reply loop', async (t) => {
  const { service, controller, calls } = setup(t);
  const m = await service.send('A', request());
  await tick();
  // An unrelated completion, progress message, or failed turn cannot reply to this request.
  await service.finished({ chatId: 'B', inputToken: `pending-${m.id}`, turnId: 'other', text: 'unrelated', completed: true });
  assert.equal(calls.length, 1);
  controller.onCodexMessage({
    method: 'item/completed',
    params: { threadId: 'native-B', turnId: `turn-${m.id}`, item: { type: 'agentMessage', text: 'progress', phase: 'commentary' } },
  });
  assert.equal(controller.rt('B').lastText, null);
  controller.onCodexMessage({
    method: 'item/completed',
    params: { threadId: 'native-B', turnId: `turn-${m.id}`, item: { type: 'agentMessage', text: 'Reviewed', phase: 'final_answer' } },
  });
  controller.end('B');
  await tick();
  assert.equal(calls.length, 2);
  const reply = service.data.messages.find((x: any) => x.replyTo === m.id);
  assert.equal(reply.body, 'Reviewed');
  assert.equal(service.get('A', m.id).reply, 'received');
  controller.rt('A').lastText = 'Acknowledged';
  controller.end('A');
  await tick();
  assert.equal(calls.length, 2);
});

test('explicit reply wins over final-answer fallback and failed target turns do not fabricate replies', async (t) => {
  const { service, controller, calls } = setup(t);
  const m = await service.send('A', request());
  await tick();
  await service.reply('B', { messageId: m.id, requestId: 'explicit', body: 'Explicit answer' });
  await tick();
  controller.rt('B').lastText = 'Different final';
  controller.end('B');
  await tick();
  assert.equal(service.data.messages.filter((x: any) => x.replyTo === m.id).length, 1);
  controller.end('A');
  const failed = await service.send('A', request('failed'));
  await tick();
  controller.rt('B').lastText = 'Progress before failure';
  controller.end('B', { outcome: 'failed' });
  await tick();
  assert.equal(service.get('A', failed.id).reply, 'awaiting');
  assert.equal(calls.length, 3);
});

test('fast completion before the acceptance callback waits for its correlated receipt', async (t) => {
  let controller: any;
  let state: any;
  const fixture = setup(t, 'codex', 'claude', {
    dispatch: (chat: string) => {
      if (chat === 'B') {
        state.patch('B', { activeTurn: { id: 'fast-native', human: false } });
        controller.rt('B').lastText = 'Fast final reply';
        controller.end('B');
        return { started: true, turnId: 'fast-native' };
      }
      return { started: true, turnId: 'reply-native' };
    },
  });
  controller = fixture.controller;
  state = fixture.state;
  const m = await fixture.service.send('A', request());
  await tick();
  assert.equal(fixture.calls.length, 2);
  assert.equal(fixture.service.get('A', m.id).reply, 'received');
  assert.equal(fixture.service.completions.size, 0);
  controller.end('A');
});

test('ACP and Claude final events are associated with their own request, across harnesses', async (t) => {
  for (const kind of ['claude', 'acp:test']) {
    const f = setup(t, 'codex', kind);
    const m = await f.service.send('A', request());
    await tick();
    if (kind === 'claude') {
      f.controller.onClaudeEvent({
        key: 'claude:native-B',
        kind: 'message',
        msg: { type: 'assistant', message: { content: [{ type: 'text', text: 'Intermediate' }] } },
      });
      f.controller.onClaudeEvent({
        key: 'claude:native-B',
        kind: 'message',
        msg: { type: 'result', subtype: 'success', is_error: false, result: 'Claude final' },
      });
    } else {
      f.controller.onAcpEvent({
        key: 'acp:test:native-B',
        kind: 'update',
        turnId: `turn-${m.id}`,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ACP final' } },
      });
      f.controller.onAcpEvent({ key: 'acp:test:native-B', kind: 'turnEnd', turnId: `turn-${m.id}`, stopReason: 'end_turn' });
    }
    await tick();
    assert.equal(f.service.get('A', m.id).reply, 'received');
    assert.equal(f.service.data.messages.find((x: any) => x.replyTo === m.id).body, kind === 'claude' ? 'Claude final' : 'ACP final');
    f.controller.end('A');
  }
});

test('ACK persistence failure is uncertain, keeps native running, and cannot be blindly retried', async (t) => {
  const f = setup(t, 'codex', 'claude');
  const write = f.service.write;
  f.service.write = (data: any) => {
    if (data.messages.some((m: any) => m.delivery === 'delivered')) throw new Error('ACK disk failure');
    write(data);
  };
  const m = await f.service.send('A', request());
  await tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.state.get('B').turn, 'running');
  assert.equal(f.service.get('A', m.id).delivery, 'uncertain');
  assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).messages[0].delivery, 'submitting');
  await assert.rejects(f.service.resume('A', m.id), /cannot_resume/);
  f.controller.end('B');
});

test('uncertain recovery reconciles exact native identity and never resends', async (t) => {
  const f = setup(t);
  const m = await f.service.send('A', request());
  await tick();
  f.service.update(m.id, { delivery: 'uncertain' });
  const receipt = { clientId: m.id, nativeId: 'native-B', kind: 'codex', turnId: `turn-${m.id}`, itemId: 'native-item' };
  let status = await f.service.reconcile('A', m.id, () => ({ ...receipt, clientId: 'wrong' }));
  assert.equal(status.delivery, 'uncertain');
  status = await f.service.reconcile('A', m.id, () => {
    throw new Error('offline');
  });
  assert.equal(status.errorCode, 'receipt_verification_unavailable');
  status = await f.service.reconcile('A', m.id, () => receipt);
  assert.equal(status.delivery, 'delivered');
  assert.equal(status.targetItemId, 'native-item');
  assert.equal(f.calls.length, 1);
  f.controller.end('B');
});

test('temporary conversations message normally without making permanent peer history', async (t) => {
  const f = setup(t, 'codex', 'claude', { temporary: (id: string) => id === 'B' });
  const m = await f.service.send('A', request());
  await tick();
  assert.equal(f.service.get('A', m.id).delivery, 'delivered');
  assert.equal(f.service.get('A', m.id).temporary, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')).messages, []);
  f.controller.end('B');
  await f.service.reply('B', { messageId: m.id, requestId: 'temp-reply', body: 'Answer' });
  await tick();
  assert.equal(f.service.get('A', m.id).reply, 'received');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')).messages, []);
  f.controller.end('A');
});

test('a reply to a deleted source stays in the journal blocked, without creating a replacement chat', async (t) => {
  const f = setup(t, 'codex', 'claude', { gate: (id: string) => (f.records.has(id) ? null : 'chat_deleted') });
  const m = await f.service.send('A', request());
  await tick();
  f.controller.end('B');
  f.records.delete('A');
  const reply = await f.service.reply('B', { messageId: m.id, requestId: 'deleted-reply', body: 'Retained answer' });
  assert.equal(reply.delivery, 'blocked');
  assert.equal(reply.errorCode, 'chat_deleted');
  assert.equal(reply.body, 'Retained answer');
  assert.equal(f.records.has('A'), false);
  assert.equal(f.calls.length, 1);
});

test('peer input stopped during switch preparation records a durable failure and can resume', async (t) => {
  for (const source of ['codex', 'claude', 'acp:test']) {
    for (const target of ['codex', 'claude', 'acp:test']) {
      const f = setup(t, source, target);
      let release!: (result: any) => void;
      f.controller.switcher = {
        perform: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      };
      f.state.patch('B', { pendingSwitch: { harness: target === 'codex' ? 'claude' : 'codex', mode: 'auto' } });
      const m = await f.service.send('A', request(`cancel-switch-${source}-${target}`));
      assert.equal(f.service.get('A', m.id).delivery, 'queued');
      f.controller.end('B', { drain: false });
      release({ ready: true });
      await tick();
      const failed = f.service.get('A', m.id);
      assert.equal(failed.delivery, 'failed');
      assert.equal(failed.errorCode, 'turn_changed');
      assert.equal(f.calls.length, 0, 'stopped preparation must not dispatch native input');
      assert.equal(f.state.get('B').queue.length, 0, 'peer recovery belongs to the delivery record');
      assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).messages.find((x: any) => x.id === m.id).delivery, 'failed');
      await f.service.resume('A', m.id);
      await tick();
      assert.equal(f.service.get('A', m.id).delivery, 'delivered');
      assert.equal(f.calls.length, 1);
    }
  }
});

test('a delayed resume cannot remove a request already queued by another resume', async (t) => {
  for (const source of ['codex', 'claude', 'acp:test']) {
    for (const target of ['codex', 'claude', 'acp:test']) {
      let blocked = true;
      let delayed: ((grant: boolean) => void) | undefined;
      let authorizations = 0;
      const f = setup(t, source, target, {
        gate: () => (blocked ? 'account_unavailable' : null),
        authorize: () =>
          ++authorizations === 2
            ? new Promise<boolean>((resolve) => {
                delayed = resolve;
              })
            : true,
      });
      const message = await f.service.send('A', request());
      assert.equal(message.delivery, 'blocked');
      blocked = false;
      f.state.patch('B', { turn: 'awaitingUser', activeTurn: { id: 'busy', human: false } });
      const stale = f.service.resume('A', message.id);
      assert.ok(delayed);
      await f.service.resume('A', message.id);
      assert.equal(f.state.get('B').queue.length, 1);
      delayed(true);
      await assert.rejects(stale, /cannot_resume/);
      assert.equal(f.service.get('A', message.id).delivery, 'queued');
      assert.deepEqual(
        f.state.get('B').queue.map((item: any) => item.id),
        [message.id],
      );
      f.controller.end('B');
      await tick();
      assert.equal(f.calls.length, 1);
      assert.equal(f.service.get('A', message.id).delivery, 'delivered');
    }
  }
});

test('cancellation during resume authorization stays cancelled without submitting native input', async (t) => {
  let authorize: ((grant: boolean) => void) | undefined;
  let initial = true;
  const f = setup(t, 'claude', 'acp:test', {
    gate: () => 'account_unavailable',
    authorize: () =>
      initial
        ? true
        : new Promise<boolean>((resolve) => {
            authorize = resolve;
          }),
  });
  const message = await f.service.send('A', request());
  initial = false;
  const resume = f.service.resume('A', message.id);
  assert.ok(authorize);
  f.service.cancel('A', message.id);
  authorize(true);
  await assert.rejects(resume, /cannot_resume/);
  assert.equal(f.service.get('A', message.id).delivery, 'cancelled');
  assert.equal(f.state.get('B').queue.length, 0);
  assert.equal(f.calls.length, 0);
});

test('late receipt checks cannot overwrite a delivery reconciled by another caller', async (t) => {
  for (const source of ['codex', 'claude', 'acp:test']) {
    for (const target of ['codex', 'claude', 'acp:test']) {
      for (const outcome of ['missing', 'error', 'receipt']) {
        const f = setup(t, source, target);
        const message = await f.service.send('A', request());
        await tick();
        f.service.update(message.id, { delivery: 'uncertain' });
        let resolve!: (receipt: any) => void;
        let reject!: (error: Error) => void;
        const stale = f.service.reconcile(
          'A',
          message.id,
          () =>
            new Promise((yes, no) => {
              resolve = yes;
              reject = no;
            }),
        );
        const receipt = { clientId: message.id, nativeId: 'native-B', kind: target, turnId: 'confirmed-turn', itemId: 'confirmed-item' };
        const confirmed = await f.service.reconcile('A', message.id, () => receipt);
        const journal = fs.readFileSync(f.file, 'utf8');
        if (outcome === 'error') reject(new Error('offline'));
        else resolve(outcome === 'receipt' ? { ...receipt, turnId: 'stale-turn', itemId: 'stale-item' } : null);
        assert.deepEqual(await stale, confirmed);
        assert.deepEqual(f.service.get('A', message.id), confirmed);
        assert.equal(fs.readFileSync(f.file, 'utf8'), journal);
        assert.equal(f.calls.length, 1);
        f.controller.end('B');
      }
    }
  }
});

test('reconciling an ACK write failure forwards the correlated buffered final answer once', async (t) => {
  for (const source of ['codex', 'claude', 'acp:test']) {
    for (const target of ['codex', 'claude', 'acp:test']) {
      for (const timing of ['beforeAck', 'afterAck']) {
        let f: any;
        const fixture = setup(t, source, target, {
          dispatch: (chatId: string) => {
            if (chatId === 'B' && timing === 'beforeAck') {
              f.state.patch('B', { activeTurn: { id: 'confirmed-turn', human: false } });
              f.controller.rt('B').lastText = 'Recovered final answer';
              f.controller.end('B');
            }
            return { started: true, turnId: chatId === 'B' ? 'confirmed-turn' : 'reply-turn' };
          },
        });
        f = fixture;
        const write = f.service.write;
        let failAck = true;
        f.service.write = (data: any) => {
          if (failAck && data.messages.some((m: any) => m.delivery === 'delivered')) throw new Error('ACK disk failure');
          write(data);
        };
        const message = await f.service.send('A', request());
        await tick();
        assert.equal(f.service.get('A', message.id).delivery, 'uncertain');
        if (timing === 'afterAck') {
          f.controller.rt('B').lastText = 'Recovered final answer';
          f.controller.end('B');
          await tick();
        }
        failAck = false;
        await f.service.reconcile('A', message.id, () => null);
        assert.equal(f.calls.length, 1);
        const receipt = { clientId: message.id, nativeId: 'native-B', kind: target, turnId: 'confirmed-turn' };
        failAck = true;
        await assert.rejects(
          f.service.reconcile('A', message.id, () => receipt),
          /ACK disk failure/,
        );
        assert.equal(f.service.get('A', message.id).delivery, 'uncertain');
        assert.equal(f.service.completions.size, 1);
        assert.equal(f.calls.length, 1);
        failAck = false;
        await f.service.reconcile('A', message.id, () => receipt);
        await tick();
        assert.equal(f.service.get('A', message.id).reply, 'received');
        assert.equal(f.calls.length, 2);
        assert.equal(f.calls[1].item.text.includes('Recovered final answer'), true);
        assert.equal(f.service.completions.size, 0);
        await f.service.reconcile('A', message.id, () => receipt);
        await tick();
        assert.equal(f.calls.length, 2);
        f.controller.end('A');
      }
    }
  }
});

test('receipt recovery discards a buffered answer from a different native turn', async (t) => {
  for (const target of ['codex', 'claude', 'acp:test']) {
    const f = setup(t, 'claude', target);
    const message = await f.service.send('A', request());
    await tick();
    f.service.update(message.id, { delivery: 'uncertain' });
    const completion = { chatId: 'B', inputToken: `pending-${message.id}`, turnId: 'other-turn', text: 'Wrong answer', completed: true };
    await f.service.finished(completion);
    assert.equal(f.service.completions.size, 1);
    const receipt = { clientId: message.id, nativeId: 'native-B', kind: target, turnId: `turn-${message.id}` };
    await f.service.reconcile('A', message.id, () => receipt);
    await tick();
    assert.equal(f.service.completions.size, 0);
    assert.equal(f.calls.length, 1);
    assert.equal(f.service.get('A', message.id).reply, 'awaiting');
    await f.service.finished({ ...completion, turnId: receipt.turnId, text: 'Correct answer' });
    await tick();
    assert.equal(f.calls.length, 2);
    assert.equal(f.service.get('A', message.id).reply, 'received');
    assert.ok(f.calls[1].item.text.includes('Correct answer'));
    f.controller.end('A');
    f.controller.end('B');
  }
});

test('stopping a peer turn during dispatch preflight prevents native submission and permits explicit retry', async (t) => {
  for (const source of ['codex', 'claude', 'acp:test']) {
    for (const target of ['codex', 'claude', 'acp:test']) {
      const f = setup(t, source, target);
      let release!: (reason: null) => void;
      let checks = 0;
      f.service.gate = () =>
        ++checks === 2
          ? new Promise((resolve) => {
              release = resolve;
            })
          : null;
      const message = await f.service.send('A', request());
      assert.ok(release);
      f.controller.end('B', { drain: false });
      release(null);
      await tick();
      assert.equal(f.calls.length, 0);
      assert.equal(f.service.get('A', message.id).delivery, 'failed');
      assert.equal(f.service.get('A', message.id).errorCode, 'turn_changed');
      assert.equal(f.state.get('B').turn, 'idle');
      await f.service.resume('A', message.id);
      await tick();
      assert.equal(f.calls.length, 1);
      assert.equal(f.service.get('A', message.id).delivery, 'delivered');
      f.controller.end('B');
    }
  }
});

test('a peer message whose target turn ends during delivery preflight starts a turn of its own, never the ended one', async (t) => {
  for (const source of ['codex', 'claude', 'acp:test']) {
    for (const target of ['codex', 'claude']) {
      const f = setup(t, source, target);
      const first = await f.service.send('A', request('first', 'Initial request'));
      await tick();
      let release!: (reason: null) => void;
      let checks = 0;
      f.service.gate = () =>
        ++checks === 2
          ? new Promise((resolve) => {
              release = resolve;
            })
          : null;
      const sending = f.service.send('A', request('followup', 'Follow-up request'));
      await tick();
      assert.ok(release);
      f.controller.end('B', { drain: false });
      release(null);
      const message = await sending;
      await tick();
      // the ended turn never takes it: like Claude Code resuming a session that finished first, it starts a turn of its own
      assert.equal(f.calls.length, 2);
      assert.equal(f.service.get('A', first.id).delivery, 'delivered');
      assert.equal(f.service.get('A', message.id).delivery, 'delivered');
      assert.equal(f.service.get('A', message.id).targetTurnId, `turn-${message.id}`);
      assert.equal(f.state.get('B').turn, 'running');
      assert.notEqual(f.service.get('A', message.id).targetTurnId, f.service.get('A', first.id).targetTurnId);
      f.controller.end('B');
    }
  }
});

test('a disabled receiving harness leaves blocked peer recovery in the journal, not the ordinary queue', async (t) => {
  for (const target of ['codex', 'claude', 'acp:kimi']) {
    for (const phase of ['initial', 'drain']) {
      const { controller, service, state, calls } = setup(t, 'codex', target);
      const waiting = { id: 'ordinary', text: 'keep my draft', attachments: [], opts: { human: true } };
      state.patch('B', { turn: phase === 'drain' ? 'awaitingUser' : 'idle', queue: [waiting] });
      controller.killed = () => 'disabled_by_admin';
      const sent = await service.send('A', request());
      if (phase === 'drain') {
        const peer = state.get('B').queue.find((item: any) => item.id === sent.id);
        state.patch('B', { turn: 'idle', queue: [peer, waiting] });
        await controller.drain('B');
      }
      await tick();
      assert.equal(service.get('A', sent.id).delivery, 'blocked');
      assert.equal(service.get('A', sent.id).errorCode, 'harness_turned_off');
      assert.deepEqual(state.get('B').queue, [waiting], `${target} ${phase}`);
      assert.equal(calls.length, 0);
      controller.killed = () => null;
      await service.resume('A', sent.id);
      await tick();
      assert.equal(service.get('A', sent.id).delivery, 'delivered');
      assert.equal(calls.length, 1, 'explicit resume delivers once');
      assert.equal(calls[0].item.id, sent.id);
      assert.deepEqual(state.get('B').queue, [waiting]);
    }
  }
});

test('a request steered into a turn that ends before the steer acknowledgement still gets one final reply (#3775)', async (t) => {
  for (const kind of ['codex', 'claude']) {
    for (const ack of [{ turnId: 'T1' }, { turnId: null }, { turnId: 'T2' }, { started: false, error: 'steer rejected' }]) {
      let release: (v: any) => void = () => {};
      const f = setup(t, 'codex', kind, {
        dispatch: (chatId: string) =>
          chatId === 'A' ? { started: true, turnId: 'reply-turn' } : new Promise((resolve) => (release = resolve)),
      });
      f.state.patch('B', { turn: 'running', activeTurn: { id: 'T1', human: true } });
      const m = await f.service.send('A', request());
      await tick();
      assert.equal(f.service.get('A', m.id).delivery, 'submitting');
      // the turn completes while the steer acknowledgement is still pending
      await f.service.finished({ chatId: 'B', inputToken: 'human-input', turnId: 'T1', text: 'Final answer', completed: true });
      assert.equal(f.service.get('A', m.id).reply, 'awaiting');
      release({ started: ack.started ?? true, ...ack });
      await tick();
      const answered = ack.started !== false && ack.turnId !== 'T2';
      assert.equal(
        f.service.data.messages.filter((x: any) => x.replyTo === m.id).length,
        answered ? 1 : 0,
        `${kind} ${JSON.stringify(ack)}`,
      );
      assert.equal(f.service.get('A', m.id).reply, answered ? 'received' : 'awaiting');
      if (answered) assert.equal(f.service.get('A', m.id).targetTurnId, ack.turnId);
      assert.equal(f.service.completions.size, 0);
      // a repeated completion never duplicates the reply
      await f.service.finished({ chatId: 'B', inputToken: 'human-input', turnId: 'T1', text: 'Final answer', completed: true });
      assert.equal(f.service.data.messages.filter((x: any) => x.replyTo === m.id).length, answered ? 1 : 0);
    }
  }
});
