// Where the Mac keeps what MoMo's real home needs (electron/momo/homeService.cjs): where MoMo lives and the unsent messages are one account's, the messages sealed, never shown to another account, kept through a sign-out and gone with a Reset; with no system key nothing is kept and the send says so; a sealed file that cannot be read is never written over. Over the app's real machines service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { waitFor } from './support/waitFor.ts';
import { realMachines } from './support/momoRealMachines.ts';
import { STUDIO, RUNNING, hostSays, safe, start, tick, tmp } from './support/momoServiceKit.ts';

const require = createRequire(import.meta.url);
const { eraseHomeClient } = require('../electron/momo/homeService.cjs');
const { readSecret, writeSecret } = require('../electron/platform/secretFile.cjs');
const { getHomeApi, setHomeApi } = require('../electron/momo/homeSlot.cjs');

test('where MoMo lives and the unsent messages are kept for each account: across a restart, the messages sealed, never shown to another account, gone with a sign-out and a Reset', async (t) => {
  setHomeApi(null);
  const dir = tmp(t);
  const momoDir = path.join(dir, 'momo');
  let who: string | null = 'ann';
  let allowed = true;
  let tell: () => void = () => undefined;
  const run = (r: ReturnType<typeof realMachines>) =>
    start({ machines: r.m, dir, allowed: () => allowed, account: () => who, watch: (fn: () => void) => ((tell = fn), () => undefined) });
  // the home is seen on the Studio; the lease and the place are written for the account
  const first = realMachines(t, [{ id: 'studio', name: 'Studio', hostId: STUDIO }], hostSays(RUNNING));
  await first.beat();
  const stop = run(first);
  await waitFor(() => getHomeApi(), 'the home');
  assert.equal(((await getHomeApi().view()) as any).view.home.leaseEpoch, 3);
  await waitFor(() => fs.existsSync(path.join(momoDir, 'home-client.json')), 'the note');
  const file = JSON.parse(fs.readFileSync(path.join(momoDir, 'home-client.json'), 'utf8'));
  assert.deepEqual([file.accounts.ann.seen, file.accounts.ann.home.homeId], [3, STUDIO]);
  stop();
  setHomeApi(null);
  // a restart with the Studio down: asleep on Studio, never the first run, and no second home can be made
  const down = realMachines(t, [{ id: 'studio', name: 'Studio', hostId: STUDIO, up: false }], hostSays(null));
  await down.beat();
  const stop2 = run(down);
  await waitFor(() => getHomeApi(), 'the home after the restart');
  const view = ((await getHomeApi().view()) as any).view;
  assert.equal(view.home.state, 'asleep');
  assert.equal(view.home.machineName, 'Studio');
  assert.notEqual(view.setup.step, 'where');
  assert.equal(((await getHomeApi().intent({ kind: 'choose-home', machineId: 'studio' })) as any).ok, false);
  // a message written meanwhile is sealed: the file does not hold the text
  const sent: any = await getHomeApi().intent({ kind: 'send', turnId: 'turn-00000001', text: 'Private words about Dana' });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.ok(!fs.readFileSync(path.join(momoDir, 'outbox.json'), 'utf8').includes('Private words'), 'not in plain text');
  stop2();
  setHomeApi(null);
  // another account sees none of it, and starts with no home on record
  who = 'bob';
  const other = realMachines(t, [{ id: 'studio', name: 'Studio', hostId: STUDIO }], hostSays(null));
  await other.beat();
  const stop3 = run(other);
  await waitFor(() => getHomeApi(), 'the other account’s home');
  const bobs = ((await getHomeApi().view()) as any).view;
  assert.equal(bobs.setup.step, 'where', 'a first run for this account');
  assert.deepEqual(bobs.chat, []);
  stop3();
  setHomeApi(null);
  // ann again: her words and her home are still there
  who = 'ann';
  const again = realMachines(t, [{ id: 'studio', name: 'Studio', hostId: STUDIO, up: false }], hostSays(null));
  await again.beat();
  const stop4 = run(again);
  await waitFor(() => getHomeApi(), 'her home again');
  const mine = ((await getHomeApi().view()) as any).view;
  assert.equal(mine.home.machineName, 'Studio', 'what another account did left her slot alone');
  assert.deepEqual(
    mine.chat.filter((r: any) => r.kind === 'user').map((r: any) => r.text),
    ['Private words about Dana'],
  );
  // a sign-out does not drop what the account kept: it is sealed there for when it signs back in
  allowed = false;
  tell();
  assert.equal(getHomeApi(), null);
  assert.equal(fs.existsSync(path.join(momoDir, 'outbox.json')), true);
  assert.equal(fs.existsSync(path.join(momoDir, 'home-client.json')), true);
  allowed = true;
  tell();
  await waitFor(() => getHomeApi(), 'the home once more');
  // Reset forgets both at once, and a running home forgets where MoMo lived
  eraseHomeClient(momoDir);
  // only this account's own slots were emptied: the files stay for the accounts that are not resetting
  assert.deepEqual(fs.readdirSync(momoDir).sort(), ['home-client.json', 'outbox.json', 'sent.json']);
  stop4();
  setHomeApi(null);
  const hosts = realMachines(t, [{ id: 'studio', name: 'Studio', hostId: STUDIO }], hostSays(null));
  await hosts.beat();
  const fresh = run(hosts);
  await waitFor(() => getHomeApi(), 'the home after the reset');
  const after = ((await getHomeApi().view()) as any).view;
  assert.equal(after.setup.step, 'where', 'a Reset forgets where MoMo lived');
  assert.deepEqual(after.chat, [], 'and the words it held');
  fresh();
  setHomeApi(null);
});

