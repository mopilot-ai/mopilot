import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tick } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { PeerMessageService } = require('../electron/session/peerMessages.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');

/** An in-memory service: the journal path never exists and writes are captured. */
function make(opts: any = {}) {
  const writes: any[] = [];
  const sent: any[] = [];
  const removed: any[] = [];
  const states: any = { A: { turn: 'idle', queue: [] }, B: { turn: 'idle', queue: [] } };
  const chats = new Set(['A', 'B']);
  const controller: any = {
    send: (id: string, item: any) => {
      sent.push({ id, item });
    },
    state: { get: (id: string) => states[id], patch: (id: string, p: any) => Object.assign(states[id], p) },
    peerCapabilities: () => ({ steer: opts.steer ?? true }),
    sendNow: () => opts.sendNow ?? true,
    removeQueued: (target: string, id: string) => {
      removed.push([target, id]);
    },
  };
  const service = new PeerMessageService({
    file: path.join(os.tmpdir(), `peer-edges-${crypto.randomUUID()}`, 'journal.json'),
    controller,
    exists: (id: string) => chats.has(id),
    authorize: opts.authorize ?? (() => ({ sourceTurnId: 'turn' })),
    gate: opts.gate ?? (() => null),
    write: (d: any) => writes.push(structuredClone(d)),
    publish: opts.publish,
    steerAvailability: opts.steerAvailability,
    inbox: opts.inbox,
  });
  return { service, controller, states, sent, writes, chats, removed };
}

const msg = (over: any = {}) => ({
  id: 'm1',
  sourceChatId: 'A',
  targetChatId: 'B',
  body: 'hi',
  dedupeKey: JSON.stringify(['A', 'r', 'B']),
  fingerprint: '[]',
  sourceTurnId: null,
  conversationId: 'c',
  replyTo: null,
  delivery: 'queued',
  reply: 'awaiting',
  createdAt: 1,
  targetTurnId: null,
  targetNativeId: null,
  targetItemId: null,
  errorCode: null,
  ...over,
});
const seed = (service: any, ...messages: any[]) => service.commit({ schemaVersion: 1, messages });
const req = (requestId: string, body = `Review ${requestId}`, extra: any = {}) => ({ targetChatId: 'B', requestId, body, ...extra });

test('journals with malformed paused chats are refused while valid paused chats load', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-edges-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'journal.json');
  const open = () => new PeerMessageService({ file, controller: {}, exists: () => true, authorize: () => true, gate: () => null });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, messages: [], pausedChats: ['B', 1] }));
  assert.equal(open().startupError, 'journal_unavailable');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, messages: [], pausedChats: ['B'] }));
  const ok = open();
  assert.equal(ok.startupError, undefined);
  assert.deepEqual(ok.data.pausedChats, ['B']);
});

test('presentation and listener failures never undo a durable commit, and are recorded', () => {
  clearIgnored();
  const { service, writes } = make({
    publish: () => {
      throw new Error('renderer gone');
    },
  });
  let later = 0;
  service.listeners.add(() => {
    throw new Error('listener failed');
  });
  service.listeners.add(() => {
    later++;
  });
  seed(service, msg());
  assert.equal(writes.length, 1);
  assert.equal(service.data.messages[0].id, 'm1');
  assert.equal(later, 1);
  assert.deepEqual(
    recentIgnored().map((e: any) => [e.context, e.message]),
    [
      ['show the peer message journal', 'renderer gone'],
      ['notify a peer message listener', 'listener failed'],
    ],
  );
});

test('missing messages and a disabled journal fail closed on read and update', () => {
  const { service } = make();
  assert.throws(() => service.update('nope', { errorCode: 'x' }), /message_missing/);
  seed(service, msg());
  service.startupError = 'journal_unavailable';
  assert.throws(() => service.get('A', 'm1'), /journal_unavailable/);
});

test('oversized bodies and request ids are rejected before any journal write', async () => {
  const { service, writes } = make();
  await assert.rejects(service.send('A', req('r', 'x'.repeat(32769))), /invalid_body/);
  await assert.rejects(service.send('A', req('r'.repeat(257))), /invalid_request_id/);
  assert.equal(writes.length, 0);
});

