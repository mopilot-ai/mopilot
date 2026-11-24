// The Mac's wiring of MoMo's real home (electron/momo/homeService.cjs) over the app's REAL machines service (electron/host/machines.cjs, tests/support/momoRealMachines.ts): the rows it maps are the ones the service really gives (`list()` is `{ machines, resolved }`, the registry row has the Host's id and build), every paired machine is asked, a new app that never heard from the home does not start another, each Host call is one session that is closed (a hung one too), the home is in the slot only while MoMo is allowed, the flag is on and an account is signed in, what is kept is one account's (the messages sealed), and Reset forgets it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { waitFor } from './support/waitFor.ts';
import { realMachines } from './support/momoRealMachines.ts';
import { RUNNING, STUDIO, MINI, hostSays, safe, start, tick, tmp } from './support/momoServiceKit.ts';

const require = createRequire(import.meta.url);
const { startHomeService, machineRecordOf, homeOptions } = require('../electron/momo/homeService.cjs');
const { sayHello } = require('../electron/host/helloFirst.cjs');
const { getHomeApi, setHomeApi } = require('../electron/momo/homeSlot.cjs');

test('the real list and registry row become the record the view reads: the Host’s id and build, up or not, its agents, and out of date only when the list says so', async (t) => {
  const r = realMachines(
    t,
    [
      { id: 'studio', name: 'Studio', hostId: STUDIO, build: 'b9' },
      { id: 'mini', name: 'Mac mini', up: false },
    ],
    hostSays(null),
  );
  await r.beat();
  const list = r.m.list();
  assert.deepEqual(Object.keys(list).sort(), ['machines', 'resolved'], 'the list is not the rows');
  const rec = (id: string) =>
    machineRecordOf(
      list.machines.find((x: any) => x.id === id),
      r.m.row(id),
      { isThisDevice: () => false, needBuild: 'b9' },
    );
  assert.deepEqual(rec('studio'), {
    id: 'studio',
    hostId: STUDIO,
    name: 'Studio',
    isThisDevice: false,
    reachable: true,
    current: true,
    stays: 'on',
    setUp: true,
    hasHost: true,
    agents: [{ id: 'claude', name: 'Claude Code', installed: true, signedIn: true }],
    hostBuild: 'b9',
    hostAppVersion: undefined,
    hostVersionAt: r.m.row('studio').lastHeartbeat,
    needBuild: 'b9',
  });
  // a machine that is down is still asked, and it is not "not set up"
  const mini = rec('mini');
  assert.deepEqual([mini.reachable, mini.setUp, mini.hostId, mini.hostBuild, mini.agents], [false, true, undefined, undefined, []]);
  // a machine whose Host is behind this app, a cloud one, a machine that answers but needs something, the Host's id from the list when the registry has none
  const row0 = list.machines[0];
  const plain = { isThisDevice: () => false };
  assert.equal(machineRecordOf({ ...row0, hostStale: true }, r.m.row('studio'), plain).current, false);
  assert.equal(machineRecordOf({ ...row0, cloud: { id: 'c' } }, undefined, plain).stays, 'cloud');
  assert.equal(machineRecordOf({ ...row0, status: 'attention' }, undefined, plain).reachable, true);
  assert.equal(machineRecordOf({ ...row0, repositoryScope: STUDIO }, { hostKey: '' }, plain).hostId, STUDIO);
  assert.deepEqual(
    machineRecordOf(
      {
        id: 'x',
        name: 'X',
        status: 'online',
        agents: [
          { id: 'codex', label: 'Codex', state: 'signin' },
          { id: 'g', state: 'missing' },
        ],
      },
      undefined,
      plain,
    ).agents,
    [
      { id: 'codex', name: 'Codex', installed: true, signedIn: false },
      { id: 'g', name: 'g', installed: false, signedIn: false },
    ],
  );
  assert.deepEqual(machineRecordOf({ id: 'y', name: 'Y', status: 'online' }, undefined, plain).agents, []);
  assert.equal(
    machineRecordOf({ id: 'z', name: 'Z', status: 'online', agents: [{ id: 'q', name: 'Why', state: 'ready' }] }, undefined, plain)
      .agents[0].name,
    'Why',
  );
});

