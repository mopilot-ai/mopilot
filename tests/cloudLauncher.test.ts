// The cloud launcher (C1): create → start → connect → pair against the fake provider; the join is allowed only for the machine it made; a failed or cancelled creation, a slow or half-made one, and an app that quit mid-way leave nothing running; the key and cloud records.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CloudError, createFakeProvider } from '../shared/cloud/adapter.mjs';
import { useFakeClock } from './support/ports/clock.ts';

const require = createRequire(import.meta.url);
const { createCloudLauncher } = require('../electron/host/cloudLauncher.cjs');
const { createCloudKeys } = require('../electron/host/cloudKeys.cjs');
const { cloudOf } = require('../electron/host/cloudRecord.cjs');
const { newLaunchId } = require('../electron/host/cloudLauncher.cjs');
const { createRegistry } = require('../electron/host/registry.cjs');

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-launcher-'));
const safe = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`enc:${s}`),
  decryptString: (b: Buffer) => b.toString().replace(/^enc:/, ''),
};

/** A boot standing in for one machine's command: `arrive()` is the machine's hello reaching the relay. */
function fakeBoot(over: Record<string, any> = {}) {
  const boot: any = { allowed: [] as any[], denied: 0 };
  boot.make = ({ onView }: any) => {
    boot.onView = onView;
    return {
      start: async () => over.start ?? { state: 'waiting', command: 'JOIN-COMMAND' },
      view: () => ({}),
      allow: (extra: any) => (boot.allowed.push(extra), { id: 'relay:h1' }),
      deny: () => void boot.denied++,
    };
  };
  boot.arrive = (state = 'asking') => boot.onView({ state });
  return boot;
}

function setup(over: { provider?: any; boot?: any; key?: any; sleep?: any } = {}) {
  const home = dir();
  const keys = createCloudKeys({
    file: path.join(home, 'keys.json'),
    safeStorage: safe,
  });
  if (over.key !== null) keys.set('fake', over.key ?? { secret: 'PRIVATE-KEY-MATERIAL' });
  const boot = over.boot ?? fakeBoot();
  const provider = over.provider ?? createFakeProvider({ boot: () => undefined, flags: { limitedNetwork: true } });
  const steps: any[] = [];
  const launcher = createCloudLauncher({
    file: path.join(home, 'intents.json'),
    keys,
    makeAdapter: (_p: string, _c: any, _r: string) => provider,
    makeBoot: boot.make,
    onStep: (s: any) => steps.push(s),
    sleep: over.sleep ?? (async () => provider.set(`${provider.id}-1`, 'running')),
  });
  return { home, keys, boot, provider, launcher, steps };
}
const spec = {
  launch: 'l1',
  provider: 'fake',
  name: 'dev-cloud',
  size: 'small',
  region: 'r1',
};
const intents = (home: string) => JSON.parse(fs.readFileSync(path.join(home, 'intents.json'), 'utf8')).intents;

test('a launch mints the command, creates the machine with it, waits for it, and allows its join with the cloud record', async () => {
  const s = setup();
  // the machine runs its command, then says hello
  const original = s.provider.create.bind(s.provider);
  s.provider.create = async (spec: any) => {
    const made = await original(spec);
    s.provider.set(made.id, 'running');
    setTimeout(() => s.boot.arrive(), 5);
    return made;
  };
  const out = await s.launcher.launch({ ...spec, network: 'limited', idleMinutes: 45, hoursPerDay: 6 });
  assert.deepEqual(out, { id: 'relay:h1', providerId: 'fake-1' });
  assert.equal(s.provider.calls.find((c: any) => c.call === 'create').args[0].command, 'JOIN-COMMAND');
  assert.deepEqual(s.boot.allowed, [
    {
      name: 'dev-cloud',
      cloud: {
        provider: 'fake',
        id: 'fake-1',
        region: 'r1',
        size: 'small',
        network: 'limited',
        idleMinutes: 45,
        hoursPerDay: 6,
      },
    },
  ]);
  assert.deepEqual(
    s.steps.filter((x) => x.state === 'done').map((x) => x.step),
    ['create', 'start', 'connect', 'pair'],
  );
  assert.equal(fs.existsSync(path.join(s.home, 'intents.json')) ? intents(s.home).length : 0, 0);
  assert.equal(s.boot.denied, 0);
  // the default network is Full
  const t = setup();
  const again = t.provider.create.bind(t.provider);
  t.provider.create = async (sp: any) => ((m) => (t.provider.set(m.id, 'running'), t.boot.arrive(), m))(await again(sp));
  await t.launcher.launch(spec);
  assert.equal(t.boot.allowed[0].cloud.network, 'full');
});

