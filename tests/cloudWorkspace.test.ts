// The workspace on a cloud machine (C3): size and region come from the adapter at creation; Limited is offered only where the adapter can apply it, with the reason otherwise; the choice is recorded with the machine and passed to the provider; a launch never deletes another machine by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DEFAULT_WHY, createFakeProvider, whyOff } from '../shared/cloud/adapter.mjs';
import { createOciAdapter } from '../shared/cloud/oci.mjs';

const require = createRequire(import.meta.url);
const { createCloudLauncher } = require('../electron/host/cloudLauncher.cjs');
const { createCloudKeys } = require('../electron/host/cloudKeys.cjs');
const safe = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(s),
  decryptString: (b: Buffer) => b.toString(),
};

function setup(flags: Record<string, boolean> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-ws-'));
  const keys = createCloudKeys({ file: path.join(home, 'k.json'), safeStorage: safe });
  keys.set('fake', { a: 1 });
  const provider = createFakeProvider({ flags });
  const allowed: any[] = [];
  let onView: any;
  const launcher = createCloudLauncher({
    file: path.join(home, 'i.json'),
    keys,
    makeAdapter: () => provider,
    makeBoot: (o: any) => (
      (onView = o.onView),
      {
        start: async () => ({ state: 'waiting', command: 'JOIN' }),
        allow: (x: any) => (allowed.push(x), { id: 'relay:h' }),
        deny: () => undefined,
      }
    ),
    sleep: () => new Promise((r) => setImmediate(r)),
  });
  const original = provider.create.bind(provider);
  provider.create = async (spec: any) =>
    ((m) => (provider.set(m.id, 'running'), setTimeout(() => onView({ state: 'asking' }), 5), m))(await original(spec));
  return { provider, launcher, allowed };
}
const spec = { launch: 'l_abcdef123', provider: 'fake', name: 'dev-cloud', size: 'small', region: 'r1' };

test('Limited is refused where the adapter has no firewall, with the reason, and nothing is made', async () => {
  const s = setup();
  await assert.rejects(
    s.launcher.launch({ ...spec, network: 'limited' }),
    (e: any) => e.code === 'network_unavailable' && /no firewall/.test(e.message),
  );
  assert.equal(s.provider.machines.size, 0);
  assert.equal(
    s.provider.calls.some((c) => c.call === 'create'),
    false,
  );
});

test('Limited is passed to the provider and recorded with the machine where the adapter can apply it', async () => {
  const s = setup({ limitedNetwork: true });
  await s.launcher.launch({ ...spec, network: 'limited' });
  assert.equal(s.provider.machines.get('fake-1')?.network, 'limited');
  assert.equal(s.allowed[0].cloud.network, 'limited');
  assert.equal(s.allowed[0].cloud.size, 'small');
  const t = setup({ limitedNetwork: true });
  await t.launcher.launch(spec);
  assert.equal(t.provider.machines.get('fake-1')?.network, 'full');
});

test('a size or a region the adapter does not offer is refused before anything is made', async () => {
  const s = setup();
  await assert.rejects(s.launcher.launch({ ...spec, size: 'huge' }), /size is not offered/);
  await assert.rejects(s.launcher.launch({ ...spec, region: 'nowhere' }), /region is not offered/);
  assert.equal(
    s.provider.calls.some((c) => c.call === 'create'),
    false,
  );
  // the launch is not left marked as running
  await assert.rejects(s.launcher.launch({ ...spec, size: 'huge' }), (e: any) => e.code === 'invalid');
});

test('options give each disabled control its reason; the machine is named for the provider with its own suffix', async () => {
  const s = setup({ resume: false, publicPrice: false });
  const o = await s.launcher.options('fake', 'r1');
  assert.equal(o.reasons.resume, DEFAULT_WHY.resume);
  assert.equal(o.reasons.publicPrice, DEFAULT_WHY.publicPrice);
  assert.equal(o.reasons.limitedNetwork, DEFAULT_WHY.limitedNetwork);
  assert.equal('selfStop' in o.reasons, false);
  await s.launcher.launch(spec);
  assert.equal(s.provider.machines.get('fake-1')?.name, 'dev-cloud-abcdef');
});

test('a launch that fails before create does not delete a machine that has the same name', async () => {
  const s = setup();
  await s.provider.create({ name: 'dev-cloud-abcdef', size: 's', region: 'r1', command: 'c' });
  s.provider.failNext('sizes', new Error('down'));
  await assert.rejects(s.launcher.launch(spec), /down/);
  assert.equal(s.provider.machines.size, 1);
  assert.equal(
    s.provider.calls.some((c) => c.call === 'destroy'),
    false,
  );
});

test('whyOff answers only for a flag that is off, and an adapter may give its own words', () => {
  assert.equal(whyOff(createFakeProvider(), 'resume'), null);
  assert.equal(whyOff(createFakeProvider(), 'limitedNetwork'), DEFAULT_WHY.limitedNetwork);
  assert.equal(whyOff({ flags: { x: false }, why: {} }, 'x'), 'Not available here.');
  assert.equal(whyOff({ flags: { x: false }, why: { x: 'because' } }, 'x'), 'because');
  assert.equal(whyOff(null, 'x'), null);
  const oci = createOciAdapter({
    config: { tenancy: 't', user: 'u', fingerprint: 'f', region: 'r', compartmentId: 'c', subnetId: 's' },
    fetch: (() => {}) as any,
    sign: () => 's',
  });
  assert.match(whyOff(oci, 'limitedNetwork')!, /security lists filter by address/);
});
