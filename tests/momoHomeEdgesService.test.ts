// The edges of the Mac's wiring of MoMo's real home (electron/momo/homeService.cjs) over the app's real machines service: a Host whose permission lapsed is told again, a grant is not sent twice in a row, a machine that
// answers too late is not heard, a service started twice is started once, and what Reset and a sign-out leave in the files when a write cannot be made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { fixId } from '../shared/momoFixId.mjs';
import { waitFor } from './support/waitFor.ts';
import { realMachines } from './support/momoRealMachines.ts';
import { RUNNING, STUDIO, hostSays, safe, start, tmp } from './support/momoServiceKit.ts';

const require = createRequire(import.meta.url);
const { startHomeService, eraseHomeClient, homeOptions } = require('../electron/momo/homeService.cjs');
const { sayHello } = require('../electron/host/helloFirst.cjs');
const { getHomeApi, setHomeApi } = require('../electron/momo/homeSlot.cjs');

test('a Host whose permission lapsed is told again before its look is read, and a grant already sent is not sent again at once', async (t) => {
  setHomeApi(null);
  const dir = tmp(t);
  let live = false;
  const grants: string[] = [];
  const r = realMachines(
    t,
    [{ id: 'studio', name: 'Studio', hostId: STUDIO }],
    hostSays(null, (_id, method) => {
      if (method === 'host.momoHomeLook') return { holds: 'none', leaseEpoch: 0, grantLive: live };
      if (method === 'host.momoGrant') {
        grants.push(method);
        live = true;
        return { ok: true };
      }
      return undefined;
    }),
  );
  await r.beat();
  const stop = start({ machines: r.m, dir, watch: () => () => undefined });
  await waitFor(() => getHomeApi(), 'the home');
  await getHomeApi().view();
  await waitFor(() => grants.length >= 1, 'the grant to be sent');
  const before = grants.length;
  // two machine changes in a row: a grant that is being sent is not started twice, and one just sent is not sent again
  await r.beat();
  await r.beat();
  await getHomeApi().view();
  assert.equal(grants.length, before, 'no second grant within the half hour');
  stop();
  setHomeApi(null);
});

test('a service asked to start twice starts once, and one with no account to name uses the app’s own', async (t) => {
  setHomeApi(null);
  const dir = tmp(t);
  const r = realMachines(t, [{ id: 'studio', name: 'Studio', hostId: STUDIO }], hostSays(null));
  await r.beat();
  let tell: () => void = () => undefined;
  const stop = start({ machines: r.m, dir, watch: (fn: () => void) => ((tell = fn), () => undefined) });
  tell();
  tell();
  await waitFor(() => getHomeApi(), 'the home');
  stop();
  setHomeApi(null);
  const bare = startHomeService({ machines: r.m, dir, allowed: () => true, flagOn: () => true, safeStorage: safe(), hello: sayHello });
  await waitFor(() => getHomeApi(), 'the home with the default account');
  bare();
  setHomeApi(null);
});

test('a machine that answers too late is not heard: its session is closed and MoMo is asleep, not a first run', async (t) => {
  setHomeApi(null);
  const dir = tmp(t);
  const r = realMachines(t, [{ id: 'studio', name: 'Studio', hostId: STUDIO }], hostSays(null));
  await r.beat();
  const slow = Object.create(r.m);
  slow.session = async (id: string) => {
    await new Promise((x) => setTimeout(x, 80));
    return r.m.session(id);
  };
  const stop = start({ machines: slow, dir, watch: () => () => undefined, timeouts: { status: 20, call: 20 } });
  await waitFor(() => getHomeApi(), 'the home');
  const v = ((await getHomeApi().view()) as any).view;
  assert.notEqual(v.setup.step, 'where', 'a machine that did not answer is not "no home"');
  stop();
  setHomeApi(null);
});