test('replies require a delivered awaiting parent and allow another reply only after cancelling the first', async () => {
  const { service } = make();
  const parent = await service.send('A', req('ask'));
  await assert.rejects(service.send('B', { targetChatId: 'A', requestId: 'early', body: 'Hi', replyTo: parent.id }), /reply_unavailable/);
  service.update(parent.id, { delivery: 'delivered' });
  await assert.rejects(service.send('A', { targetChatId: 'B', requestId: 'own', body: 'Hi', replyTo: parent.id }), /reply_unavailable/);
  const first = await service.reply('B', { messageId: parent.id, requestId: 'reply-1', body: 'One' });
  assert.equal(first.replyTo, parent.id);
  assert.equal(first.conversationId, parent.conversationId);
  await assert.rejects(service.reply('B', { messageId: parent.id, requestId: 'reply-2', body: 'Two' }), /reply_unavailable/);
  service.cancel('B', first.id);
  const second = await service.reply('B', { messageId: parent.id, requestId: 'reply-3', body: 'Three' });
  assert.equal(second.delivery, 'queued');
  const plain = await service.send('A', req('no-reply', 'FYI', { requestReply: false }));
  service.update(plain.id, { delivery: 'delivered' });
  await assert.rejects(service.reply('B', { messageId: plain.id, requestId: 'reply-4', body: 'Hm' }), /reply_unavailable/);
});

test('a concurrent send with the same request id but a different body conflicts after authorization', async () => {
  const { service, sent } = make({ authorize: async () => ({ sourceTurnId: 'turn' }) });
  const [first, second] = await Promise.allSettled([service.send('A', req('same', 'one')), service.send('A', req('same', 'two'))]);
  assert.equal(first.status, 'fulfilled');
  assert.equal(second.status, 'rejected');
  assert.equal((second as any).reason.code, 'idempotency_conflict');
  assert.equal(service.data.messages.length, 1);
  assert.equal(sent.length, 1);
});

test('a target holding 100 undelivered messages refuses more', async () => {
  // past the flood guard's 30-message burst: this checks the queue's own bound
  const { service } = make({ authorize: () => ({}), gate: () => 'target_paused_by_user', inbox: { admit: () => null } });
  for (let i = 0; i < 100; i++) assert.equal((await service.send('A', req(`r${i}`))).delivery, 'blocked');
  await assert.rejects(service.send('A', req('overflow')), /queue_full/);
  assert.equal(service.data.messages.length, 100);
});

test('enqueue leaves a message cancelled while its gate was pending', async () => {
  const { service, sent } = make();
  service.gate = async () => {
    const m = service.data.messages.at(-1);
    service.update(m.id, { delivery: 'cancelled' });
    return null;
  };
  const m = await service.send('A', req('cancelled'));
  assert.equal(m.delivery, 'cancelled');
  assert.equal(sent.length, 0);
});

test('dispatch rejects forged or misrouted peer items and blocks when the target became gated', async () => {
  const { service } = make();
  seed(service, msg());
  const item = (over: any = {}) => ({ id: 'm1', peer: { messageId: 'm1', sourceChatId: 'A' }, opts: {}, ...over });
  const ref = { kind: 'codex', id: 'native-B' };
  await assert.rejects(
    service.beforeDispatch({ chatId: 'B', kind: 'turn', item: item({ peer: undefined }), ref }),
    /invalid_peer_identity/,
  );
  await assert.rejects(
    service.beforeDispatch({ chatId: 'B', kind: 'turn', item: item({ peer: { messageId: 'm1', sourceChatId: 'B' } }), ref }),
    /invalid_peer_identity/,
  );
  await assert.rejects(service.beforeDispatch({ chatId: 'A', kind: 'turn', item: item(), ref }), /invalid_peer_dispatch/);
  service.gate = async () => {
    service.update('m1', { delivery: 'cancelled' });
    return null;
  };
  await assert.rejects(service.beforeDispatch({ chatId: 'B', kind: 'turn', item: item(), ref }), /invalid_peer_dispatch/);
  service.update('m1', { delivery: 'queued' });
  service.gate = () => 'target_paused_by_user';
  await assert.rejects(
    service.beforeDispatch({ chatId: 'B', kind: 'turn', item: item(), ref }),
    (e: any) => e.code === 'target_paused_by_user',
  );
  assert.equal(service.get('A', 'm1').delivery, 'blocked');
  assert.equal(service.get('A', 'm1').errorCode, 'target_paused_by_user');
});