test('a new app that has never heard from the home, whose machine is asleep, does not start another home: it has to hear from every paired machine first', async (t) => {
  setHomeApi(null);
  const dir = tmp(t);
  // the Studio holds MoMo and is down; the Mini is up and says it holds none
  const r = realMachines(
    t,
    [
      { id: 'studio', name: 'Studio', hostId: STUDIO, up: false },
      { id: 'mini', name: 'Mac mini', hostId: MINI },
    ],
    hostSays(RUNNING),
  );
  await r.beat();
  const stop = start({ machines: r.m, dir });
  await waitFor(() => getHomeApi(), 'the home');
  const v = ((await getHomeApi().view()) as any).view;
  assert.notEqual(v.setup.step, 'where', 'not heard yet is not a first run');
  assert.equal(v.home.state, 'asleep');
  const refused: any = await getHomeApi().intent({ kind: 'choose-home', machineId: 'mini' });
  assert.equal(refused.ok, false);
  assert.match(refused.cause, /Studio did not answer, and MoMo may live there/);
  assert.equal(
    r.seen.some((s) => s.method === 'host.momoHomeStart'),
    false,
    'no Host was told to become a home',
  );
  stop();
  setHomeApi(null);
  // every paired machine up and none holds MoMo: now it is a first run, and the choice goes through
  const all = realMachines(
    t,
    [
      { id: 'studio', name: 'Studio', hostId: STUDIO },
      { id: 'mini', name: 'Mac mini', hostId: MINI },
    ],
    hostSays(null),
  );
  await all.beat();
  const stop2 = start({ machines: all.m, dir: tmp(t) });
  await waitFor(() => getHomeApi(), 'the home');
  assert.equal(((await getHomeApi().view()) as any).view.setup.step, 'where');
  assert.equal(((await getHomeApi().intent({ kind: 'choose-home', machineId: 'studio' })) as any).ok, true);
  assert.ok(all.seen.some((s) => s.id === 'studio' && s.method === 'host.momoHomeStart'));
  stop2();
  setHomeApi(null);
});

test('every Host call is one paired session that is closed after it, and one that hangs is closed when its time runs out', async (t) => {
  setHomeApi(null);
  const dir = tmp(t);
  const r = realMachines(
    t,
    [{ id: 'studio', name: 'Studio', hostId: STUDIO }],
    hostSays(RUNNING, (_id, method) => (method === 'host.momoRows' ? new Promise(() => undefined) : undefined)),
  );
  await r.beat();
  const stop = start({ machines: r.m, dir, timeouts: { status: 300, call: 600 } });
  await waitFor(() => getHomeApi(), 'the home');
  await getHomeApi().view();
  await waitFor(() => r.seen.some((s) => s.method === 'host.momoRows'), 'the rows to be asked for');
  // the rows never answer: that session is closed when its time ran out
  await waitFor(() => r.open.length > 0 && r.open.every((s) => s.closed), 'every session to be closed');
  assert.ok(r.open.length >= 2);
  stop();
  setHomeApi(null);
});

test('the home is in the slot only while MoMo is allowed, the flag is on and an account is signed in, and it follows each, a flag that loads late included', async (t) => {
  setHomeApi(null);
  const dir = tmp(t);
  const r = realMachines(t, [{ id: 'studio', name: 'Studio', hostId: STUDIO }], hostSays(null));
  await r.beat();
  let allowed = false;
  let flag = false;
  let who: string | null = 'ann';
  let tell: () => void = () => undefined;
  const stop = start({
    machines: r.m,
    dir,
    allowed: () => allowed,
    flagOn: () => flag,
    account: () => who,
    watch: (fn: () => void) => ((tell = fn), () => undefined),
  });
  await tick();
  assert.equal(getHomeApi(), null, 'not allowed and the flag is off: absent');
  allowed = true;
  tell();
  await tick();
  assert.equal(getHomeApi(), null, 'the flag is still off: absent');
  flag = true; // the switches load after this was attached
  tell();
  await waitFor(() => getHomeApi(), 'the home once the flag turned on');
  const api = getHomeApi();
  tell();
  await tick();
  assert.equal(getHomeApi(), api, 'a second check keeps the one that is running');
  who = null;
  tell();
  assert.equal(getHomeApi(), null, 'no account: gone at once');
  who = 'ann';
  tell();
  await waitFor(() => getHomeApi(), 'the home again');
  allowed = false;
  tell();
  assert.equal(getHomeApi(), null, 'MoMo no longer allowed: gone at once');
  stop();
  setHomeApi(null);
});