test('without a key, with a broken adapter, or a second launch of the same id: refused before anything is made', async () => {
  const none = setup({ key: null });
  await assert.rejects(none.launcher.launch(spec), (e: any) => e.code === 'no_key');
  assert.equal(none.launcher.hasKey('fake'), false);
  const broken = setup();
  const l = createCloudLauncher({
    file: path.join(broken.home, 'i.json'),
    keys: broken.keys,
    makeAdapter: () => ({}),
    makeBoot: broken.boot.make,
  });
  await assert.rejects(l.launch(spec), (e: any) => e.code === 'invalid');
  assert.deepEqual(broken.provider.calls, []);
  const busy = setup();
  const first = busy.launcher.launch(spec).catch((e: any) => e);
  await assert.rejects(busy.launcher.launch(spec), (e: any) => e.code === 'busy');
  busy.launcher.cancel('l1');
  assert.equal((await first).code, 'cancelled');
});

test('a relay that cannot be reached fails before any machine is made', async () => {
  const s = setup({
    boot: fakeBoot({
      start: { state: 'failed', command: '', error: 'No relay.' },
    }),
  });
  await assert.rejects(s.launcher.launch(spec), /No relay/);
  const t = setup({
    boot: fakeBoot({ start: { state: 'failed', command: '' } }),
  });
  await assert.rejects(t.launcher.launch(spec), /could not reach its relay/);
  assert.equal(
    s.provider.calls.some((c: any) => c.call === 'create'),
    false,
  );
  assert.equal(s.boot.denied, 1);
});

test('a create that fails deletes anything made under its name, even when the answer was lost', async () => {
  const s = setup();
  // the provider made it, then the answer was lost
  const original = s.provider.create.bind(s.provider);
  s.provider.create = async (sp: any) => {
    await original(sp);
    throw new CloudError('failed', 'The provider is not answering.', {
      retryable: true,
    });
  };
  await assert.rejects(s.launcher.launch(spec), /not answering/);
  assert.equal(s.provider.machines.size, 0);
  assert.deepEqual(s.steps.at(-1), {
    launch: 'l1',
    step: 'create',
    state: 'failed',
    error: 'The provider is not answering.',
  });
  assert.equal(intents(s.home).length, 0);
  // an error without a message still has words
  const t = setup();
  t.provider.failNext('create', 'plain');
  await assert.rejects(t.launcher.launch(spec));
  assert.equal(t.steps.at(-1).error, 'The provider could not do that.');
});

test('capacity, a refused key and a half-made machine all end with nothing running', async () => {
  const s = setup();
  s.provider.failNext('create', new CloudError('capacity', 'No capacity for that size here.'));
  await assert.rejects(s.launcher.launch(spec), (e: any) => e.code === 'capacity');
  assert.equal(s.provider.machines.size, 0);
  // the machine is made, then the provider deletes it before it boots
  const t = setup({ sleep: async () => t.provider.set('fake-1', 'gone') });
  await assert.rejects(t.launcher.launch(spec), (e: any) => e.code === 'gone');
  assert.equal(t.boot.allowed.length, 0);
  assert.equal(t.provider.machines.size, 0);
});

test('a machine that never connects times out, and one whose boot ended is not allowed', async () => {
  for (const state of ['expired', 'denied', 'failed']) {
    const s = setup({ sleep: async () => s.provider.set('fake-1', 'running') });
    const original = s.provider.create.bind(s.provider);
    s.provider.create = async (sp: any) =>
      ((m) => (s.provider.set(m.id, 'running'), setTimeout(() => s.boot.arrive(state), 2), m))(await original(sp));
    await assert.rejects(s.launcher.launch(spec), (e: any) => e.code === 'timeout');
    assert.equal(s.boot.allowed.length, 0);
    assert.equal(s.provider.machines.size, 0);
  }
});

