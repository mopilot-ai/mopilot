import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { PeerRuntime } = require('../electron/session/peerRuntime.cjs');

function setup(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-runtime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const records = new Map([
    ['A', { segments: [{ kind: 'claude', nativeId: 'native-A' }], meta: {}, updatedAt: 1 }],
    ['B', { segments: [{ kind: 'acp:test', nativeId: 'native-B' }], meta: {}, updatedAt: 2 }],
  ]);
  const registry = new Registry();
  const rts = new Map<string, any>();
  const calls: any[] = [];
  const controller: any = {
    rt: (id: string) => {
      if (!rts.has(id)) rts.set(id, { token: null });
      return rts.get(id);
    },
    state: { get: () => ({ turn: 'idle' }) },
    send: (...args: any[]) => {
      calls.push(args);
      return { action: 'queued' };
    },
    peerCapabilities: () => ({ messaging: true, read: true, steer: false }),
    removeQueued: () => {},
  };
  const runtime = new PeerRuntime({
    file: path.join(dir, 'journal.json'),
    controller,
    chats: { records },
    registry,
    sourceWindow: (e: any) => e.source,
    gate: () => null,
    title: (id: string) => `Chat ${id}`,
    read: () => ({ records: ['history'] }),
    publish: () => {},
  });
  const handlers = new Map<string, any>();
  runtime.registerIpc({ handle: (name: string, handler: any) => handlers.set(name, handler) });
  return { runtime, controller, registry, calls, handlers, records };
}

test('directory gets the current recipient project from the native boundary rather than stale chat metadata', async (t) => {
  const { runtime, records } = setup(t);
  records.get('B')!.meta = { cwd: '/stale' } as any;
  const asked: string[] = [];
  runtime.projectOf = async (id: string) => {
    asked.push(id);
    return id === 'B' ? '/current-project' : null;
  };
  assert.equal((await runtime.directory('A')).chats[0].project, '/current-project');
  runtime.projectOf = async () => null;
  assert.equal((await runtime.directory('A')).chats[0].project, null);
  // only the page's chats have their folder read
  asked.length = 0;
  records.set('C', { segments: [{ kind: 'codex', nativeId: 'native-C' }], meta: {}, updatedAt: 0 } as any);
  runtime.projectOf = async (id: string) => (asked.push(id), null);
  const page = await runtime.directory('A', { limit: 1 });
  assert.deepEqual(asked, ['B']);
  assert.equal(page.nextCursor, '1');
});

test('MoMo’s chats are in no chat’s directory (#2139)', async (t) => {
  const { runtime, records } = setup(t);
  records.set('M', { segments: [{ kind: 'codex', nativeId: 'M' }], meta: { momo: 'main' }, updatedAt: 3 } as any);
  runtime.projectOf = async () => null;
  assert.deepEqual(
    (await runtime.directory('A')).chats.map((c: any) => c.id),
    ['B'],
  );
});

test('#3364: an agent reads and messages a chat the user never mentioned, like Claude Code’s SendMessage', async (t) => {
  const { runtime, registry, calls, controller } = setup(t);
  // the user's turn names no chat at all: wording grants nothing and is not needed
  controller.rt('A').token = 'turn-1';
  const read = await registry.invoke('A', 'claude:native-A', 'read_chat', { targetChatId: 'B' });
  assert.equal(read.ok, true);
  const first = await registry.invoke('A', 'claude:native-A', 'send_message_to_chat', {
    targetChatId: 'B',
    requestId: 'r1',
    body: 'Sync on MoMo',
  });
  assert.equal(first.ok, true);
  assert.equal(runtime.service.data.messages[0].sourceTurnId, 'turn-1');
  // no per-turn budget: a second request in the same turn is delivered too
  const second = await registry.invoke('A', 'claude:native-A', 'send_message_to_chat', {
    targetChatId: 'B',
    requestId: 'r2',
    body: 'One more',
  });
  assert.equal(second.ok, true);
  assert.equal(calls.length, 2);
  const self = await registry.invoke('A', 'claude:native-A', 'send_message_to_chat', { targetChatId: 'A', requestId: 'r3', body: 'Hi' });
  assert.equal(self.error.message, 'A chat can’t message itself.');
});

