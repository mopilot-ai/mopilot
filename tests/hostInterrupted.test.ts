// A turn the Host stopped under (host/src/protocol.mjs `interrupted`, with the run journal): the protocol writes each turn's start and end to the journal, and ends the turns a dead Host left running as cancelled in the log a client subscribes to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEpochStore } from '../host/src/epochs.mjs';
import { createGuard } from '../host/src/guard.mjs';
import { createLedger } from '../host/src/ledger.mjs';
import { createChatLog, recoverTurn } from '../host/src/chatLog.mjs';
import { createProtocol } from '../host/src/protocol.mjs';
import { helloParams } from '../shared/host/schema.mjs';

const quiet = { report: () => undefined };

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-interrupted-'));
  const host: any = new EventEmitter();
  host.cancel = () => undefined;
  const runtime: any = { host, send: async () => ({ turnId: 't' }), permit: () => true };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const journaled: string[] = [];
  const journal: any = {
    begin: (t: string, c: string) => journaled.push(`begin ${t} ${c}`),
    end: (t: string) => journaled.push(`end ${t}`),
  };
  const protocol = createProtocol({ runtime, epochs, guard, status: () => ({ running: true }), journal });
  const subscribe = async (chatId: string) => {
    const out: any[] = [];
    const conn = protocol.connection((m: object) => out.push(m));
    await conn.call('host.hello', helloParams());
    await conn.call('chat.subscribe', { chatId, epoch: 1 });
    return out;
  };
  return { host, protocol, journaled, subscribe };
}

test('A: the protocol journals each turn from its start to its end, and only the turns it knows', () => {
  const s = setup();
  s.host.emit('event', { kind: 'turnStart', key: 'acp:kimi:a', turnId: 't1' });
  s.host.emit('event', { kind: 'turnEnd', turnId: 'unknown' });
  s.host.emit('event', { kind: 'turnEnd', turnId: 't1', stopReason: 'end_turn' });
  assert.deepEqual(s.journaled, ['begin t1 acp:kimi:a', 'end t1']);
});

test('I: turns a dead Host left running end as cancelled, with the reason, for a client already there and one that comes later', async () => {
  const s = setup();
  const early = await s.subscribe('acp:kimi:a');
  s.protocol.interrupted([
    ['t1', 'acp:kimi:a'],
    ['t2', 'chat-codex'],
  ]);
  const ended = (out: any[]) => out.filter((m) => m.frame?.item?.event?.kind === 'turnEnd').map((m) => m.frame.item.event);
  assert.deepEqual(
    ended(early).map((e) => [e.turnId, e.stopReason, e.error.message]),
    [['t1', 'cancelled', 'The host stopped while this turn was running.']],
  );
  // a client that subscribes afterwards is given the same in its snapshot, and the reply summary says the same
  const late = await s.subscribe('acp:kimi:a');
  const snapshot = late.find((m) => m.frame?.t === 'hello').frame.snapshot;
  assert.deepEqual(
    snapshot.items.map((i: any) => i.t),
    ['event', 'assistant'],
  );
  assert.equal(snapshot.items[1].error, 'The host stopped while this turn was running.');
  assert.equal(snapshot.items[1].stopReason, 'cancelled');
  // another chat's turn is in that chat's log only
  assert.equal((await s.subscribe('chat-codex')).find((m) => m.frame?.t === 'hello').frame.snapshot.items.length, 2);
});

test('#4278: an interrupted turn says what the restart interrupted: the tool calls still running, not the finished ones', async () => {
  const s = setup();
  const chat = 'acp:kimi:w';
  const update = (u: object) => s.host.emit('event', { kind: 'update', turnId: 't1', update: u });
  s.host.emit('event', { kind: 'turnStart', key: chat, turnId: 't1' });
  update({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'ls', kind: 'execute', status: 'in_progress' });
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' });
  update({ sessionUpdate: 'tool_call', toolCallId: 'c2', title: 'npm test', kind: 'execute', status: 'in_progress' });
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'c2', status: 'in_progress' });
  update({ sessionUpdate: 'tool_call', toolCallId: 'c3', kind: 'edit', status: 'in_progress' });
  update({ sessionUpdate: 'tool_call', toolCallId: 'c4', title: 'failed one', status: 'failed' });
  update({ sessionUpdate: 'plan', entries: [] });
  s.protocol.interrupted([
    ['t1', chat],
    ['t9', 'acp:kimi:quiet'],
  ]);
  const end = async (chatId: string) =>
    (await s.subscribe(chatId))
      .find((m) => m.frame?.t === 'hello')
      .frame.snapshot.items.map((i: any) => i.event)
      .find((e: any) => e?.kind === 'turnEnd');
  assert.deepEqual((await end(chat)).interrupted, { by: 'host_restart', running: ['npm test', 'a tool call'] });
  // a turn that was running nothing says so with an empty list
  assert.deepEqual((await end('acp:kimi:quiet')).interrupted, { by: 'host_restart', running: [] });
});

test('B: a journal that cannot be read for the notice does not keep the turn from being ended', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-interrupted-log-'));
  const log = createChatLog({ dataDir: dir, epoch: () => 1 });
  const recorded: any[] = [];
  recoverTurn(
    {
      ...log,
      open: () => {
        throw new Error('unreadable');
      },
      lost: () => {
        throw new Error('unreadable');
      },
    },
    'acp:kimi:x',
    't1',
    (_chat: string, e: any) => recorded.push(e),
    'The host stopped while this turn was running.',
  );
  assert.deepEqual(recorded[0].interrupted, { by: 'host_restart', running: [] });
});

test('B: a turn whose cards were closed and whose end could not be written is ended by the next try with the same names, and no card is closed twice', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-interrupted-retry-'));
  const log = createChatLog({ dataDir: dir, epoch: () => 1 });
  const chat = 'acp:kimi:r';
  const event = (e: object) => log.finish(chat, { t: 'event', event: e });
  event({
    kind: 'update',
    turnId: 't1',
    update: { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'npm test', status: 'in_progress' },
  });
  const recorded: any[] = [];
  const record = (fail: boolean) => (_chat: string, e: any) => {
    if (fail && e.kind === 'turnEnd') throw new Error('disk full');
    recorded.push(e);
    event(e);
  };
  assert.throws(() => recoverTurn(log, chat, 't1', record(true), 'stopped'), /disk full/);
  assert.deepEqual(
    recorded.map((e) => e.update?.status),
    ['failed'],
  );
  recoverTurn(log, chat, 't1', record(false), 'stopped');
  assert.deepEqual(
    recorded.map((e) => e.kind),
    ['update', 'turnEnd'],
    'the card the first try closed is not closed again',
  );
  assert.deepEqual(recorded[1].interrupted, { by: 'host_restart', running: ['npm test'] });
});