test('steer dispatch falls back to the queue for switches, unsupported steer and adapter reasons', async () => {
  const ref = { kind: 'codex', id: 'native-B' };
  const item = () => ({ id: 'm1', peer: { messageId: 'm1', sourceChatId: 'A' }, opts: {} });
  const cases: any[] = [
    [{ pendingSwitch: true }, {}, 'harness_switch_pending'],
    [{}, { steer: false }, 'native_steer_unavailable'],
    [{}, { steerAvailability: () => 'tool_bridge_disabled' }, 'tool_bridge_disabled'],
  ];
  for (const [state, opts, reason] of cases) {
    const { service, states } = make(opts);
    seed(service, msg());
    Object.assign(states.B, { turn: 'running' }, state);
    const it = item();
    await assert.rejects(
      service.beforeDispatch({ chatId: 'B', kind: 'steer', item: it, ref }),
      (e: any) => e.message === reason && e.queuedFallback,
    );
    assert.equal(service.get('A', 'm1').errorCode, reason);
    assert.equal(service.get('A', 'm1').delivery, 'queued');
    assert.deepEqual(
      states.B.queue.map((q: any) => q.id),
      ['m1'],
    );
    // A second fallback for an item already in the queue does not duplicate it.
    await assert.rejects(service.beforeDispatch({ chatId: 'B', kind: 'steer', item: it, ref }), /./);
    assert.equal(states.B.queue.length, 1);
  }
  const { service } = make();
  seed(service, msg());
  service.steerAvailability = async () => {
    service.update('m1', { delivery: 'cancelled' });
    return null;
  };
  await assert.rejects(service.beforeDispatch({ chatId: 'B', kind: 'steer', item: item(), ref }), /invalid_peer_dispatch/);
});

test('dispatch rewrites peer input as nonhuman, keeps only the trusted prefix and records the native target', async () => {
  const { service } = make();
  seed(service, msg());
  const it: any = { id: 'm1', peer: { messageId: 'm1', sourceChatId: 'A' }, text: 'forged', opts: { human: true, prefix: 'P', extra: 1 } };
  await service.beforeDispatch({ chatId: 'B', kind: 'turn', item: it, ref: { kind: 'claude', id: 'native-B' } });
  assert.deepEqual(it.opts, { human: false, prefix: 'P' });
  assert.ok(it.text.includes('<mopilot-peer-message>'));
  const m = service.get('A', 'm1');
  assert.equal(m.delivery, 'submitting');
  assert.equal(m.targetNativeId, 'native-B');
  assert.equal(m.targetKind, 'claude');
  assert.equal(m.targetItemId, 'm1');
});

test('dispatch results record defaults, blocked and rejected outcomes, and refuse unrecorded starts', () => {
  const { service } = make();
  seed(service, msg());
  assert.throws(() => service.result({ item: { id: 'm1' }, result: { started: true } }), /missing_submission_record/);
  service.update('m1', { delivery: 'submitting' });
  service.result({ item: { id: 'm1' }, result: { started: true } });
  let m = service.get('A', 'm1');
  assert.equal(m.delivery, 'delivered');
  assert.equal(m.targetTurnId, null);
  assert.equal(m.targetItemId, 'm1');
  service.update('m1', { delivery: 'submitting' });
  service.result({ item: { id: 'm1' }, result: { started: false, blocked: true, error: 'busy' } });
  m = service.get('A', 'm1');
  assert.equal(m.delivery, 'blocked');
  assert.equal(m.errorCode, 'busy');
  service.update('m1', { delivery: 'submitting' });
  service.result({ item: { id: 'm1' }, result: null });
  m = service.get('A', 'm1');
  assert.equal(m.delivery, 'failed');
  assert.equal(m.errorCode, 'native_rejected');
});