test('a start that another account interrupted is not lost: the account that is signed in now gets its home, and the first one wrote nothing', async (t) => {
  setHomeApi(null);
  const dir = tmp(t);
  const r = realMachines(t, [{ id: 'studio', name: 'Studio', hostId: STUDIO }], hostSays(RUNNING));
  await r.beat();
  let who = 'ann';
  let tell: () => void = () => undefined;
  const stop = start({
    machines: r.m,
    dir,
    account: () => who,
    watch: (fn: () => void) => ((tell = fn), () => undefined),
    // the account changes while the modules load
    load: async () => ((who = 'bob'), import('../shared/momoHomeReal.mjs' as any)),
  });
  await tick();
  tell();
  await waitFor(() => getHomeApi(), 'the home of the account that is signed in now');
  assert.equal(((await getHomeApi().view()) as any).view.home.leaseEpoch, 3);
  await waitFor(() => fs.existsSync(path.join(dir, 'momo', 'home-client.json')), 'the note to be kept');
  const kept = JSON.parse(fs.readFileSync(path.join(dir, 'momo', 'home-client.json'), 'utf8'));
  assert.deepEqual(Object.keys(kept.accounts), ['bob'], 'only the account that is signed in has a slot');
  stop();
  setHomeApi(null);
});

let asleep = false;
test('the machine actions are the ones the app already has, and one it has not says so in words', async (t) => {
  setHomeApi(null);
  const dir = tmp(t);
  const r = realMachines(
    t,
    [{ id: 'studio', name: 'Studio', hostId: STUDIO }],
    hostSays(RUNNING, (_id, method) => {
      if (asleep && method.startsWith('host.momo')) throw new Error('Could not reach the machine.');
      return undefined;
    }),
  );
  await r.beat();
  const done: string[] = [];
  const woken: string[] = [];
  // a machine whose Host is out of date, with an agent that is not signed in and one that is not installed: what each action is offered for
  const list = () => {
    const l = r.m.list();
    return {
      ...l,
      machines: l.machines.map((row: any) => ({
        ...row,
        hostStale: true,
        agents: [
          { id: 'claude', label: 'Claude Code', state: 'signed-out' },
          { id: 'codex', label: 'Codex', state: 'missing' },
        ],
      })),
    };
  };
  const machines = {
    list,
    row: r.m.row,
    session: r.m.session,
    onRowChange: r.m.onRowChange,
    appBuild: () => 'b9',
    updateHost: async (id: string) => void done.push(`update:${id}`),
    installAgent: async (id: string, h: string) => void done.push(`install:${id}:${h}`),
    signIn: async (id: string, h: string, key: unknown, here: unknown) => void done.push(`signin:${id}:${h}:${key}:${here}`),
  };
  const stop = start({ machines, dir, wake: async (id: string) => void woken.push(id) });
  await waitFor(() => getHomeApi(), 'the home');
  const api = getHomeApi();
  await api.view();
  const ok = async (i: object) => ((await api.intent(i)) as any).ok;
  assert.equal(await ok({ kind: 'update-machine', machineId: 'studio' }), true);
  assert.equal(await ok({ kind: 'set-up-machine', machineId: 'studio' }), false, 'every paired machine is set up for MoMo');
  assert.equal(await ok({ kind: 'install-agent', machineId: 'studio', agent: 'codex' }), true);
  assert.equal(await ok({ kind: 'sign-in-agent', machineId: 'studio', agent: 'claude' }), true);
  assert.equal(await ok({ kind: 'wake' }), false, 'a home that answers is awake');
  asleep = true;
  await api.intent({ kind: 'fix', id: 'check-again' });
  assert.equal(await ok({ kind: 'wake' }), true);
  assert.deepEqual(done, ['update:studio', 'install:studio:codex', 'signin:studio:claude:undefined:true']);
  assert.deepEqual(woken, ['studio']);
  stop();
  setHomeApi(null);
  // a build whose machines service lacks them says so
  const bare = start({ machines: { list, row: r.m.row, session: r.m.session, onRowChange: r.m.onRowChange }, dir });
  await waitFor(() => getHomeApi(), 'the home');
  assert.deepEqual(await getHomeApi().intent({ kind: 'update-machine', machineId: 'studio' }), {
    ok: false,
    cause: 'MoMo can’t do that from here.',
  });
  bare();
  setHomeApi(null);
});

