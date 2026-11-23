// Host auto-update (electron/host/autoUpdate.cjs): an older Host reached over ssh is sent the app's build by itself, at most three times per app build (kept on disk), two machines at a time, never a newer or different one, never over the relay or to this Mac's own Host, never while keys rotate, and only while the switch, the gate and the person's setting allow it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { useFakeClock as installFakeClock } from './support/ports/clock.ts';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { createAutoUpdate, triesFile, BACKOFF_MS, MAX_RUNNING, PENDING_MS, GAVE_UP } = require('../electron/host/autoUpdate.cjs');
const { initFlags } = require('../electron/platform/flags.cjs');

/** The app's flags with `host.autoUpdate` set the way the test needs it. */
function flag(on: boolean) {
  initFlags({
    file: '/nonexistent/flags.json',
    url: 'https://x/api/flags',
    channel: () => 'stable',
    version: '0.3.0',
    now: () => 1,
    fetch: async () => {
      throw new Error('offline');
    },
    onChange: () => undefined,
    override: { 'host.autoUpdate': on },
  }).stop();
}

const old = (id: string, more: Record<string, unknown> = {}) => ({ id, status: 'online', hostStale: true, ...more });
const ADDRESSES: Record<string, string> = { ssh: 'me@box', ssh2: 'me@other', ssh3: 'me@third', rel: 'relay:abc', mac: 'local:this' };

function setup(t: any, over: Record<string, any> = {}) {
  const clock = installFakeClock(t, 1_000);
  const sent: string[] = [];
  let build = 'b2';
  let rows: any[] = [];
  let fail: any = false;
  const gate = { allowed: true, on: true };
  let builds = 0;
  const auto = createAutoUpdate({
    registry: { list: () => Object.entries(ADDRESSES).map(([id, address]) => ({ id, address })) },
    rows: () => rows,
    allowed: () => gate.allowed,
    on: () => gate.on,
    appBuild: () => (builds++, build),
    update: async (id: string) => {
      sent.push(id);
      if (fail) throw fail;
    },
    ...over,
  });
  t.after(() => auto.dispose());
  return {
    auto,
    clock,
    sent,
    gate,
    builds: () => builds,
    look: (r: any[]) => ((rows = r), auto.consider()),
    setBuild: (b: string) => (build = b),
    setFail: (f: any) => (fail = f),
  };
}

test('with the switch off nothing is sent, however old the Host is', (t) => {
  flag(false);
  const s = setup(t);
  s.look([old('ssh')]);
  assert.deepEqual(s.sent, []);
});

test('an older Host reached over ssh is updated once; a Host that is current, newer, different, offline, updating, waiting, not paired, on the relay or this Mac is not', (t) => {
  flag(true);
  const s = setup(t);
  s.look([
    { id: 'ssh', status: 'online' },
    old('ssh', { hostNewer: true }),
    old('ssh', { hostDiffers: true }),
    old('ssh', { status: 'offline' }),
    old('ssh', { update: 'running' }),
    old('ssh', { update: 'waiting' }),
    old('ssh', { update: 'failed', updateNeedsPair: true }),
    old('rel'),
    old('mac'),
    old('gone'),
  ]);
  assert.deepEqual(s.sent, [], 'none of those is eligible, and a machine nobody lists is not guessed to be reachable');
  assert.equal(s.builds(), 0, 'the Host tree is not hashed for rows that are not eligible');
  s.look([old('ssh'), old('ssh2')]);
  assert.deepEqual(s.sent, ['ssh', 'ssh2']);
});

test('the gate, the person’s setting, a setting that cannot be read and a key rotation each stop it', async (t) => {
  flag(true);
  const s = setup(t, {
    on: () => {
      throw new Error('no state yet');
    },
  });
  assert.doesNotThrow(() => s.look([old('ssh')]), 'a failing read never throws into the row change');
  const w = setup(t);
  w.gate.allowed = false;
  w.look([old('ssh')]);
  w.gate.allowed = true;
  w.gate.on = false;
  w.look([old('ssh')]);
  w.gate.on = true;
  let finish: () => void = () => undefined;
  const rotation = w.auto.whileHeld(() => new Promise<string>((resolve) => (finish = () => resolve('rotated'))));
  w.look([old('ssh')]);
  assert.deepEqual([s.sent, w.sent], [[], []], 'nothing is updated while keys rotate');
  finish();
  assert.equal(await rotation, 'rotated');
  assert.deepEqual(w.sent, ['ssh'], 'the moment the rotation is over it looks again');
  await assert.rejects(
    w.auto.whileHeld(async () => Promise.reject(new Error('Every machine must be online'))),
    /online/,
  );
  w.look([old('ssh2')]);
  assert.deepEqual(w.sent, ['ssh', 'ssh2'], 'a refused rotation releases the hold too');
});

