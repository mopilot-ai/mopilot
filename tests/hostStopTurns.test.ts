// The turns running when the Host is told to stop end as interrupted by the stop, before their children are ended (Remote Run #5162): the chat says the Host's own cause, host.log names the chats, and a harness that reports its quit afterwards does not end the turn a second time.
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
import { createRunJournal } from '../host/src/runJournal.mjs';
import { endTurnsAtStop } from '../host/src/stopTurns.mjs';
import { helloParams } from '../shared/host/schema.mjs';

const quiet = { report: () => undefined };

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-stop-turns-'));
  const host: any = new EventEmitter();
  host.cancel = () => undefined;
  const runtime: any = { host, send: async () => ({ turnId: 't' }), permit: () => true };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const journal = createRunJournal({ dataDir: dir, report: () => undefined });
  journal.start();
  const protocol = createProtocol({ runtime, epochs, guard, status: () => ({ running: true }), journal });
  const snapshot = async (chatId: string) => {
    const out: any[] = [];
    const conn = protocol.connection((m: object) => out.push(m));
    await conn.call('host.hello', helloParams());
    await conn.call('chat.subscribe', { chatId, epoch: 1 });
    return out.find((m) => m.frame?.t === 'hello').frame.snapshot.items;
  };
  return { host, protocol, journal, snapshot };
}

test('running turns end as interrupted by the stop, once, the log names their chats, and nothing running is nothing', async () => {
  const s = setup();
  const logged: string[] = [];
  assert.equal(endTurnsAtStop({ journal: s.journal, protocol: s.protocol, report: (l: string) => logged.push(l) }), 0);
  assert.equal(logged.length, 0, 'no running turn: nothing ended and nothing said');
  s.host.emit('event', { kind: 'turnStart', key: 'acp:kimi:a', turnId: 't1' });
  s.host.emit('event', { kind: 'turnStart', key: 'acp:kimi:a', turnId: 't2' });
  s.host.emit('event', { kind: 'turnStart', key: 'acp:kimi:b', turnId: 't3' });
  s.host.emit('event', { kind: 'turnEnd', turnId: 't2', stopReason: 'end_turn' });
  assert.equal(endTurnsAtStop({ journal: s.journal, protocol: s.protocol, report: (l: string) => logged.push(l) }), 2);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /Ended 2 running turn\(s\) at stop/);
  assert.match(logged[0], /acp:kimi:a/);
  assert.match(logged[0], /acp:kimi:b/);
  const ends = (items: any[]) => items.map((i) => i.event).filter((e) => e?.kind === 'turnEnd');
  const a = ends(await s.snapshot('acp:kimi:a'));
  assert.deepEqual(
    a.filter((e) => e.turnId === 't1').map((e) => [e.stopReason, e.interrupted.by, e.error.message]),
    [['cancelled', 'host_restart', 'The host stopped while this turn was running.']],
  );
  // the harness reports its own quit as the child is ended afterwards: the turn is not ended a second time
  s.host.emit('event', { kind: 'turnEnd', turnId: 't1', stopReason: 'error', error: { message: 'Claude Code quit while working.' } });
  assert.equal(ends(await s.snapshot('acp:kimi:a')).filter((e) => e.turnId === 't1').length, 1, 'one end for the turn');
  assert.equal(s.journal.pending().length, 0, 'nothing is left running for the next Host to recover');
});
