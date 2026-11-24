// The failure paths of the home gate's small parts (host/src/homeGate.mjs, homeGateParts.mjs): a start that ends twice or has no chat id, a stop that fails during a repair, a floor file nobody can read, and a folder of copies that cannot be trimmed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createHomeGate } from '../host/src/homeGate.mjs';
// @ts-ignore
import { createFlight, createMarkers, trimAside } from '../host/src/homeGateParts.mjs';
import { tmpDir } from './support/hostClientsWorld.ts';

process.env.MOPILOT_MOMO_HOST_LINK = '1';
const HOME = { fingerprint: 'a'.repeat(64), name: 'MoMo', kind: 'home' };
const start = (chatId: string) => ({
  chatId,
  epoch: 1,
  key: 'key-00000001',
  text: 't',
  harness: 'claude',
  permission: 'default',
  home: { homeId: 'home-a', leaseEpoch: 1 },
});

function gateIn(t: any, stop: (id: string) => Promise<unknown>, reports: string[]) {
  const dir = tmpDir(t);
  const sessions = new Set<string>();
  const make = () =>
    createHomeGate({
      configDir: path.join(dir, 'config'),
      workDir: path.join(dir, 'work'),
      knows: () => true,
      known: (id: string) => sessions.has(id),
      stop,
      report: (m: string) => void reports.push(m),
      now: () => 5,
      cap: 1000,
      enabled: () => true,
      active: () => false,
      modeOf: () => undefined,
      settleMs: 0,
    });
  return { dir, sessions, make, file: path.join(dir, 'config', 'home-link.json') };
}

test('a start with no chat id is not tracked, and one that ends twice is not counted twice', async () => {
  const flight = createFlight();
  const end = flight.begin('claude:x', 'a'.repeat(64));
  assert.equal(end(), false);
  assert.equal(end(), false, 'a second end finds nothing left');
  const gate = createHomeGate({
    configDir: '/nonexistent/c',
    workDir: '/nonexistent/w',
    knows: () => true,
    known: () => false,
    stop: async () => undefined,
    report: () => undefined,
    now: () => 5,
    cap: 1000,
    enabled: () => true,
    active: () => false,
    modeOf: () => undefined,
    settleMs: 0,
  });
  await gate.landing('a'.repeat(64), 42)(false);
});

test('a stop that fails during a repair is reported and the others still run, with a message or a plain value', async (t) => {
  const reports: string[] = [];
  const stopped: string[] = [];
  const failing = new Set(['claude:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'claude:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']);
  const w = gateIn(
    t,
    async (id) => {
      stopped.push(id);
      if (id.includes('aaaaaaaa')) throw new Error('boom');
      if (failing.has(id)) throw 'plain';
    },
    reports,
  );
  const gate = w.make();
  for (const id of [...failing, 'claude:cccccccc-cccc-4ccc-8ccc-cccccccccccc']) {
    await gate.admit(HOME, 'chat.start', start(id));
    w.sessions.add(id);
  }
  fs.writeFileSync(w.file, '{damaged');
  assert.equal(await w.make().repair(), true);
  assert.equal(stopped.length, 3, 'every session was tried');
  assert.equal(reports.filter((r) => /state was repaired/.test(r)).length, 2);
  assert.ok(reports.some((r) => /boom/.test(r)) && reports.some((r) => /plain/.test(r)));
});

test('a floor file nobody can read makes the repaired state a lease nobody can name', async (t) => {
  const w = gateIn(t, async () => undefined, []);
  const gate = w.make();
  await gate.admit(HOME, 'host.hello', { home: { homeId: 'home-a', leaseEpoch: 3 } });
  // sealed with a key this Host does not have: reading it throws, it is not set aside
  fs.writeFileSync(
    path.join(path.dirname(w.file), 'home-floor.json'),
    JSON.stringify({ enc: 'safe', data: Buffer.from('not made by this key').toString('base64') }),
  );
  fs.writeFileSync(w.file, '{damaged');
  const after = w.make();
  assert.equal(await after.repair(), true);
  assert.deepEqual(after.newest(), { homeId: '-', leaseEpoch: 0, by: null, was: null });
});

test('a marker key made by another start a moment before is the one used', (t) => {
  const dir = tmpDir(t);
  const configDir = path.join(dir, 'config');
  const markers = createMarkers(configDir);
  const real = fs.writeFileSync;
  let raced = false;
  t.mock.method(fs, 'writeFileSync', (file: any, data: any, options: any) => {
    // the key is made by someone else between the read that missed and this write
    if (!raced && String(file).endsWith('home-marker.key')) {
      raced = true;
      real(file, Buffer.alloc(32, 7));
      return real(file, data, options);
    }
    return real(file, data, options);
  });
  fs.mkdirSync(path.join(dir, 'work'), { recursive: true });
  markers.write(path.join(dir, 'work', 'abc'), 'claude:x');
  assert.ok(raced);
  assert.deepEqual(fs.readFileSync(path.join(configDir, 'home-marker.key')), Buffer.alloc(32, 7));
});

test('a folder of set-aside copies that cannot be listed is left as it is', () => {
  assert.doesNotThrow(() => trimAside('/nonexistent/config', ['home-link.json']));
});