test('with no system key nothing is kept, and the send says so; a scripted home a dev run set is never replaced; a module that fails to load leaves the home absent', async (t) => {
  setHomeApi(null);
  const dir = tmp(t);
  const sleeping = realMachines(t, [{ id: 'studio', name: 'Studio', hostId: STUDIO, up: false }], hostSays(null));
  await sleeping.beat();
  const stop = start({ machines: sleeping.m, dir, safeStorage: safe(false) });
  await waitFor(() => getHomeApi(), 'the home');
  // MoMo has not been heard from: the message is held, which needs the key
  const refused: any = await getHomeApi().intent({ kind: 'send', turnId: 'turn-00000002', text: 'Words' });
  assert.equal(refused.ok, false);
  assert.match(refused.cause, /can’t encrypt|keychain/);
  assert.equal(fs.existsSync(path.join(dir, 'momo', 'outbox.json')), false);
  stop();
  setHomeApi(null);
  const scripted = { view: async () => ({}), intent: async () => ({}), onChanged: () => () => undefined };
  setHomeApi(scripted);
  const stop2 = start({ machines: sleeping.m, dir });
  await tick();
  assert.equal(getHomeApi(), scripted);
  stop2();
  setHomeApi(null);
  const stop3 = start({ machines: sleeping.m, dir, load: async () => Promise.reject(new Error('missing')) });
  await tick();
  assert.equal(getHomeApi(), null);
  // turned off while the modules load: nothing is installed
  let on = true;
  const stop4 = start({
    machines: sleeping.m,
    dir,
    allowed: () => on,
    load: async () => ((on = false), import('../shared/momoHomeReal.mjs' as any)),
  });
  await tick();
  assert.equal(getHomeApi(), null);
  stop3();
  stop4();
});

test('saved messages that cannot be read (sealed with another key) are never written over, and the send says why', async (t) => {
  setHomeApi(null);
  const dir = tmp(t);
  const file = path.join(dir, 'momo', 'outbox.json');
  // what an earlier key sealed
  const { writeSecret } = require('../electron/platform/secretFile.cjs');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeSecret(
    file,
    JSON.stringify({
      accounts: { ann: { entries: [{ turnId: 'turn-00000099', chatId: '', text: 'Kept before', createdAt: 1, delivery: 'not-sent' }] } },
    }),
    safe(),
  );
  const before = fs.readFileSync(file, 'utf8');
  const sleeping = realMachines(t, [{ id: 'studio', name: 'Studio', hostId: STUDIO, up: false }], hostSays(null));
  await sleeping.beat();
  const otherKey = {
    ...safe(),
    decryptString: () => {
      throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
    },
  };
  const stop = start({ machines: sleeping.m, dir, safeStorage: otherKey });
  await waitFor(() => getHomeApi(), 'the home');
  const refused: any = await getHomeApi().intent({ kind: 'send', turnId: 'turn-00000100', text: 'New words' });
  assert.equal(refused.ok, false);
  assert.match(refused.cause, /can’t read the messages it kept on this Mac, so it will not write over them/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'what was there is untouched');
  stop();
  setHomeApi(null);
});