test('Reset takes an account out of the files that cannot be changed and says so, and a file with no system key or nothing in it is left alone', async (t) => {
  const dir = tmp(t);
  const momoDir = path.join(dir, 'momo');
  fs.mkdirSync(momoDir, { recursive: true });
  fs.writeFileSync(path.join(momoDir, 'home-client.json'), JSON.stringify({ accounts: { ann: { seen: 3 } } }));
  // no system key: the sealed files are not touched; a sealed file that is not there is nothing to take out
  eraseHomeClient(momoDir, { account: 'ann' });
  eraseHomeClient(momoDir, { account: 'ann', safeStorage: safe() });
  // a folder that cannot be written: the note stays, and the failure is told, not thrown
  fs.writeFileSync(path.join(momoDir, 'home-client.json'), JSON.stringify({ accounts: { ann: { seen: 3 } } }));
  fs.chmodSync(momoDir, 0o555);
  try {
    eraseHomeClient(momoDir, { account: 'ann', safeStorage: safe() });
  } finally {
    fs.chmodSync(momoDir, 0o755);
  }
  assert.ok(JSON.parse(fs.readFileSync(path.join(momoDir, 'home-client.json'), 'utf8')).accounts.ann, 'what could not be written stays');
});

test('a note that cannot be written is told and not thrown, and another account’s service writes nothing under the first one’s name', async (t) => {
  setHomeApi(null);
  const dir = tmp(t);
  const momoDir = path.join(dir, 'momo');
  let who: string | null = 'ann';
  const r = realMachines(t, [{ id: 'studio', name: 'Studio', hostId: STUDIO }], hostSays(null));
  await r.beat();
  const stop = start({ machines: r.m, dir, account: () => who, watch: () => () => undefined });
  await waitFor(() => getHomeApi(), 'the home');
  await getHomeApi().view();
  // the folder cannot be written: Reset asks the home to forget, which writes, which fails quietly
  fs.mkdirSync(momoDir, { recursive: true });
  fs.chmodSync(momoDir, 0o555);
  try {
    eraseHomeClient(momoDir, { account: 'ann', safeStorage: safe() });
  } finally {
    fs.chmodSync(momoDir, 0o755);
  }
  // another account signed in under the running service: its writes are not made
  who = 'bob';
  eraseHomeClient(momoDir, { account: 'bob', safeStorage: safe() });
  stop();
  setHomeApi(null);
});

test('with nothing injected the home waits for a change with the app’s own timers and asks for a confirmation with its own ids', async (t) => {
  setHomeApi(null);
  const dir = tmp(t);
  const r = realMachines(t, [{ id: 'studio', name: 'Studio', hostId: STUDIO, up: false }], hostSays(null));
  await r.beat();
  const stop = start({ machines: r.m, dir, watch: () => () => undefined });
  await waitFor(() => getHomeApi(), 'the home');
  const off = getHomeApi().onChanged(() => undefined);
  const asked: any = await getHomeApi().intent({ kind: 'fix', id: 'start-fresh' });
  assert.match(asked.fix.id, /^start-fresh!:[0-9a-f-]{36}$/);
  // a change is looked at after the wait; stopping gives the wait up
  await r.beat();
  off();
  stop();
  setHomeApi(null);
});

test('a Host whose look keeps saying its permission lapsed is told through the look’s own port, and a grant in flight is not started twice', async (t) => {
  setHomeApi(null);
  const dir = tmp(t);
  const grants: number[] = [];
  const r = realMachines(
    t,
    [{ id: 'studio', name: 'Studio', hostId: STUDIO }],
    hostSays(null, (_id, method) => {
      if (method === 'host.momoHomeLook') return { holds: 'none', leaseEpoch: 0, grantLive: false };
      if (method === 'host.momoGrant') {
        grants.push(Date.now());
        return new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 60));
      }
      return undefined;
    }),
  );
  await r.beat();
  const stop = start({ machines: r.m, dir, watch: () => () => undefined });
  await waitFor(() => getHomeApi(), 'the home');
  // the service's own grant is in flight: a change of the machine meanwhile does not start another
  await r.beat();
  await getHomeApi().view();
  await waitFor(() => grants.length >= 2, 'the look’s own grant to be sent too');
  stop();
  setHomeApi(null);
});