test('a started reply whose parent vanished fails, and a failed acknowledgement write still exposes uncertainty', () => {
  const { service } = make();
  seed(service, msg({ id: 'r1', sourceChatId: 'B', targetChatId: 'A', replyTo: 'gone', delivery: 'submitting', reply: 'notRequested' }));
  assert.throws(() => service.result({ item: { id: 'r1' }, result: { started: true } }), /message_missing/);
  const published: any[] = [];
  service.publish = () => {
    published.push(1);
    throw new Error('renderer gone');
  };
  seed(service, msg({ delivery: 'submitting' }));
  published.length = 0;
  service.write = () => {
    throw new Error('disk full');
  };
  assert.throws(() => service.result({ item: { id: 'm1' }, result: { started: true, turnId: 't' } }), /disk full/);
  assert.equal(service.data.messages[0].delivery, 'uncertain');
  assert.equal(service.data.messages[0].errorCode, 'acknowledgement_not_persisted');
  assert.equal(published.length, 1);
});

test('final answers do not reply twice, and an unsendable final answer is recorded on the request', async () => {
  const { service } = make();
  seed(
    service,
    msg({ delivery: 'delivered' }),
    msg({ id: 'x', sourceChatId: 'B', targetChatId: 'A', replyTo: 'm1', delivery: 'queued', reply: 'notRequested', dedupeKey: 'k2' }),
  );
  await service.finished({ chatId: 'B', inputToken: 'pending-m1', text: 'Answer', completed: true });
  assert.equal(service.data.messages.length, 2);
  service.update('x', { delivery: 'cancelled' });
  await service.finished({ chatId: 'B', inputToken: 'pending-m1', text: 'y'.repeat(32769), completed: true });
  assert.equal(service.get('A', 'm1').errorCode, 'reply_failed');
  assert.equal(service.data.messages.length, 2);
  await service.finished({ chatId: 'B', inputToken: 'pending-m1', text: 'Answer', completed: true });
  assert.equal(service.data.messages.length, 3);
  assert.equal(service.data.messages[2].replyTo, 'm1');
});

test('a non-Error failure while sending the final answer is still recorded', async () => {
  const { service } = make();
  seed(service, msg({ delivery: 'delivered' }));
  service.gate = () => {
    throw 'gate offline';
  };
  await service.finished({ chatId: 'B', inputToken: 'pending-m1', text: 'Answer', completed: true });
  assert.equal(service.get('A', 'm1').errorCode, 'reply_failed');
});

test('send-now rechecks the message after each await and reports gates and missing queue items', async () => {
  const { service, states } = make();
  seed(service, msg());
  service.gate = async () => 'target_paused_by_user';
  assert.equal((await service.sendNow('A', 'm1')).errorCode, 'target_paused_by_user');
  service.gate = async () => {
    service.update('m1', { delivery: 'cancelled' });
    return null;
  };
  await assert.rejects(service.sendNow('A', 'm1'), /cannot_send_now/);
  service.update('m1', { delivery: 'queued' });
  service.gate = () => null;
  states.B.turn = 'running';
  service.steerAvailability = async () => {
    service.update('m1', { delivery: 'cancelled' });
    return null;
  };
  await assert.rejects(service.sendNow('A', 'm1'), /cannot_send_now/);
  service.update('m1', { delivery: 'queued' });
  service.steerAvailability = () => null;
  const missing = make({ sendNow: false });
  seed(missing.service, msg());
  await assert.rejects(missing.service.sendNow('A', 'm1'), /queued_input_missing/);
});

test('resume requires a live target and a fresh grant for nonreply messages', async () => {
  const { service, chats, sent } = make({ authorize: () => false });
  seed(service, msg({ delivery: 'blocked' }));
  chats.delete('B');
  await assert.rejects(service.resume('A', 'm1'), /chat_unavailable/);
  chats.add('B');
  await assert.rejects(service.resume('A', 'm1'), /send_not_authorized/);
  assert.equal(sent.length, 0);
});

