// The cloud machines service (X6): refused while host.cloud is off; the key is validated, kept encrypted and never returned; the sheet's calls reach the provider through a signed OCI request; the machine line follows wake, asleep, stopping and gone; Stop now and Delete work through the provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCloudService, PROVIDERS, ociSigner } = require('../electron/host/cloudService.cjs');

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const safe = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(s),
  decryptString: (b: Buffer) => b.toString(),
};
const credential = {
  tenancy: 't',
  user: 'u',
  fingerprint: 'f',
  region: 'us-ashburn-1',
  compartmentId: 'c',
  subnetId: 's',
  privateKeyPem: PEM,
};
const ID = 'ocid1.instance.oc1..m';

function setup(over: { on?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-svc-'));
  const flag = { on: over.on ?? true };
  const rows: any[] = [{ id: 'relay:h1', status: 'offline', cloud: { provider: 'oci', id: ID, region: 'us-ashburn-1' } }];
  const events: any[] = [];
  const requests: { method: string; url: string; auth: string }[] = [];
  const answers: Array<[number, unknown]> = [];
  const doFetch = async (url: string, init: any) => {
    requests.push({ method: init.method, url, auth: init.headers.authorization });
    const [status, body] = answers.shift() ?? [200, null];
    return { ok: status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) };
  };
  let arrive: (v: any) => void = () => undefined;
  const carried: string[] = [];
  const svc = createCloudService({
    dir,
    safeStorage: safe,
    enabled: () => flag.on,
    registry: { list: () => rows },
    makeBoot: ({ onView }: any) => (
      (arrive = onView),
      { start: async () => ({ state: 'waiting', command: 'JOIN' }), allow: () => ({ id: 'relay:new' }), deny: () => undefined }
    ),
    chatsOn: () => [{ chatId: 'c1', title: 'Fix', folder: null }],
    carry: async (_h: string, c: string) => void carried.push(c),
    check: () => undefined,
    onEvent: (e: any) => events.push(e),
    fetch: doFetch as any,
    sleep: () => new Promise((r) => setImmediate(r)),
  });
  return { svc, flag, rows, events, requests, answers, dir, arrive: (v: any) => arrive(v), carried };
}

test('while host.cloud is off every call is refused and no provider is called', async () => {
  const s = setup({ on: false });
  for (const call of [
    () => s.svc.providers(),
    () => s.svc.setKey('oci', {}),
    () => s.svc.removeKey('oci'),
    () => s.svc.check('oci'),
    () => s.svc.options('oci'),
    () => s.svc.launch({}),
    () => s.svc.stopNow('relay:h1'),
    () => s.svc.plan('relay:h1'),
    () => s.svc.remove('relay:h1', {}),
  ])
    await assert.rejects(Promise.resolve().then(call), (e: any) => e.code === 'not_enabled');
  assert.deepEqual(await s.svc.wake('relay:h1'), { state: 'off' });
  assert.equal(await s.svc.recover(), 0);
  assert.equal(await s.svc.refresh('relay:h1'), 'off');
  assert.equal(s.svc.line('relay:h1'), null);
  assert.equal(s.requests.length, 0);
});

test('the key is validated, kept encrypted, never returned, and replaced or forgotten', () => {
  const s = setup();
  assert.deepEqual(s.svc.providers(), [{ id: 'oci', label: 'Oracle Cloud', fields: PROVIDERS[0].fields, hasKey: false }]);
  assert.throws(() => s.svc.setKey('aws', credential), /not known/);
  assert.throws(() => s.svc.setKey('oci', null), /missing/);
  assert.throws(() => s.svc.setKey('oci', { ...credential, subnetId: ' ' }), /subnetId is missing/);
  assert.throws(() => s.svc.setKey('oci', { ...credential, privateKeyPem: 'not a key' }), /not a PEM key/);
  assert.throws(() => s.svc.setKey('oci', { ...credential, privateKeyPem: 5 }), /not a PEM key/);
  assert.deepEqual(s.svc.setKey('oci', { ...credential, extra: 'dropped' }), { ok: true });
  assert.equal(s.svc.providers()[0].hasKey, true);
  const file = fs.readFileSync(path.join(s.dir, 'host-cloud-keys.json'), 'utf8');
  assert.equal(file.includes('PRIVATE KEY'), false);
  assert.equal(file.includes('dropped'), false);
  assert.equal(JSON.stringify(s.svc.providers()).includes('PRIVATE'), false);
  assert.equal(s.svc.removeKey('oci'), true);
  assert.equal(s.svc.removeKey('oci'), false);
});