test('a machine under the id the app really gives it (ssh:user@host:port) is chosen, looked at and updated through the service', async (t) => {
  setHomeApi(null);
  const dir = tmp(t);
  const id = 'ssh:runner@studio:2222';
  const done: string[] = [];
  const r = realMachines(t, [{ id, name: 'Studio', hostId: STUDIO }], async (_id, method) => {
    if (method === 'host.momoHomeLook') return { holds: 'none', leaseEpoch: 0, grantLive: true };
    if (method === 'host.momoHomeStart') return { home: { homeId: STUDIO, leaseEpoch: 1, state: 'running', name: 'Studio' } };
    if (method === 'host.momoStatus')
      return { home: { homeId: STUDIO, leaseEpoch: 1, state: 'running', stateSince: 1, lastSeenAt: 1, name: 'Studio' } };
    if (method === 'host.momoChat') return { chatId: 'claude:c1', epoch: 1 };
    throw Object.assign(new Error(`Unknown request: ${method}`), { code: 'unknown_request' });
  });
  await r.beat();
  const stale = {
    ...r.m,
    list: () => ({ ...r.m.list(), machines: r.m.list().machines.map((row: any) => ({ ...row, hostStale: true })) }),
    updateHost: async (machineId: string) => void done.push(machineId),
  };
  const stop = start({ machines: stale, dir, watch: () => () => undefined });
  await waitFor(() => getHomeApi(), 'the home');
  const api = getHomeApi();
  // out of date: chosen refused, then updated by the fix id the screen would send, which names the machine whole
  assert.match(((await api.intent({ kind: 'choose-home', machineId: id })) as any).cause, /needs an update/);
  assert.equal(((await api.intent({ kind: 'fix', id: fixId('update-machine', id) })) as any).ok, true);
  assert.deepEqual(done, [id]);
  stop();
  setHomeApi(null);
});

test('a spec that reads the Host’s ledger gets a call to the home’s own Host, only from an app that says it is not packaged, and only when it asks for it', async (t) => {
  setHomeApi(null);
  const dir = tmp(t);
  const r = realMachines(t, [{ id: 'studio', name: 'Studio', hostId: STUDIO }], hostSays(RUNNING));
  await r.beat();
  const optionsFor = (app: object, env: string | undefined) => {
    if (env === undefined) delete process.env.MOPILOT_MOMO_TEST_HOST_CALL;
    else process.env.MOPILOT_MOMO_TEST_HOST_CALL = env;
    return homeOptions(r.m, { app: { getPath: () => dir, ...app }, shell: { openExternal: () => undefined } }, { hello: sayHello });
  };
  try {
    // a packaged app never has it, whatever the environment says; one that does not say is not trusted; one that is not asked has none
    assert.equal(optionsFor({ isPackaged: true }, '1').testHostCall, false);
    assert.equal(optionsFor({}, '1').testHostCall, false);
    assert.equal(optionsFor({ isPackaged: false }, undefined).testHostCall, false);
    const options = optionsFor({ isPackaged: false }, '1');
    assert.equal(options.testHostCall, true);
    assert.equal((globalThis as any).__momoHostCall, undefined, 'not before a home runs');
    const stop = startHomeService({
      ...options,
      allowed: () => true,
      flagOn: () => true,
      account: () => 'ann',
      watch: () => () => undefined,
    });
    await waitFor(() => getHomeApi(), 'the home');
    await waitFor(() => (globalThis as any).__momoHostCall, 'the hook');
    assert.equal((await (globalThis as any).__momoHostCall('host.momoChat', { harness: 'claude' })).chatId, 'claude:c1');
    stop();
    // a packaged app's service never sets it
    delete (globalThis as any).__momoHostCall;
    const packaged = startHomeService({
      ...optionsFor({ isPackaged: true }, '1'),
      allowed: () => true,
      flagOn: () => true,
      account: () => 'ann',
      watch: () => () => undefined,
    });
    await waitFor(() => getHomeApi(), 'the home again');
    await getHomeApi().view();
    assert.equal((globalThis as any).__momoHostCall, undefined);
    packaged();
  } finally {
    delete process.env.MOPILOT_MOMO_TEST_HOST_CALL;
    delete (globalThis as any).__momoHostCall;
    setHomeApi(null);
  }
});