test('a slow provider: the start step waits through starting states; the wake-up on cancel ends the wait', async () => {
  let reads = 0;
  const s = setup({
    sleep: async () => void (reads++ === 1 && s.provider.set('fake-1', 'running')),
  });
  const run = s.launcher.launch(spec).catch((e: any) => e);
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(reads >= 2);
  assert.equal(s.launcher.cancel('l1'), true);
  assert.equal((await run).code, 'cancelled');
  assert.equal(s.provider.machines.size, 0);
  assert.equal(s.launcher.cancel('l1'), false);
});

test('cancel during creation, or between create and the first read, deletes what was made', async () => {
  const s = setup();
  const original = s.provider.create.bind(s.provider);
  s.provider.create = async (sp: any) => ((m) => (s.launcher.cancel('l1'), m))(await original(sp));
  await assert.rejects(s.launcher.launch(spec), (e: any) => e.code === 'cancelled');
  assert.equal(s.provider.machines.size, 0);
  assert.equal(s.boot.denied, 1);
  // cancelled while the start step reads the state
  const t = setup();
  const status = t.provider.status.bind(t.provider);
  t.provider.status = async (id: string) => ((r) => (t.launcher.cancel('l1'), r))(await status(id));
  await assert.rejects(t.launcher.launch(spec), (e: any) => e.code === 'cancelled');
  assert.equal(t.provider.machines.size, 0);
});

test('the join is refused when the machine is deleted or the launch cancelled between hello and allow', async () => {
  const s = setup();
  const original = s.provider.create.bind(s.provider);
  s.provider.create = async (sp: any) => ((m) => (s.provider.set(m.id, 'running'), m))(await original(sp));
  const status = s.provider.status.bind(s.provider);
  let reads = 0;
  // the second read (after hello) says the machine is gone: another machine said hello with this launch's code, so it is not allowed
  s.provider.status = async (id: string) => (++reads >= 2 ? 'gone' : status(id));
  setTimeout(() => s.boot.arrive(), 10);
  await assert.rejects(s.launcher.launch(spec), (e: any) => e.code === 'gone');
  assert.equal(s.boot.allowed.length, 0);
  assert.equal(s.boot.denied, 1);
});

test('a delete that fails keeps the intent, and the next launch of the app deletes the machine', async () => {
  const s = setup();
  const original = s.provider.create.bind(s.provider);
  s.provider.create = async (sp: any) =>
    ((m) => (s.provider.failNext('destroy', new Error('down')), s.launcher.cancel('l1'), m))(await original(sp));
  await assert.rejects(s.launcher.launch(spec));
  assert.equal(s.provider.machines.size, 1);
  assert.equal(intents(s.home).length, 1);
  assert.equal(intents(s.home)[0].providerId, 'fake-1');
  // the app quits; the next start recovers
  assert.equal(await s.launcher.recover(), 1);
  assert.equal(s.provider.machines.size, 0);
  assert.equal(intents(s.home).length, 0);
  assert.equal(await s.launcher.recover(), 0);
});

test('recovery of an intent made before the answer was seen finds the machine by name; a missing key or a failing delete is left for later', async () => {
  const s = setup();
  await s.provider.create({
    name: 'dev-cloud',
    size: 's',
    region: 'r1',
    command: 'c',
  });
  fs.writeFileSync(
    path.join(s.home, 'intents.json'),
    JSON.stringify({
      intents: [
        {
          launch: 'x',
          provider: 'fake',
          region: 'r1',
          name: 'dev-cloud',
          providerId: '',
        },
      ],
    }),
  );
  assert.equal(await s.launcher.recover(), 1);
  assert.equal(s.provider.machines.size, 0);
  fs.writeFileSync(
    path.join(s.home, 'intents.json'),
    JSON.stringify({
      intents: [
        {
          launch: 'y',
          provider: 'nokey',
          region: 'r1',
          name: 'n',
          providerId: 'p',
        },
        {
          launch: 'z',
          provider: 'fake',
          region: 'r1',
          name: 'n',
          providerId: 'p',
        },
      ],
    }),
  );
  s.provider.failNext('destroy', new Error('down'));
  assert.equal(await s.launcher.recover(), 0);
  assert.equal(intents(s.home).length, 2);
  // a launch in progress is not recovered from under itself
  const t = setup();
  const run = t.launcher.launch(spec).catch((e: any) => e);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(await t.launcher.recover(), 0);
  t.launcher.cancel('l1');
  await run;
});