test('the signer signs with the key it was given, and nothing else', () => {
  const sign = ociSigner(PEM);
  const signature = sign('text');
  const pub = crypto.createPublicKey(PEM);
  assert.equal(crypto.createVerify('RSA-SHA256').update('text').verify(pub, signature, 'base64'), true);
});

test('check and options go to the provider as signed requests; no key means no call; an unknown provider is refused', async () => {
  const s = setup();
  await assert.rejects(s.svc.options('oci'), (e: any) => e.code === 'no_key');
  s.svc.setKey('oci', credential);
  s.answers.push([200, [{ name: 'us-ashburn-1' }]]);
  assert.deepEqual(await s.svc.check('oci'), { ok: true });
  assert.match(s.requests[0].auth, /^Signature version="1",keyId="t\/u\/f"/);
  s.answers.push([401, { code: 'NotAuthenticated' }]);
  assert.deepEqual(await s.svc.check('oci', 'eu-frankfurt-1'), { ok: false, code: 'refused', message: 'That key was refused.' });
  assert.match(s.requests[1].url, /identity\.eu-frankfurt-1\./);
  s.answers.push([200, [{ name: 'us-ashburn-1' }]]);
  const o = await s.svc.options('oci');
  assert.equal(o.sizes.length, 4);
  assert.equal(o.regions[0].id, 'us-ashburn-1');
  assert.equal(o.flags.limitedNetwork, false);
  assert.match(o.reasons.limitedNetwork, /security lists/);
  assert.equal((await s.svc.check('aws')).code, 'no_key');
});

test('a launch creates the machine at the provider, follows its steps and returns the new row', async () => {
  const s = setup();
  s.svc.setKey('oci', credential);
  const answers: Array<[number, unknown]> = [
    [200, [{ name: 'us-ashburn-1' }]],
    [200, [{ name: 'AD-1' }]],
    [200, [{ id: 'img' }]],
    [200, { id: ID }],
    [200, { lifecycleState: 'PROVISIONING' }],
    [200, { lifecycleState: 'RUNNING' }],
    [200, { lifecycleState: 'RUNNING' }],
  ];
  s.answers.push(...answers);
  const run = s.svc.launch({ provider: 'oci', name: 'dev-cloud', size: 'VM.Standard.A1.Flex:1:6', region: 'us-ashburn-1' });
  await new Promise((r) => setTimeout(r, 50));
  s.arrive({ state: 'asking' });
  assert.deepEqual(await run, { id: 'relay:new', providerId: ID });
  assert.equal(s.events[0].kind, 'launch');
  assert.deepEqual(
    s.events.filter((e) => e.kind === 'step' && e.state === 'done').map((e) => e.step),
    ['create', 'start', 'connect', 'pair'],
  );
  assert.equal(s.svc.cancel('l_nothing'), false);
});