test('reconcile leaves settled messages alone and marks a verified reply received even without an item id', async () => {
  const { service } = make();
  seed(service, msg({ delivery: 'delivered' }));
  let reads = 0;
  assert.equal(
    (
      await service.reconcile('A', 'm1', async () => {
        reads++;
      })
    ).delivery,
    'delivered',
  );
  assert.equal(reads, 0);
  const receipt = (m: any) => ({ kind: 'codex', nativeId: 'nb', clientId: m.id, turnId: 'tt' });
  seed(
    service,
    msg({ delivery: 'delivered', reply: 'awaiting' }),
    msg({
      id: 'r1',
      sourceChatId: 'B',
      targetChatId: 'A',
      replyTo: 'm1',
      delivery: 'uncertain',
      reply: 'notRequested',
      targetNativeId: 'nb',
      targetKind: 'codex',
      dedupeKey: 'k2',
    }),
    msg({
      id: 'r2',
      sourceChatId: 'B',
      targetChatId: 'A',
      replyTo: 'gone',
      delivery: 'uncertain',
      reply: 'notRequested',
      targetNativeId: 'nb',
      targetKind: 'codex',
      dedupeKey: 'k3',
    }),
  );
  const r1 = await service.reconcile('B', 'r1', receipt);
  assert.equal(r1.delivery, 'delivered');
  assert.equal(r1.targetItemId, 'r1');
  assert.equal(service.get('A', 'm1').reply, 'received');
  assert.equal(service.get('A', 'm1').replyMessageId, 'r1');
  assert.equal((await service.reconcile('B', 'r2', receipt)).delivery, 'delivered');
});

test('waits reject an already aborted signal, ignore unchanged commits and accept a non-finite timeout', async () => {
  const { service } = make();
  seed(service, msg());
  await assert.rejects(service.wait('A', 'm1', { signal: { aborted: true } }), /aborted/);
  let settled = false;
  const pending = service.wait('A', 'm1', { timeoutMs: Number.NaN }).then((r: any) => {
    settled = true;
    return r;
  });
  seed(service, msg());
  await tick();
  assert.equal(settled, false);
  service.update('m1', { delivery: 'delivered' });
  const result = await pending;
  assert.equal(result.timedOut, false);
  assert.equal(result.message.delivery, 'delivered');
  assert.equal(service.listeners.size, 0);
});

test('a final answer that arrived before the acknowledgement, and can be neither sent nor recorded, leaves the delivery as it is', async () => {
  const { service } = make();
  seed(service, msg({ delivery: 'submitting' }));
  // the target finished before its acceptance was recorded
  await service.finished({ chatId: 'B', inputToken: 'pending-m1', turnId: 't', text: 'Answer', completed: true });
  assert.equal(service.completions.size, 1);
  let writes = 0;
  service.write = () => {
    // the acknowledgement is saved; the disk fills before the reply or its failure can be
    if (++writes > 1) throw new Error('disk full');
  };
  service.result({ item: { id: 'm1' }, result: { started: true, turnId: 't' } });
  await new Promise((r) => setImmediate(r));
  assert.equal(service.completions.size, 0);
  assert.ok(writes >= 2, 'the reply was attempted');
  assert.equal(service.get('A', 'm1').delivery, 'delivered');
  assert.equal(service.get('A', 'm1').errorCode, null);
});

test('journal writes retain the primary write or rename error when temporary-file cleanup also fails', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-write-errors-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'journal.json');
  const service = new PeerMessageService({ file, controller: {}, exists: () => true, authorize: () => true, gate: () => null });
  service.commit(service.data);
  const before = fs.readFileSync(file, 'utf8');
  const state = service.data;
  for (const phase of ['writeFileSync', 'renameSync'] as const) {
    const primary = Object.assign(new Error(`primary ${phase}`), { code: 'EACCES' });
    const cleanup = Object.assign(new Error('cleanup failed'), { code: 'EPERM' });
    const failing = t.mock.method(fs, phase, () => {
      throw primary;
    });
    const removal = t.mock.method(fs, 'rmSync', () => {
      throw cleanup;
    });
    try {
      assert.throws(
        () => service.commit({ schemaVersion: 1, messages: [msg()] }),
        (error: unknown) => error === primary,
      );
      assert.equal(removal.mock.callCount(), 1);
      assert.equal(service.data, state);
    } finally {
      failing.mock.restore();
      removal.mock.restore();
    }
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
});