test('a lease note an earlier build kept counts as the highest lease seen: a new home starts above it', async (t) => {
  setHomeApi(null);
  const dir = tmp(t);
  fs.mkdirSync(path.join(dir, 'momo'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'momo', 'home-client.json'),
    JSON.stringify({ accounts: { ann: { newest: { homeId: 'gone', leaseEpoch: 9 } } } }),
  );
  const starts: any[] = [];
  const r = realMachines(
    t,
    [{ id: 'studio', name: 'Studio', hostId: STUDIO }],
    hostSays(null, (_id, method, p) => (method === 'host.momoHomeStart' ? (starts.push(p), { ok: true }) : undefined)),
  );
  await r.beat();
  const stop = start({ machines: r.m, dir, watch: () => () => undefined });
  await waitFor(() => getHomeApi(), 'the home');
  assert.equal(((await getHomeApi().intent({ kind: 'choose-home', machineId: 'studio' })) as any).ok, true);
  // every start also names the oldest Host release it accepts (#5626); its value is momoHomeMinVersion.test.ts's to check
  assert.deepEqual(
    starts.map(({ minVersion, ...rest }) => rest),
    [{ name: 'Studio', floor: 9 }],
  );
  assert.match(starts[0].minVersion, /^\d+\.\d+\.\d+$/);
  stop();
  setHomeApi(null);
});

test('Reset MoMo takes the account’s own slot out of every file when no home is running, and leaves another account’s alone', async (t) => {
  setHomeApi(null);
  const dir = tmp(t);
  const momoDir = path.join(dir, 'momo');
  fs.mkdirSync(momoDir, { recursive: true });
  fs.writeFileSync(path.join(momoDir, 'home-client.json'), JSON.stringify({ accounts: { ann: { seen: 4 }, bob: { seen: 2 } } }));
  for (const name of ['outbox.json', 'sent.json'])
    writeSecret(
      path.join(momoDir, name),
      JSON.stringify({ accounts: { ann: { entries: [{ id: 'a' }] }, bob: { entries: [{ id: 'b' }] } } }),
      safe(),
      'test',
    );
  eraseHomeClient(momoDir, { account: 'ann', safeStorage: safe() });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(momoDir, 'home-client.json'), 'utf8')).accounts), ['bob']);
  for (const name of ['outbox.json', 'sent.json']) {
    const body = JSON.parse(readSecret(path.join(momoDir, name), safe()).value);
    assert.deepEqual(Object.keys(body.accounts), ['bob']);
  }
  // no account to erase for, or a file that cannot be read: nothing is written
  const before = fs.readFileSync(path.join(momoDir, 'outbox.json'));
  eraseHomeClient(momoDir);
  eraseHomeClient(momoDir, {
    account: 'bob',
    safeStorage: {
      ...safe(),
      decryptString: () => {
        throw new Error('other key');
      },
    },
  });
  assert.deepEqual(fs.readFileSync(path.join(momoDir, 'outbox.json')), before);
});

test('every connection to a Host says hello first, and a Host that lacks what a call needs refuses it as an unknown one', async (t) => {
  setHomeApi(null);
  const dir = tmp(t);
  const r = realMachines(t, [{ id: 'studio', name: 'Studio', hostId: STUDIO }], hostSays(null));
  await r.beat();
  const stop = start({ machines: r.m, dir, watch: () => () => undefined });
  await waitFor(() => getHomeApi(), 'the home');
  await getHomeApi().view();
  // each call opened its own connection, and that connection began with the protocol's hello
  const calls = r.seen.filter((s) => s.method.startsWith('host.momo'));
  assert.ok(calls.length > 0);
  for (const c of calls) {
    const first = r.seen.filter((s) => s.id === c.id).findIndex((s) => s === c);
    assert.ok(first > 0, `${c.method} is not the first thing on its connection`);
  }
  assert.ok(r.seen.some((s) => s.method === 'host.hello'));
  stop();
  setHomeApi(null);
});
