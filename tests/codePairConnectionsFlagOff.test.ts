// "Allow connections" is inert on a Host without pairing by code (as shipped, no MOPILOT_HOST_CODE_PAIR; host/src/codePairWiring.mjs returns before it installs the rule on the pairing): a Host upgraded from the current release, never told anything, pairs and serves a phone and a second desktop with no connections.json or with a leftover one that says closed; the same Host with the flag on refuses both, so the flag is what decides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { codePairFor } from '../host/src/codePairWiring.mjs';
// @ts-ignore
import { helloParams } from '../shared/host/schema.mjs';
import { servedHost } from './support/hostClientsWorld.ts';
import { line } from './support/host-line.ts';

const require = createRequire(import.meta.url);
const { pairWith } = require('../electron/host/pairingClient.cjs');

/** A served Host wired as the Host's process wires pairing by code, with `env` as its environment and `leftover` as connections.json (none when undefined). */
async function host(t: any, env: Record<string, string>, leftover?: object) {
  const w = await servedHost(t);
  if (leftover) {
    fs.mkdirSync(w.paths.configDir, { recursive: true });
    fs.writeFileSync(path.join(w.paths.configDir, 'connections.json'), JSON.stringify(leftover), { mode: 0o600 });
  }
  const service = codePairFor({
    env,
    paths: w.paths,
    relayLinks: {
      enroll: () => ({}),
      forget: () => undefined,
      retire: () => undefined,
      retireLive: () => undefined,
      onTombstone: () => undefined,
      close: () => undefined,
    },
    pairing: { ...w.pairing, believeControllers: () => undefined },
    policy: { allowsClient: () => true },
    audit: { note: () => undefined },
    report: () => undefined,
    platform: 'darwin',
  });
  return { w, service };
}

/** A phone (registered as the app registers one, then paired with the Host's code) and a second desktop (paired with the code): each pairs (host.pair), proves its key on a new connection (host.auth) and is served a request (host.status). */
async function phoneAndDesktop(w: any) {
  const phone = w.identity('phone');
  w.pairing.add(phone.publicKey, { name: 'Phone', kind: 'phone' });
  const results: string[] = [];
  for (const [id, name] of [
    [phone, 'Phone'],
    [w.identity('second-desk'), 'Second Mac'],
  ] as const) {
    const first = line(w.paths.socketPath);
    try {
      await pairWith(first.request, id, w.pairing.issueCode(), name);
    } finally {
      first.close();
    }
    const conn = await w.reconnect(id);
    const status = await conn.request('host.status', {});
    results.push(`${name}: ${status.running === true ? 'served' : 'not served'}`);
  }
  assert.deepEqual(
    w.pairing
      .list()
      .map((c: any) => c.kind)
      .sort(),
    ['desktop', 'phone'],
  );
  return results;
}

test('flag off, never told, no connections.json: the rule is not installed, and a phone and a second desktop pair, prove their key and are served', async (t) => {
  const { w, service } = await host(t, {});
  assert.equal(service, undefined, 'no pairing by code, no switch');
  assert.equal(fs.existsSync(path.join(w.paths.configDir, 'connections.json')), false);
  assert.deepEqual(await phoneAndDesktop(w), ['Phone: served', 'Second Mac: served']);
  assert.ok((await (await w.reconnect(w.identity('phone'))).request('host.hello', helloParams())).features.length > 0);
});

test('flag off with a leftover connections.json that says closed: it is ignored, and the phone and the second desktop are served', async (t) => {
  const { w, service } = await host(t, {}, { open: false, app: '' });
  assert.equal(service, undefined);
  assert.deepEqual(await phoneAndDesktop(w), ['Phone: served', 'Second Mac: served']);
});

test('the same Host with the flag on refuses them (closed and never told), so the flag is what keeps the rule out', async (t) => {
  for (const leftover of [undefined, { open: false, app: '' }]) {
    const { w, service } = await host(t, { MOPILOT_HOST_CODE_PAIR: '1' }, leftover);
    assert.ok(service, 'pairing by code is on');
    await assert.rejects(phoneAndDesktop(w), { code: 'connections_off' }, JSON.stringify(leftover));
  }
});
