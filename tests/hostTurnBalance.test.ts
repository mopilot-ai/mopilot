// Starts and ends balance per turn id on the Host's journal (host/src/protocol.mjs, chatLog.mjs `ended`): whatever order or repeats an adapter's events come in, a turn id is started once and its end is the last of it. Scripted over the runtime's event bus, as the families and the ACP host put events on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEpochStore } from '../host/src/epochs.mjs';
import { createGuard } from '../host/src/guard.mjs';
import { createLedger } from '../host/src/ledger.mjs';
import { createProtocol } from '../host/src/protocol.mjs';
import { createTurnBridge } from '../host/src/turnBridge.mjs';
import { helloParams } from '../shared/host/schema.mjs';

const quiet = { report: () => undefined };

async function open(withDataDir = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-balance-'));
  const host: any = new EventEmitter();
  host.cancel = () => undefined;
  const runtime: any = { host, send: async () => ({ turnId: 't' }), permit: () => true, familyOf: () => 'codex' };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const frames: any[] = [];
  const conn = createProtocol({
    runtime,
    epochs,
    guard,
    ...(withDataDir ? { dataDir: dir } : {}),
    status: () => ({ running: true }),
  }).connection((m: any) => frames.push(m));
  await conn.call('host.hello', helloParams());
  await conn.call('chat.subscribe', { chatId: 'c1', epoch: 1 });
  const say = (e: object) => host.emit('event', { key: 'c1', ...e });
  /** Each turn id's start, update and end items in the journal's order. */
  const journal = () => {
    const by = new Map<string, string[]>();
    for (const m of frames) {
      const it = m.chatId === 'c1' && m.frame?.t === 'durable' ? m.frame.item : null;
      if (it?.t === 'event' && it.event.turnId) by.set(it.event.turnId, [...(by.get(it.event.turnId) ?? []), it.event.kind]);
    }
    return Object.fromEntries(by);
  };
  return { say, journal };
}
const start = (turnId: string) => ({ kind: 'turnStart', turnId, user: { id: `u-${turnId}`, clientId: turnId, content: [] } });
const update = (turnId: string) => ({
  kind: 'update',
  turnId,
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } },
});
const end = (turnId: string) => ({ kind: 'turnEnd', turnId, stopReason: 'end_turn' });

for (const durable of [true, false]) {
  test(`A: a turn is started once and its end is the last of it, however the events repeat or reorder (${durable ? 'durable journal' : 'in memory'})`, async () => {
    const h = await open(durable);
    // in order, then the start told again after the end (J8's order), and the end told twice
    h.say(start('a'));
    h.say(update('a'));
    h.say(end('a'));
    h.say(start('a'));
    h.say(end('a'));
    // a start told twice while the turn is open
    h.say(start('b'));
    h.say(start('b'));
    h.say(update('b'));
    h.say(end('b'));
    // an end before any start of its turn, then the start: the end said nothing, the start opens a turn that is still open
    h.say(end('c'));
    h.say(start('c'));
    h.say(update('c'));
    const kinds = h.journal();
    assert.deepEqual(kinds.a, ['turnStart', 'update', 'turnEnd']);
    assert.deepEqual(kinds.b, ['turnStart', 'update', 'turnEnd']);
    // its words are one durable update once the message ends, so only the start is journaled while the turn is open
    assert.deepEqual(kinds.c, ['turnStart']);
    // and it ends once its own end comes: nothing was left half-open by the reordered one
    h.say(end('c'));
    assert.deepEqual(h.journal().c, ['turnStart', 'update', 'turnEnd']);
  });
}

test("B: Claude Code's turns follow the store's state alone, so a state told twice, or an idle before any run, starts and ends nothing twice", () => {
  const events: any[] = [];
  const active: Record<string, any> = {};
  const bridge = createTurnBridge({
    state: { get: (chatId: string) => ({ activeTurn: active[chatId] ?? null }) },
    emit: (e: any) => events.push(e),
    controller: () => ({ ref: () => ({ kind: 'claude' }), chatOf: (k: string) => k, resolveApproval: () => undefined }) as any,
    answer: () => true,
  });
  const say = (turn: string, id: string | null = null) => {
    active['claude:a'] = id ? { id } : null;
    bridge.patched({ chatId: 'claude:a', patch: { turn } });
  };
  say('idle'); // an end before any start: nothing to end
  say('running', 'pending-t1');
  say('running', 'pending-t1'); // the same state told again
  say('awaitingUser', 'pending-t1'); // still the same turn
  say('idle');
  say('idle'); // and the end told again
  say('running', 'pending-t2');
  say('idle');
  assert.deepEqual(
    events.map((e) => `${e.kind}:${e.turnId}`),
    ['turnStart:t1', 'turnEnd:t1', 'turnStart:t2', 'turnEnd:t2'],
  );
});