test('Google is signed in on this Mac: the app’s wiring gives the system browser, and with it the Google kinds are registered, without it they are not', async (t) => {
  setHomeApi(null);
  const dir = tmp(t);
  const r = realMachines(t, [{ id: 'studio', name: 'Studio', hostId: STUDIO, up: false }], hostSays(null));
  await r.beat();
  const opened: string[] = [];
  const options = homeOptions(
    r.m,
    { app: { getPath: () => dir }, shell: { openExternal: (u: string) => void opened.push(u) } },
    { safeStorage: safe(), hello: sayHello },
  );
  assert.equal(typeof options.flagOn(), 'boolean', 'the flag is read from the app’s switches');
  assert.equal(typeof options.openExternal, 'function', 'the wiring gives the Google sign-in its browser');
  options.openExternal('https://accounts.example/consent');
  assert.deepEqual(opened, ['https://accounts.example/consent']);
  assert.equal(options.dir, dir);
  options.watch(() => undefined)();
  const wired = startHomeService({ ...options, allowed: () => true, flagOn: () => true, account: () => 'ann' });
  await waitFor(() => getHomeApi(), 'the home');
  const asked: any = await getHomeApi().intent({ kind: 'google', intent: 'remove', client: 'desktop' });
  assert.equal(asked.ok, false);
  assert.notEqual(asked.cause, 'MoMo can’t do that yet.', 'registered: it is a Google intent that needs a home');
  wired();
  setHomeApi(null);
  // without the browser the Google kinds have no handler at all, and the answer says so
  const bare = startHomeService({ ...options, openExternal: undefined, allowed: () => true, flagOn: () => true, account: () => 'ann' });
  await waitFor(() => getHomeApi(), 'the home without Google');
  assert.deepEqual(await getHomeApi().intent({ kind: 'google', intent: 'remove', client: 'desktop' }), {
    ok: false,
    cause: 'MoMo can’t do that yet.',
  });
  bare();
  setHomeApi(null);
});

test('every Host veils MoMo until it is granted: the app sends the grant for the signed-in account to each machine that is up, and then hears the home; a machine that is down is not told', async (t) => {
  setHomeApi(null);
  const dir = tmp(t);
  const granted = new Set<string>();
  const told: { id: string; params: any }[] = [];
  const r = realMachines(
    t,
    [
      { id: 'studio', name: 'Studio', hostId: STUDIO },
      { id: 'mini', name: 'Mac mini', hostId: MINI },
      { id: 'nas', name: 'NAS', up: false },
    ],
    async (id, method, p) => {
      if (method === 'host.momoGrant') {
        granted.add(id);
        told.push({ id, params: p });
        return { granted: true, expiresAt: Date.now() + 7 * 86_400_000 };
      }
      // a Host that has no grant for this client says it does not know the request
      if (!granted.has(id)) throw Object.assign(new Error(`Unknown request: ${method}`), { code: 'unknown_request' });
      return hostSays(RUNNING)(id, method, p);
    },
  );
  await r.beat();
  const stop = start({ machines: r.m, dir });
  await waitFor(() => getHomeApi(), 'the home');
  await waitFor(() => granted.size === 2, 'the grants to be sent');
  assert.deepEqual(told.map((x) => x.id).sort(), ['mini', 'studio'], 'a machine that is down is not told');
  assert.deepEqual(told[0]!.params, { account: 'ann', features: ['momo'] });
  // the look that came after the grants hears the Studio's home: no longer a veil
  await waitFor(async () => (((await getHomeApi().view()) as any).view.home.leaseEpoch ?? 0) === 3, 'the home to be heard after the grant');
  stop();
  setHomeApi(null);
});
