// A hello must not wait on the sign-in probes a status runs (#5177): the app's reconnect and every first send wait on the hello, so a slow probe held the whole send path.
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
import { hostCapabilities } from '../host/src/status.mjs';
// @ts-ignore
import { helloParams } from '../shared/host/schema.mjs';

const quiet = { report: () => undefined };

function protocolWith(extra: object) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-hello-'));
  const runtime: any = { host: new EventEmitter(), send: async () => ({ turnId: 't' }) };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  return createProtocol({ runtime, epochs, guard, ...extra }).connection(() => undefined);
}

test('a Host that knows its capabilities answers the hello while its status (the sign-in probes) is still out', async () => {
  let asked = 0;
  const conn = protocolWith({
    status: () => (asked++, new Promise(() => undefined)),
    capabilities: () => hostCapabilities({ browser: true }),
  });
  const answer = await conn.call('host.hello', helloParams());
  assert.deepEqual(answer.capabilities, { iab: true, cu: false, desktop: false, bu: false, shell: false });
  assert.equal(asked, 0, 'the hello did not ask for a status');
});

test('without a capabilities reader the hello still reads them from the status', async () => {
  const conn = protocolWith({ status: () => ({ running: true, capabilities: { shell: true } }) });
  const answer = await conn.call('host.hello', helloParams());
  assert.equal(answer.capabilities.shell, true);
});