test('a failed try is repeated after its backoff by itself, three times in all, then left to the row; a new app build starts again', async (t) => {
  flag(true);
  const s = setup(t);
  s.setFail(new Error('no route'));
  const row = old('ssh', { update: 'failed' });
  s.look([row]);
  await waitFor(() => s.sent.length === 1, 'the first try');
  s.look([row]);
  assert.equal(s.sent.length, 1, 'not again inside the first backoff');
  // nothing changes the rows meanwhile: the timer alone brings the next try
  s.clock.advance(BACKOFF_MS[0]);
  await waitFor(() => s.sent.length === 2, 'the second try, by timer');
  s.clock.advance(BACKOFF_MS[1]);
  await waitFor(() => s.sent.length === 3, 'the third try, by timer');
  s.clock.advance(BACKOFF_MS[2]);
  s.look([row]);
  assert.equal(s.sent.length, 3, 'a fourth try is never made for the same build');
  assert.deepEqual(s.auto.decorate({ id: 'ssh' }, { update: 'failed', updateError: 'No route.' }), {
    update: 'failed',
    updateError: `No route. ${GAVE_UP}`,
  });
  assert.deepEqual(s.auto.decorate({ id: 'ssh' }, { update: 'running' }), { update: 'running' }, 'only a failed row says it gave up');
  s.setBuild('b3');
  s.look([row]);
  await waitFor(() => s.sent.length === 4, 'a try for the new build');
  assert.deepEqual(s.auto.decorate({ id: 'ssh' }, { update: 'failed', updateError: 'x' }), { update: 'failed', updateError: 'x' });
});

test('the tries are kept on disk: a restart of the app does not give a Host that never takes the update three more', async (t) => {
  flag(true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-tries-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'host-auto-update.json');
  const first = setup(t, { store: triesFile(file) });
  first.setFail(new Error('no route'));
  const row = old('ssh', { update: 'failed' });
  first.look([row]);
  await waitFor(() => first.sent.length === 1, 'the first try');
  const second = setup(t, { store: triesFile(file) });
  second.look([row]);
  assert.deepEqual(second.sent, [], 'the new run of the app knows the first try and its backoff');
  second.clock.advance(BACKOFF_MS[0]);
  assert.deepEqual(await waitFor(() => second.sent), ['ssh']);
  // a damaged or foreign file is no memory
  fs.writeFileSync(file, '[1,2');
  const third = setup(t, { store: triesFile(file) });
  third.look([row]);
  assert.deepEqual(third.sent, ['ssh']);
  fs.writeFileSync(file, JSON.stringify({ ssh: 5, ok: { build: 'b2', tries: 1, next: 0 } }));
  const fourth = setup(t, { store: triesFile(file) });
  fourth.look([old('ssh')]);
  assert.deepEqual(fourth.sent, ['ssh']);
  fs.writeFileSync(file, '5');
  const fifth = setup(t, { store: triesFile(file) });
  fifth.look([old('ssh')]);
  assert.deepEqual(fifth.sent, ['ssh'], 'a number is no memory either');
  // a file that cannot be written leaves the update going
  fs.writeFileSync(path.join(dir, 'plain'), 'x');
  const blocked = setup(t, { store: triesFile(path.join(dir, 'plain', 'x.json')) });
  blocked.look([old('ssh')]);
  assert.deepEqual(blocked.sent, ['ssh']);
});

