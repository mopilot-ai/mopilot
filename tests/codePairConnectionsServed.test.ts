// "Allow connections" off on a served Host (R2b of #5576, design §3): every client but this Mac's own app is kept out (a controller, a phone and a desktop added over SSH refused when they prove their key or pair, and their live connections closed at once), their records are kept so switching on lets them back, and this Mac's own app (its key, as the app told it, and the CLI) stays in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { codePairFor } from '../host/src/codePairWiring.mjs';
// @ts-ignore
import { helloParams } from '../shared/host/schema.mjs';
import { servedHost } from './support/hostClientsWorld.ts';
import { line } from './support/host-line.ts';

const require = createRequire(import.meta.url);
const { pairWith } = require('../electron/host/pairingClient.cjs');
const fingerprintOf = (id: any) => crypto.createHash('sha256').update(id.publicKey).digest('hex');

/** A served Host with pairing by code on, wired as the Host's process wires it (a controller record is believed without the person's proof here: that check has its own tests). */
async function hostWithSwitch(t: any) {
  const w = await servedHost(t);
  const service: any = codePairFor({
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
    pairing: { ...w.pairing, believeControllers: () => undefined },
    policy: { allowsClient: () => true },
    audit: { note: () => undefined },
    report: () => undefined,
    platform: 'darwin',
  });
  const remote = (n: string, kind: 'controller' | 'phone' | 'desktop') => {
    const id = w.identity(n);
    w.pairing.add(id.publicKey, { name: n, kind });
    return id;
  };
  return { w, service, remote };
}

test('a paired controller, phone and SSH desktop come in while connections are on, are refused at their key proof while off, and come back when on again; their records stay', async (t) => {
  const { w, service, remote } = await hostWithSwitch(t);
  const ctl = remote('other-mac', 'controller');
  const phone = remote('phone', 'phone');
  const desk = remote('ssh-desk', 'desktop');
  // never told: closed, and no client is this Mac's own app
  await assert.rejects(w.reconnect(desk), { code: 'connections_off' });
  service.connections({ open: true });
  for (const id of [ctl, phone, desk]) await w.reconnect(id);
  service.connections({ open: false, app: fingerprintOf(w.identity('this-app')) });
  for (const id of [ctl, phone, desk]) await assert.rejects(w.reconnect(id), { code: 'connections_off' });
  assert.deepEqual(
    w.pairing
      .list()
      .map((c: any) => c.kind)
      .sort(),
    ['controller', 'desktop', 'phone'],
    'kept out, not deleted',
  );
  service.connections({ open: true });
  const back = await w.reconnect(desk);
  assert.ok((await back.request('host.hello', helloParams())).features.length > 0);
});

test("switching off closes the live connections of every client but this Mac's own app; the app's own key and the CLI stay connected and served", async (t) => {
  const { w, service, remote } = await hostWithSwitch(t);
  service.connections({ open: true });
  const ctl = await w.reconnect(remote('other-mac', 'controller'));
  const phone = await w.reconnect(remote('phone', 'phone'));
  const sshDesk = await w.reconnect(remote('ssh-desk', 'desktop'));
  const app = await w.paired('this-app', 'This Mac');
  const token = fs.readFileSync(`${w.paths.socketPath}.token`, 'utf8');
  const cli = line(w.paths.socketPath, token);
  t.after(cli.close);
  await cli.request('host.hello', helloParams());
  service.connections({ open: false, app: fingerprintOf(app.id) });
  await Promise.all([ctl.closed, phone.closed, sshDesk.closed]);
  assert.ok(Array.isArray((await cli.request('host.hello', helloParams())).features), 'the CLI is served while off');
  assert.match(JSON.stringify(await cli.request('host.clients', {})), /"kind":"phone"/, 'and still lists the clients kept out');
  assert.ok(Array.isArray((await app.conn.request('host.hello', helloParams())).features), "this app's own connection stays");
  await w.reconnect(app.id);
  // a new desktop presenting the Host's own code is refused while off, and no record is made for it
  const before = w.pairing.list().length;
  const fresh = line(w.paths.socketPath);
  t.after(fresh.close);
  await assert.rejects(pairWith(fresh.request, w.identity('new-desk'), w.pairing.issueCode(), 'New'), { code: 'connections_off' });
  assert.equal(w.pairing.list().length, before);
});