test('the line follows asleep, waking, stopping and gone, and a client without the key cannot wake', async () => {
  const s = setup();
  assert.equal(s.svc.line('relay:none'), null);
  assert.equal(s.svc.line('relay:h1'), null);
  s.svc.setKey('oci', credential);
  s.answers.push([200, { lifecycleState: 'STOPPED' }]);
  assert.equal(await s.svc.refresh('relay:h1'), 'alive');
  assert.deepEqual(s.svc.line('relay:h1'), { line: 'Asleep · wakes on next message', dot: 'off', action: 'Wake' });
  s.svc.removeKey('oci');
  assert.equal(s.svc.line('relay:h1')?.line, 'Asleep · wake it from your Mac');
  s.svc.setKey('oci', credential);
  // wake: resume, then the Host dials out
  s.answers.push(
    [200, { lifecycleState: 'STOPPED' }],
    [200, {}],
    [200, { lifecycleState: 'RUNNING' }],
    [200, { lifecycleState: 'RUNNING' }],
  );
  const waking = s.svc.wake('relay:h1');
  await new Promise((r) => setImmediate(r));
  assert.equal(s.svc.line('relay:h1')?.line, 'Waking…');
  s.rows[0].status = 'online';
  assert.deepEqual(await waking, { state: 'online' });
  assert.equal(s.svc.line('relay:h1'), null);
  // the Host says it is stopping (status.cloud.stopping, kept on the row by the registry)
  s.rows[0].status = 'online';
  s.rows[0].cloudState = { idleMinutes: 30, stopping: true, hoursToday: 1 };
  assert.deepEqual(s.svc.line('relay:h1'), { line: 'Stopping · idle', dot: 'warn', action: null, idle: 'Stops when idle · 30 min' });
  // online and not stopping: no cloud state applies, and the line says how long it may idle (the Host's own word, else the record's)
  s.rows[0].cloudState = { idleMinutes: 120, stopping: false, hoursToday: 1 };
  assert.deepEqual(s.svc.line('relay:h1'), { line: '', dot: 'off', action: null, idle: 'Stops when idle · 2 h' });
  s.rows[0].cloudState = null;
  s.rows[0].cloud.idleMinutes = 45;
  assert.equal(s.svc.line('relay:h1')?.idle, 'Stops when idle · 45 min');
  delete s.rows[0].cloud.idleMinutes;
  s.rows[0].status = 'offline';
  // gone at the provider
  s.answers.length = 0;
  s.answers.push([404, {}]);
  assert.equal(await s.svc.refresh('relay:h1'), 'gone');
  assert.equal(s.svc.line('relay:h1')?.line, 'Deleted at the provider');
  s.answers.push([404, {}]);
  assert.equal(await s.svc.lostCheck('relay:h1'), null);
  assert.ok(s.events.some((e) => e.kind === 'gone'));
});

test('recover asks the provider about each cloud machine; Stop now and Delete go through the provider', async () => {
  const s = setup();
  s.svc.setKey('oci', credential);
  s.rows.push({ id: 'ssh:box', status: 'online', cloud: null });
  s.answers.push([200, { lifecycleState: 'RUNNING' }]);
  assert.equal(await s.svc.recover(), 0);
  assert.equal(s.requests.length, 1);
  s.answers.push([200, {}]);
  assert.deepEqual(await s.svc.stopNow('relay:h1'), { ok: true });
  assert.match(s.requests.at(-1)!.url, /action=SOFTSTOP$/);
  await assert.rejects(s.svc.stopNow('ssh:box'), (e: any) => e.code === 'not_cloud');
  const plan = s.svc.plan('relay:h1');
  assert.equal(plan.chats[0].chatId, 'c1');
  s.answers.push([204, undefined]);
  assert.deepEqual(await s.svc.remove('relay:h1', { token: plan.token, carry: ['c1'] }), { deleted: true });
  assert.deepEqual(s.carried, ['c1']);
  assert.equal(s.requests.at(-1)!.method, 'DELETE');
});

test('without a key a cloud machine cannot be stopped or woken, and a key stored for another provider is refused by name', async () => {
  const s = setup();
  await assert.rejects(s.svc.stopNow('relay:h1'), (e: any) => e.code === 'no_key');
  assert.deepEqual(await s.svc.wake('relay:h1'), { state: 'failed', reason: 'Add this provider’s key first.' });
  assert.equal(s.requests.length, 0);
  // a keys file that holds a key for a provider this build does not know
  const stray = JSON.stringify({ keys: { aws: Buffer.from(JSON.stringify({ a: 1 })).toString('base64') } });
  fs.writeFileSync(path.join(s.dir, 'host-cloud-keys.json'), stray);
  assert.deepEqual(await s.svc.check('aws'), { ok: false, code: 'invalid', message: 'That provider is not known.' });
});

test('a service made with no event listener still works', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-svc-'));
  const svc = createCloudService({
    dir,
    safeStorage: safe,
    enabled: () => true,
    registry: { list: () => [] },
    makeBoot: () => ({}),
    chatsOn: () => [],
  });
  assert.equal(svc.line('relay:h1'), null);
});