test('#3364: two chats on different harnesses talk both ways with no user wording: request, reply, and a request back', async (t) => {
  const { runtime, registry, calls, controller } = setup(t);
  const A = ['A', 'claude:native-A'] as const;
  const B = ['B', 'acp:test:native-B'] as const;
  const refs: Record<string, any> = { A: { kind: 'claude', id: 'native-A' }, B: { kind: 'acp:test', id: 'native-B' } };
  // the controller takes the queued item into a native turn that starts
  const deliver = async (turnId: string) => {
    const [chatId, item] = calls.at(-1);
    const event = { chatId, kind: 'turn', item, ref: refs[chatId] };
    await controller.beforeDispatch(event);
    await controller.onDispatchResult({ ...event, result: { started: true, turnId } });
    return item;
  };
  const message = (id: string) => runtime.service.data.messages.find((m: any) => m.id === id);

  // A asks B
  const ask = await registry.invoke(...A, 'send_message_to_chat', { targetChatId: 'B', requestId: 'a1', body: 'Sync on MoMo' });
  assert.equal(ask.ok, true);
  const asked = await deliver('turn-B1');
  assert.equal(message(asked.id).delivery, 'delivered');
  assert.match(asked.text, /Sync on MoMo/);
  // B answers with an explicit reply, which lands in A
  const reply = await registry.invoke(...B, 'reply_to_message', {
    messageId: asked.id,
    requestId: 'b-reply',
    body: 'Feature set attached',
  });
  assert.equal(reply.ok, true);
  const replied = await deliver('turn-A1');
  assert.equal(replied.peer.sourceChatId, 'B');
  assert.equal(message(asked.id).reply, 'received');

  // B starts its own conversation with A, not a reply, and A's final answer comes back to B
  const back = await registry.invoke(...B, 'send_message_to_chat', { targetChatId: 'A', requestId: 'b1', body: 'Which screens first?' });
  assert.equal(back.ok, true);
  const backItem = await deliver('turn-A2');
  assert.equal(message(backItem.id).sourceChatId, 'B');
  await controller.onFinished({
    chatId: 'A',
    inputToken: `pending-${backItem.id}`,
    turnId: 'turn-A2',
    text: 'Home, then chat',
    completed: true,
  });
  const answer = runtime.service.data.messages.find((m: any) => m.replyTo === backItem.id);
  assert.equal(answer.sourceChatId, 'A');
  assert.equal(answer.targetChatId, 'B');
  assert.equal(answer.body, 'Home, then chat');
  // and A can follow up with B again in the same turn: no per-turn budget on either side
  const again = await registry.invoke(...A, 'send_message_to_chat', { targetChatId: 'B', requestId: 'a2', body: 'Thanks, one more' });
  assert.equal(again.ok, true);
});

test('the receiving chat still decides delivery: a user pause holds the message, and a turn with no token records none', async (t) => {
  const { runtime, registry, controller } = setup(t);
  controller.onStopped('B');
  const held = await registry.invoke('A', 'claude:native-A', 'send_message_to_chat', { targetChatId: 'B', requestId: 'r', body: 'Hi' });
  assert.equal(held.ok, true);
  assert.equal(runtime.service.data.messages[0].errorCode, 'target_paused_by_user');
  assert.deepEqual(await runtime.service.authorize('A', 'B'), { sourceTurnId: null });
});

