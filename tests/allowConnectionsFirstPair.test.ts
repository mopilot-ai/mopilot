// This app's first pairing with a brand-new local Host (electron/host/machines.cjs `pair`, electron/host/allowConnections.cjs `beforePair`): with pairing by code on, a Host never told keeps every client out, so the app tells it the switch and its own key over the CLI connection before it pairs, and the first pairing succeeds the first time, switch off included; without that telling the Host refuses it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { codePairFor } from '../host/src/codePairWiring.mjs';
import { servedHost } from './support/hostClientsWorld.ts';
import { keySafe } from './support/hostKeySafe.ts';

const require = createRequire(import.meta.url);
const { createMachines } = require('../electron/host/machines.cjs');
const { createRegistry } = require('../electron/host/registry.cjs');
const { createAllowConnections } = require('../electron/host/allowConnections.cjs');
const LOCAL = 'this-mac-host';

/** A brand-new local Host with pairing by code on (never told anything), and this app's machines service with it in the list as installed, not yet paired. */
async function freshLocalHost(t: any, tellFirst: boolean) {
  // the protocol serves the service the process builds on this Host's own pairing (made inside the served Host, so bound late)
  const late: { service?: any } = {};
  const w = await servedHost(t, { codePair: new Proxy({}, { get: (_t, k) => late.service[k] }) });
  late.service = codePairFor({
    env: { MOPILOT_HOST_CODE_PAIR: '1' },
    paths: w.paths,
    relayLinks: {
      enroll: () => ({}),
      forget: () => undefined,
      retire: () => undefined,
      retireLive: () => undefined,
      onTombstone: () => undefined,
      close: () => undefined,
    },
    pairing: w.pairing,
    policy: { allowsClient: () => true },
    audit: { note: () => undefined },
    report: () => undefined,
    platform: 'darwin',
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'first-pair-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const registry = createRegistry({ file: path.join(dir, 'r.json'), status: async () => ({ harnesses: [], capabilities: {} }) });
  registry.add({ id: LOCAL, name: 'This Mac', address: `local:${os.userInfo().username}`, socketPath: w.paths.socketPath });
  const reported: unknown[] = [];
  let m: any;
  const allow = createAllowConnections({
    machines: () => m,
    consent: () => ({ enabled: () => false, onChange: () => () => undefined }),
    report: (e: unknown) => void reported.push(e),
  });
  m = createMachines({
    safeStorage: keySafe,
    dir,
    allowed: () => true,
    watch: () => undefined,
    registry,
    installer: {},
    ...(tellFirst ? { beforeLocalPair: (socket: string) => allow.beforePair(socket) } : {}),
  });
  t.after(() => m.dispose());
  return { w, m, reported };
}

test('the app tells its brand-new local Host its key before pairing: the first pairing succeeds the first time, with the switch off', async (t) => {
  const { w, m, reported } = await freshLocalHost(t, true);
  await m.pair(LOCAL, w.pairing.issueCode());
  assert.deepEqual(reported, []);
  const mine = w.pairing.list().find((c: any) => c.fingerprint === m.selfFingerprint());
  assert.equal(mine?.kind, 'desktop', "this app's own key is paired");
  const kept = JSON.parse(fs.readFileSync(path.join(w.paths.configDir, 'connections.json'), 'utf8'));
  assert.deepEqual(kept, { open: false, app: m.selfFingerprint() });
});

test('without that telling the never-told Host refuses the first pairing and no record is made', async (t) => {
  const { w, m } = await freshLocalHost(t, false);
  await assert.rejects(m.pair(LOCAL, w.pairing.issueCode()), { code: 'connections_off' });
  assert.deepEqual(w.pairing.list(), []);
});