test('at most two machines are sent a build at once; the rest wait for one to end', async (t) => {
  flag(true);
  const releases: (() => void)[] = [];
  const calls: string[] = [];
  const s = setup(t, {
    update: (id: string) => {
      calls.push(id);
      return new Promise<void>((resolve) => releases.push(resolve));
    },
  });
  assert.equal(MAX_RUNNING, 2);
  s.look([old('ssh'), old('ssh2'), old('ssh3')]);
  assert.deepEqual(calls, ['ssh', 'ssh2']);
  s.look([old('ssh'), old('ssh2'), old('ssh3')]);
  assert.equal(calls.length, 2, 'a look while two run starts nothing');
  releases[0]();
  await waitFor(() => calls.length === 3, 'the queued machine once one has ended');
  assert.deepEqual(calls, ['ssh', 'ssh2', 'ssh3']);
  releases[1]();
  releases[2]();
});

test('a refusal before anything was sent does not use up a try or its backoff; a removed machine starts from nothing', async (t) => {
  flag(true);
  const s = setup(t);
  s.setFail(Object.assign(new Error('Already updating this machine.'), { code: 'busy' }));
  s.look([old('ssh')]);
  await waitFor(() => s.sent.length === 1, 'the refused try');
  s.setFail(false);
  s.look([old('ssh')]);
  await waitFor(() => s.sent.length === 2, 'a try right after the refusal');
  // a refusal after a real try puts that try's record back, not nothing
  s.clock.advance(BACKOFF_MS[0]);
  s.setFail(Object.assign(new Error('busy'), { code: 'busy' }));
  s.look([old('ssh')]);
  await waitFor(() => s.sent.length === 3, 'the refused retry');
  s.setFail(false);
  s.auto.forget('ssh');
  s.look([old('ssh')]);
  await waitFor(() => s.sent.length === 4, 'a try for a machine that was removed and added again');
});

test('a Host that turns out newer after an attempt began is never sent the app’s build again', async (t) => {
  flag(true);
  const s = setup(t);
  s.setFail(new Error('no ssh'));
  s.look([old('ssh')]);
  await waitFor(() => s.sent.length === 1, 'the first try');
  s.look([old('ssh', { hostStale: undefined, hostNewer: true })]);
  s.clock.advance(BACKOFF_MS[0]);
  s.clock.advance(BACKOFF_MS[1]);
  s.look([old('ssh', { hostStale: undefined, hostNewer: true })]);
  assert.equal(s.sent.length, 1, 'no downgrade, however many looks');
});

test('two Macs of different builds on one Host: the older app leaves the Host alone once the newer one has updated it', (t) => {
  flag(true);
  const older = setup(t);
  const newer = setup(t);
  older.look([old('ssh')]);
  newer.look([old('ssh')]);
  assert.deepEqual([older.sent, newer.sent], [['ssh'], ['ssh']]);
  older.look([old('ssh', { hostStale: undefined, hostNewer: true })]);
  older.clock.advance(BACKOFF_MS[0]);
  newer.look([{ id: 'ssh', status: 'online' }]);
  assert.deepEqual([older.sent.length, newer.sent.length], [1, 1]);
});

test('a build another app staged on a Host is waited for, for half an hour, or for ever when it is this app’s own; the row says it updates when idle', (t) => {
  flag(true);
  const s = setup(t);
  const at = s.clock.now();
  const foreign = { id: 'ssh', hostPending: { build: 'other', since: at } };
  assert.deepEqual(s.auto.decorate(foreign, { hostStale: true }), { hostStale: true, update: 'waiting' });
  assert.deepEqual(
    s.auto.decorate({ id: 'ssh', hostPending: { build: 'b2', since: at } }, {}),
    { update: 'waiting' },
    'the app’s own build',
  );
  assert.deepEqual(s.auto.decorate(foreign, { update: 'failed' }), { update: 'failed' }, 'its own state wins');
  s.clock.advance(PENDING_MS + 1);
  assert.deepEqual(
    s.auto.decorate(foreign, { hostStale: true }),
    { hostStale: true },
    'a staged build that never restarts stops hiding the row',
  );
  assert.deepEqual(
    s.auto.decorate({ id: 'ssh', hostPending: { build: 'b2', since: at } }, {}),
    { update: 'waiting' },
    'this app’s own staged build is waited for however long',
  );
  assert.deepEqual(s.auto.decorate({ id: 'ssh', hostPending: null }, { hostStale: true }), { hostStale: true });
});