test('IPC validates source and strips forged routing; tools validate real segment membership', async (t) => {
  const { handlers, registry, runtime } = setup(t);
  assert.throws(() => handlers.get('peer:snapshot')({ source: 'B' }, 'A'), /invalid_source_window/);
  const sent = await handlers.get('peer:send')({ source: 'A' }, 'A', {
    targetChatId: 'B',
    requestId: 'direct',
    body: 'Hello',
    sourceChatId: 'B',
    replyTo: 'fake',
  });
  assert.equal(sent.sourceChatId, 'A');
  assert.equal(sent.replyTo, null);
  const unknown = await registry.invoke('A', 'A', 'list_chats', {});
  assert.equal(unknown.error.code, 'no_owner');
  const forged = await registry.invoke('A', 'acp:test:native-B', 'list_chats', {});
  assert.equal(forged.error.code, 'no_owner');
  const own = await registry.invoke('B', 'acp:test:native-B', 'list_chats', {});
  assert.equal(own.ok, true);
  const view = runtime.snapshot('A')[0];
  assert.equal('fingerprint' in view, false);
  assert.equal('dedupeKey' in view, false);
});

test('directory paging is bounded', async (t) => {
  const { runtime } = setup(t);
  assert.deepEqual(
    (await runtime.directory('A', { limit: 50 })).chats.map((c: any) => c.id),
    ['B'],
  );
  await assert.rejects(runtime.directory('A', { cursor: '-1' }), /invalid_cursor/);
});

test('user stop is durable and prevents a peer request from waking the target', async (t) => {
  const { runtime, controller, calls, handlers } = setup(t);
  controller.onStopped('B');
  assert.deepEqual(runtime.service.data.pausedChats, ['B']);
  const m = await handlers.get('peer:send')({ source: 'A' }, 'A', { targetChatId: 'B', requestId: 'paused', body: 'Review' });
  assert.equal(m.delivery, 'blocked');
  assert.equal(m.errorCode, 'target_paused_by_user');
  assert.equal(calls.length, 0);
  // Sender retry must respect the recipient's stop.
  await handlers.get('peer:resume')({ source: 'A' }, 'A', m.id);
  assert.equal(calls.length, 0);
  runtime.userTurn('B', { text: 'Resume my own work', opts: { human: true } });
  assert.deepEqual(runtime.service.data.pausedChats, []);
  await handlers.get('peer:resume')({ source: 'A' }, 'A', m.id);
  assert.equal(calls.length, 1);
});

test('failed pause persistence blocks waking the target until a durable user resume', async (t) => {
  const { runtime, controller, handlers, calls } = setup(t);
  const write = runtime.service.write;
  runtime.service.write = () => {
    throw new Error('disk full');
  };
  assert.throws(() => controller.onStopped('B'), /disk full/);
  assert.equal(runtime.service.gate('B'), 'target_pause_not_persisted');
  assert.throws(() => runtime.userTurn('B', { text: 'Resume', opts: { human: true } }), /disk full/);
  assert.equal(runtime.service.gate('B'), 'target_pause_not_persisted');
  runtime.service.write = write;
  const m = await handlers.get('peer:send')({ source: 'A' }, 'A', {
    targetChatId: 'B',
    requestId: 'disk-failure',
    body: 'Review',
  });
  assert.equal(m.delivery, 'blocked');
  assert.equal(m.errorCode, 'target_pause_not_persisted');
  assert.equal(calls.length, 0);
  runtime.userTurn('B', { text: 'Resume', opts: { human: true } });
  assert.equal(runtime.service.gate('B'), null);
  await handlers.get('peer:resume')({ source: 'A' }, 'A', m.id);
  assert.equal(calls.length, 1);
});

test('directory exposes adapter capabilities and recipient gates without silently hiding blocked chats', async (t) => {
  const { runtime, controller, records } = setup(t);
  for (const steer of [false, true]) {
    controller.peerCapabilities = () => ({ messaging: true, read: true, steer });
    const c = (await runtime.directory('A')).chats[0];
    assert.equal(c.capabilities.peerMessaging.available, true);
    assert.equal(c.capabilities.peerRead.available, true);
    assert.equal(c.capabilities.peerSteer.available, steer);
    assert.equal(c.capabilities.peerSteer.reason, steer ? null : 'adapter_capability_unavailable');
  }
  runtime.setPaused('B', true);
  const blocked = (await runtime.directory('A')).chats[0];
  assert.equal(blocked.id, 'B');
  assert.deepEqual(blocked.capabilities.peerMessaging, { available: false, reason: 'target_paused_by_user' });
  assert.equal(blocked.capabilities.peerRead.available, true);
  records.get('B')!.meta = { archived: 0 } as any;
  assert.equal((await runtime.directory('A')).chats[0].archived, true);
});

