// Reset pairing approval on a served Host (host.codePair.resetApproval, #5576): a controller that is connected when the reset runs is closed at once, not at its next request; other clients stay connected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { codePairFor } from '../host/src/codePairWiring.mjs';
// @ts-ignore
import { helloParams } from '../shared/host/schema.mjs';
import { servedHost } from './support/hostClientsWorld.ts';

test('a reset closes the live connection of every controller at once; a phone stays connected and served', async (t) => {
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
    // a controller record is believed without the person's proof here: that check has its own tests
    pairing: { ...w.pairing, believeControllers: () => undefined },
    policy: { allowsClient: () => true },
    audit: { note: () => undefined },
    report: () => undefined,
    platform: 'darwin',
  });
  service.connections({ open: true });
  const remote = (n: string, kind: 'controller' | 'phone') => {
    const id = w.identity(n);
    w.pairing.add(id.publicKey, { name: n, kind });
    return id;
  };
  const ctl = await w.reconnect(remote('other-mac', 'controller'));
  const phone = await w.reconnect(remote('phone', 'phone'));
  assert.deepEqual(service.resetApproval(), { reset: true, controllers: 1 });
  await ctl.closed;
  assert.ok((await phone.request('host.hello', helloParams())).features.length > 0, 'the phone is still served');
});

test('a key reset that fails after the controllers went still closes their live connections at once', async (t) => {
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
  service.connections({ open: true });
  const id = w.identity('other-mac');
  w.pairing.add(id.publicKey, { name: 'other-mac', kind: 'controller' });
  const ctl = await w.reconnect(id);
  // the approval key cannot be removed: a folder stands where the key file would be
  const fs = await import('node:fs');
  const path = await import('node:path');
  fs.mkdirSync(path.join(w.paths.configDir, 'approval-key.json', 'blocker'), { recursive: true });
  assert.throws(() => service.resetApproval(), { code: 'reset_incomplete' });
  await ctl.closed;
});