test('options and key check read through the adapter and never carry the key', async () => {
  const s = setup();
  const o = await s.launcher.options('fake', 'r1');
  assert.equal(o.sizes[0].id, 'small');
  assert.equal(o.flags.resume, true);
  assert.deepEqual(await s.launcher.check('fake', 'r1'), { ok: true });
  s.provider.failNext('regions', new CloudError('refused', 'That key was refused.'));
  assert.deepEqual(await s.launcher.check('fake', 'r1'), {
    ok: false,
    code: 'refused',
    message: 'That key was refused.',
  });
  s.provider.failNext('regions', 'plain');
  assert.deepEqual(await s.launcher.check('fake', 'r1'), {
    ok: false,
    code: 'failed',
    message: 'The provider could not do that.',
  });
  assert.equal(s.launcher.hasKey('fake'), true);
});

test('cloud keys are encrypted at rest, validated, replaced and forgotten', () => {
  const home = dir();
  const file = path.join(home, 'k.json');
  const keys = createCloudKeys({ file, safeStorage: safe });
  assert.equal(keys.get('oci'), null);
  assert.equal(keys.has('oci'), false);
  assert.throws(
    () => keys.set('Bad Name', { a: 1 }),
    (e: any) => e.code === 'invalid',
  );
  assert.throws(() => keys.set('oci', 'x'), /not a provider key/);
  assert.throws(() => keys.set('oci', {}), /not a provider key/);
  keys.set('oci', { pem: 'SECRET-PEM' });
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /SECRET-PEM/);
  assert.equal((keys.get('oci') as any).pem, 'SECRET-PEM');
  assert.equal(keys.has('oci'), true);
  assert.equal(keys.get('Not Valid'), null);
  assert.equal(keys.has('Not Valid'), false);
  assert.throws(
    () =>
      createCloudKeys({
        file,
        safeStorage: { ...safe, isEncryptionAvailable: () => false },
      }).set('oci', { a: 1 }),
    (e: any) => e.code === 'unavailable',
  );
  assert.equal(
    createCloudKeys({
      file,
      safeStorage: { ...safe, decryptString: () => 'not json' },
    }).get('oci'),
    null,
  );
  assert.equal(
    createCloudKeys({
      file,
      safeStorage: { ...safe, decryptString: () => '[1]' },
    }).get('oci'),
    null,
  );
  fs.writeFileSync(file, '{ broken');
  assert.equal(keys.has('oci'), false);
  keys.set('oci', { a: 1 });
  assert.equal(keys.remove('oci'), true);
  assert.equal(keys.remove('oci'), false);
  assert.equal(keys.remove(5), false);
});