test('disabled tool bridges are explicit across adapter declarations while direct queued delivery remains available', async (t) => {
  const { runtime, controller, registry, handlers } = setup(t);
  for (const channel of ['channel.codex.threadConfigMcp', 'channel.claude.sdkMcp', 'channel.acp.sessionMcp']) {
    controller.peerCapabilities = () => ({ messaging: true, read: true, steer: true, toolChannel: channel });
    const seen: string[] = [];
    runtime.channelAvailability = (value: string) => {
      seen.push(value);
      return 'tool_bridge_disabled';
    };
    const caps = await handlers.get('peer:capabilities')({ source: 'A' }, 'A');
    assert.equal(caps.peerMessaging.available, true);
    assert.deepEqual(caps.peerTools, { available: false, reason: 'tool_bridge_disabled' });
    assert.deepEqual(caps.peerSteer, { available: false, reason: 'tool_bridge_disabled' });
    const result = await registry.invoke('A', 'claude:native-A', 'list_chats', {});
    assert.equal(result.error.code, 'tool_bridge_disabled');
    assert.ok(seen.every((c) => c === channel));
  }
  const sent = await handlers.get('peer:send')({ source: 'A' }, 'A', { targetChatId: 'B', requestId: 'fallback', body: 'Review' });
  assert.equal(sent.delivery, 'queued');
  runtime.channelAvailability = () => null;
  assert.equal((await registry.invoke('A', 'claude:native-A', 'list_chats', {})).ok, true);
});

test('reference IPC is bounded, authenticates the reading window and sends nothing', async (t) => {
  const { runtime, handlers, calls } = setup(t);
  runtime.referenceWindow = (event: any) => event.source === 'A';
  const reads: unknown[] = [];
  runtime.readReference = async (id: string, assistantOnly: boolean) => {
    reads.push([id, assistantOnly]);
    return { turns: [], earlierContentOmitted: false };
  };
  const read = handlers.get('peer:referenceHistory');
  await assert.rejects(read({ source: 'forged' }, ['B']), /invalid_source_window/);
  await assert.rejects(read({ source: 'A' }, Array(21).fill('B')), /invalid_references/);
  await assert.rejects(read({ source: 'A' }, ['deleted']), /chat_unavailable/);
  const result = await read({ source: 'A' }, ['B', 'B']);
  assert.deepEqual(Object.keys(result), ['B']);
  assert.deepEqual(reads, [['B', false]]);
  await assert.rejects(read({ source: 'A' }, ['B'], 'yes'), /invalid_references/);
  await read({ source: 'A' }, ['B'], true);
  assert.deepEqual(reads, [
    ['B', false],
    ['B', true],
  ]);
  assert.equal(calls.length, 0);
});

test('reference IPC defaults to refusing every window and reports a missing reader', async (t) => {
  const { runtime, handlers } = setup(t);
  const read = handlers.get('peer:referenceHistory');
  await assert.rejects(read({ source: 'A' }, ['B']), /invalid_source_window/);
  runtime.referenceWindow = () => true;
  await assert.rejects(read({ source: 'A' }, ['B']), /reference_reader_unavailable/);
});

test('the service steer preflight uses the runtime capability reason', async (t) => {
  const { runtime, controller } = setup(t);
  controller.peerCapabilities = () => ({ messaging: true, read: true, steer: true, toolChannel: 'c' });
  assert.equal(await runtime.service.steerAvailability('B'), null);
  runtime.channelAvailability = () => 'tool_bridge_disabled';
  assert.equal(await runtime.service.steerAvailability('B'), 'tool_bridge_disabled');
});

test('a read of a deleted chat reports it unavailable', async (t) => {
  const { registry, records } = setup(t);
  records.delete('B');
  const result = await registry.invoke('A', 'claude:native-A', 'read_chat', { targetChatId: 'B' });
  assert.equal(result.error.code, 'chat_unavailable');
});

