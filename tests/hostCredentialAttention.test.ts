// A turn that stops for a credential says so (U4): the harness's typed `auth` code on a turn's end sets the chat's attention and tells the push port once, for Claude Code, Codex and ACP; a turn that runs clears it, also across a Host restart (A6, B1, I-restart).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createProtocol } from '../host/src/protocol.mjs';
// @ts-ignore
import { createEpochStore } from '../host/src/epochs.mjs';
// @ts-ignore
import { createLedger } from '../host/src/ledger.mjs';
// @ts-ignore
import { createGuard } from '../host/src/guard.mjs';
// @ts-ignore
import { helloParams } from '../shared/host/schema.mjs';
// @ts-ignore
import { typedTurnEnd } from '../shared/host/turnErrorCode.mjs';

const quiet = { report: () => undefined };
const FAMILIES = [
  { name: 'claude', chatId: 'claude:c1', end: { error: { message: 'Not signed in', code: 'auth' } } },
  { name: 'codex', chatId: 'codex-c1', end: { error: { message: 'Unauthorized', code: 'auth' } } },
  // an ACP agent says it in words only: the Host types them once (shared/host/turnErrorCode.mjs), before the protocol sees the turn's end
  { name: 'acp', chatId: 'acp:kimi:c1', end: { error: { message: 'Invalid API key · Please run /login' } } },
];
const familyOf = (id: string) => (id.startsWith('claude:') ? 'claude' : id.startsWith('acp:') ? 'acp' : 'codex');

function setup(chatId: string, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-credential-'))) {
  const host: any = new EventEmitter();
  host.cancel = () => undefined;
  const runtime: any = { host, familyOf, send: async () => ({ turnId: 't2' }), permit: () => true };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const told: any[] = [];
  const protocol = createProtocol({
    runtime,
    epochs,
    guard,
    status: () => ({ running: true }),
    dataDir: dir,
    ...quiet,
    notify: (m: any) => told.push(m),
  });
  const out: any[] = [];
  const conn = protocol.connection((m: object) => out.push(m));
  const attention = () => out.filter((m) => m.frame?.t === 'state' && 'attention' in m.frame.patch).map((m) => m.frame.patch.attention);
  const turn = (id: string, end: any) => {
    host.emit('event', { kind: 'turnStart', key: chatId, turnId: id });
    host.emit('event', typedTurnEnd({ kind: 'turnEnd', turnId: id, ...end }));
  };
  return { dir, host, protocol, conn, out, told, attention, turn, scope: { chatId, epoch: 1 } };
}

for (const { name, chatId, end } of FAMILIES) {
  test(`${name}: a turn that ended on an auth error is attention, not a plain failure; one that ran clears it`, async () => {
    const s = setup(chatId);
    await s.conn.call('host.hello', helloParams());
    await s.conn.call('chat.subscribe', s.scope);
    s.turn('t1', { stopReason: 'error', ...end });
    assert.deepEqual(s.attention().at(-1)?.kind, 'credential');
    assert.deepEqual(
      s.told.map((m) => [m.kind, m.chatId]),
      [['blocked', chatId]],
    );
    const pending: any = await s.conn.call('host.pending', {});
    assert.deepEqual(
      pending.attention.map((a: any) => [a.chatId, a.kind]),
      [[chatId, 'credential']],
    );
    // a second stop for the same reason does not tell again; a message is not a signed-in turn
    s.turn('t2', { stopReason: 'error', ...end });
    await s.conn.call('chat.send', { ...s.scope, key: 'key-00000001', text: 'try again' });
    assert.equal(s.told.length, 1);
    assert.equal(s.attention().at(-1)?.kind, 'credential');
    s.turn('t3', { stopReason: 'end_turn' });
    assert.equal(s.attention().at(-1), null);
  });
}

test('a lent key lost to a Host restart: the stop is still on the chat, and the first turn that runs clears it', async () => {
  const first = setup('claude:c1');
  await first.conn.call('host.hello', helloParams());
  await first.conn.call('chat.subscribe', first.scope);
  first.turn('t1', { stopReason: 'error', error: { message: 'Not signed in', code: 'auth' } });
  assert.equal(first.attention().at(-1)?.kind, 'credential');
  // a new Host process over the same data: its lane kept the stop, its engine remembers nothing
  const again = setup('claude:c1', first.dir);
  await again.conn.call('host.hello', helloParams());
  await again.conn.call('chat.subscribe', again.scope);
  const hello = again.out.find((m) => m.frame?.t === 'hello').frame;
  assert.equal(hello.chatState.attention.kind, 'credential');
  again.turn('t2', { stopReason: 'end_turn' });
  assert.equal(again.attention().at(-1), null);
});
