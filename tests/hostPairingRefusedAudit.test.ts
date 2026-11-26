// A client that "Allow connections" keeps out is on the Host's audit record (#5744, host/src/pairing.mjs): its refused proof (`host.auth`) and its refused code pairing (`host.pair`) are each a `client.refused` line, one a minute per client and method, the rest counted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createPairing } from '../host/src/pairing.mjs';
import { keySafe } from './support/hostKeySafe.ts';
const require = createRequire(import.meta.url);
const { loadIdentity, pairWith, authenticate } = require('../electron/host/pairingClient.cjs');

function world(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairing-refused-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lines: any[] = [];
  const host = createPairing({ configDir: path.join(dir, 'host'), audit: (e: any) => void lines.push(e) });
  const identity = (name = 'app') => loadIdentity(path.join(dir, `${name}.json`), keySafe);
  const request = async (method: string, params: any = {}) => {
    if (method === 'host.challenge') return { nonce: host.challenge(), hostId: host.hostId() };
    if (method === 'host.pair') return host.claim(params);
    if (method === 'host.auth') return host.verify(params);
    throw new Error('no such method');
  };
  return { host, identity, request, lines };
}
const refused = (lines: any[]) => lines.filter((l) => l.kind === 'client.refused');

test('#5744: a paired client whose proof is refused by Allow connections off is one audit line, not one per try; on again lets it in with no line', async (t) => {
  const w = world(t);
  const app = w.identity();
  await pairWith(w.request, app, w.host.issueCode(), 'Studio');
  w.lines.length = 0;
  let open = false;
  w.host.admitClients(() => open);
  for (let i = 0; i < 3; i++) await assert.rejects(authenticate(w.request, app), (e: any) => e.code === 'connections_off');
  const [line, ...rest] = refused(w.lines);
  assert.equal(line.by.name, 'Studio');
  assert.equal(line.by.kind, 'desktop');
  assert.equal(typeof line.by.fingerprint, 'string');
  assert.deepEqual(line.what, { tool: 'host.auth' });
  assert.deepEqual(rest, [], 'the same refusal again in the minute is counted, not written');
  open = true;
  const before = w.lines.length;
  await authenticate(w.request, app);
  assert.equal(refused(w.lines.slice(before)).length, 0, 'an accepted proof writes no refusal');
});

test('#5744: a code pairing that Allow connections off keeps out is on the record as a refused host.pair; nothing is enrolled', async (t) => {
  const w = world(t);
  w.host.admitClients(() => false);
  const app = w.identity('new');
  await assert.rejects(pairWith(w.request, app, w.host.issueCode(), 'Laptop'), (e: any) => e.code === 'connections_off');
  const [line] = refused(w.lines);
  assert.equal(line.by.name, 'Laptop');
  assert.deepEqual(line.what, { tool: 'host.pair' });
  assert.equal(w.host.paired(), 0);
});

test('#5744: a client the Host does not know is refused with no line (no paired identity to put on the record)', async (t) => {
  const w = world(t);
  await assert.rejects(authenticate(w.request, w.identity('stranger')), (e: any) => e.code === 'unknown_client');
  assert.deepEqual(refused(w.lines), []);
});