test('user turns keep a supplied id and mint one for an empty id', (t) => {
  const { runtime } = setup(t);
  assert.equal(runtime.userTurn('A', { id: 'given', text: 'Hi', opts: { human: true } }).id, 'given');
  const minted = runtime.userTurn('A', { id: '', text: 'Hi', opts: { human: true } }).id;
  assert.equal(typeof minted, 'string');
  assert.ok(minted.length > 0);
  // automatic input neither resumes a paused chat nor gets an id minted
  const peer = { text: 'From a peer', opts: { human: false } };
  assert.equal(runtime.userTurn('A', peer), peer);
});

test('capabilities report unknown chats, undeclared adapters, approvals and pending switches', async (t) => {
  const { runtime, controller } = setup(t);
  await assert.rejects(runtime.capabilities('missing'), /chat_unavailable/);
  controller.peerCapabilities = undefined;
  const none = await runtime.capabilities('B');
  for (const key of ['peerMessaging', 'peerRead', 'peerTools', 'peerSteer']) {
    assert.deepEqual(none[key], { available: false, reason: 'adapter_capability_unavailable' });
  }
  controller.peerCapabilities = () => ({ messaging: true, read: true, steer: true });
  controller.state.get = () => ({ turn: 'awaitingUser' });
  assert.equal((await runtime.capabilities('B')).peerSteer.reason, 'approval_pending');
  controller.state.get = () => ({ turn: 'running', pendingSwitch: { kind: 'codex' } });
  assert.equal((await runtime.capabilities('B')).peerSteer.reason, 'harness_switch_pending');
});

test('directory refuses unknown sources, falls back to ids and pages with a cursor', async (t) => {
  const { runtime, records } = setup(t);
  await assert.rejects(runtime.directory('missing'), /chat_unavailable/);
  records.set('C', { segments: [], meta: {} } as any);
  runtime.title = (id: string) => (id === 'C' ? '' : `Chat ${id}`);
  const first = await runtime.directory('A', { limit: 1 });
  assert.deepEqual(
    first.chats.map((c: any) => c.id),
    ['B'],
  );
  assert.equal(first.nextCursor, '1');
  const second = await runtime.directory('A', { limit: 1, cursor: first.nextCursor });
  assert.deepEqual(
    second.chats.map((c: any) => [c.id, c.title, c.updatedAt]),
    [['C', 'C', 0]],
  );
  assert.equal(second.nextCursor, null);
  records.set('D', { segments: [], meta: {}, updatedAt: 0 } as any);
  records.set('0', { segments: [], meta: {} } as any);
  assert.deepEqual(
    (await runtime.directory('A')).chats.map((c: any) => c.id),
    ['B', '0', 'C', 'D'],
  );
});

test('snapshots fail on a disabled journal and include messages received by the chat', async (t) => {
  const { runtime, handlers } = setup(t);
  await handlers.get('peer:send')({ source: 'A' }, 'A', { targetChatId: 'B', requestId: 'r', body: 'Hello' });
  assert.deepEqual(
    runtime.snapshot('B').map((m: any) => [m.sourceChatId, m.targetChatId]),
    [['A', 'B']],
  );
  assert.throws(() => handlers.get('peer:send')({ source: 'A' }, 'A', null), /invalid_request/);
  runtime.service.startupError = 'journal_unavailable';
  assert.throws(() => runtime.snapshot('A'), /journal_unavailable/);
});

test('the literal Continue task action durably resumes Stop without generated user words', async (t) => {
  const { CONTINUE_TASK } = await import('../shared/taskPlanRecovery.mjs');
  const { runtime, controller } = setup(t);
  controller.onStopped('B');
  assert.equal(runtime.paused.has('B'), true);
  const item = runtime.userTurn('B', { text: CONTINUE_TASK, opts: { human: true } });
  assert.equal(item.text, CONTINUE_TASK);
  assert.equal(runtime.paused.has('B'), false);
  assert.deepEqual(runtime.service.data.pausedChats, []);
});