test('a cloud record is whole or not at all, and the registry keeps it as kind cloud', () => {
  assert.equal(cloudOf(null), null);
  assert.equal(cloudOf({ provider: 'oci' }), null);
  assert.equal(cloudOf({ provider: 'o ci', id: 'x' }), null);
  assert.deepEqual(
    cloudOf({
      provider: 'oci',
      id: 'ocid1.x',
      region: 5,
      size: 'a',
      network: 'limited',
    }),
    {
      provider: 'oci',
      id: 'ocid1.x',
      region: '',
      size: 'a',
      network: 'limited',
      idleMinutes: 30,
      hoursPerDay: null,
    },
  );
  // how long it may idle and run: what was chosen when it is in range, else the defaults
  const set = (i: unknown, h: unknown) => Object.values(cloudOf({ provider: 'oci', id: 'x', idleMinutes: i, hoursPerDay: h })!).slice(-2);
  assert.equal(JSON.stringify([set(90, 8), set(0, 0), set(10081, 25), set('30', 1.5)]), '[[90,8],[30,null],[30,null],[30,null]]');
  const file = path.join(dir(), 'registry.json');
  const reg = createRegistry({ file });
  const added = reg.add({
    id: 'relay:h1',
    name: 'dev-cloud',
    address: 'relay:h1',
    cloud: {
      provider: 'oci',
      id: 'ocid1.x',
      region: 'r',
      size: 's',
      network: 'full',
    },
  });
  assert.equal(added.kind, 'cloud');
  assert.equal(reg.add({ id: 'relay:h2', name: 'plain', address: 'relay:h2' }).kind, 'ssh');
  const reread = createRegistry({ file });
  const rows = reread.list();
  assert.equal(rows.find((r: any) => r.id === 'relay:h1').cloud.id, 'ocid1.x');
  assert.equal(rows.find((r: any) => r.id === 'relay:h2').cloud, null);
});

const settle = () => new Promise((r) => setImmediate(r));

test('with the real timers behind the clock port, a launch waits for the machine to run and for its hello, with no step listener', async (t) => {
  const clock = useFakeClock(t, 1_000_000);
  const s = setup();
  const launcher = createCloudLauncher({
    file: path.join(s.home, 'i2.json'),
    keys: s.keys,
    makeAdapter: () => s.provider,
    makeBoot: s.boot.make,
  });
  const run = launcher.launch(spec);
  await settle();
  await settle();
  assert.equal(s.provider.machines.get('fake-1')?.state, 'starting');
  s.provider.set('fake-1', 'running');
  for (let i = 0; i < 4; i++) {
    clock.advance(3000);
    await settle();
  }
  s.boot.arrive();
  for (let i = 0; i < 4; i++) {
    clock.advance(3000);
    await settle();
  }
  assert.equal((await run).providerId, 'fake-1');
});

test('two launches at once keep their own intents, and a launch id is minted', async () => {
  const s = setup({ sleep: () => new Promise((r) => setImmediate(r)) });
  const a = s.launcher.launch(spec).catch((e: any) => e);
  const b = s.launcher.launch({ ...spec, launch: 'l2', name: 'other' }).catch((e: any) => e);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(intents(s.home).length, 2);
  s.launcher.cancel('l1');
  s.launcher.cancel('l2');
  assert.equal((await a).code, 'cancelled');
  assert.equal((await b).code, 'cancelled');
  assert.match(newLaunchId(), /^l_[0-9a-f]{16}$/);
  assert.notEqual(newLaunchId(), newLaunchId());
});

test('a keys file that is not a key map holds no keys, and a size that is given is kept', () => {
  const file = path.join(dir(), 'k.json');
  const keys = createCloudKeys({ file, safeStorage: safe });
  for (const text of ['[]', '{"keys":5}', '5', '{}']) {
    fs.writeFileSync(file, text);
    assert.equal(keys.has('oci'), false);
  }
  assert.equal(cloudOf({ provider: 'oci', id: 'x', size: 'VM.Standard.A1.Flex:1:6' })?.size, 'VM.Standard.A1.Flex:1:6');
  assert.equal(cloudOf({ provider: 'oci', id: 'x', region: 'us-ashburn-1' })?.region, 'us-ashburn-1');
});

test('a launch whose intent cannot be kept fails with that reason, makes nothing, and is not left marked as running', async () => {
  const s = setup();
  const blocker = path.join(s.home, 'plain-file');
  fs.writeFileSync(blocker, 'x');
  const launcher = createCloudLauncher({
    file: path.join(blocker, 'i.json'),
    keys: s.keys,
    makeAdapter: () => s.provider,
    makeBoot: s.boot.make,
  });
  await assert.rejects(launcher.launch(spec), (e: any) => /EEXIST|ENOTDIR/.test(e.message));
  await assert.rejects(launcher.launch(spec), (e: any) => e.code !== 'busy');
  assert.equal(s.provider.machines.size, 0);
});
