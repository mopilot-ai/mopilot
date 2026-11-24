// What a repair of damaged link state (and a start still landing) must keep: no start is unrecorded under another, a removal waits for starts and stops what ran, the highest lease seen stays as a floor, a readable file is never set aside, and the copies kept are few (host/src/homeGate.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// @ts-ignore: plain ESM without declarations
import { createHomeGate } from '../host/src/homeGate.mjs';
import { tmpDir } from './support/hostClientsWorld.ts';

process.env.MOPILOT_MOMO_HOST_LINK = '1';
const fp = (c: string) => c.repeat(64);
const stamp = (leaseEpoch: number) => ({ homeId: 'home-a', leaseEpoch });
const HOME = { fingerprint: fp('a'), name: 'MoMo', kind: 'home' };
const start = (chatId: string, key = 'key-00000001', epoch = 1) => ({
  chatId,
  epoch,
  key,
  text: 't',
  harness: 'claude',
  permission: 'default',
  home: stamp(epoch),
});

function world(t: any) {
  const dir = tmpDir(t);
  const sessions = new Set<string>();
  const stopped: string[] = [];
  const notes: any[] = [];
  const clock = { at: Date.now() };
  const registered = new Set([fp('a'), fp('b')]);
  const make = () =>
    createHomeGate({
      configDir: path.join(dir, 'config'),
      workDir: path.join(dir, 'work'),
      knows: (f: string) => registered.has(f),
      known: (id: string) => sessions.has(id),
      stop: async (id: string) => void stopped.push(id),
      report: () => undefined,
      now: () => clock.at,
      cap: 1000,
      enabled: () => true,
      active: () => false,
      modeOf: () => undefined,
      settleMs: 0,
      audit: { note: (e: any) => void notes.push(e) },
    });
  return { clock, dir, sessions, stopped, notes, make, registered, file: path.join(dir, 'config', 'home-link.json') };
}

test('a refused replay does not unrecord the start before it, and the removal stops the session that landed', async (t) => {
  const w = world(t);
  const gate = w.make();
  const id = 'claude:11111111-1111-4111-8111-111111111111';
  await gate.admit(HOME, 'chat.start', start(id));
  const first = gate.landing(fp('a'), id);
  await gate.admit(HOME, 'chat.start', start(id, 'key-00000002'));
  const replay = gate.landing(fp('a'), id);
  await replay(false);
  assert.deepEqual(gate.startedBy(id), { kind: 'momo', home: 'MoMo' }, 'still recorded');
  w.sessions.add(id);
  await first(true);
  assert.equal(await gate.revoke(fp('a')), 1);
  assert.deepEqual([...new Set(w.stopped)], [id], 'the landed session is stopped with its home');
});

test('a removal waits for a start the protocol is still working on, and stops what lands', async (t) => {
  const w = world(t);
  const gate = w.make();
  const id = 'claude:22222222-2222-4222-8222-222222222222';
  await gate.admit(HOME, 'chat.start', start(id));
  const landing = gate.landing(fp('a'), id);
  let done = false;
  const removal = gate.revoke(fp('a')).then((n: number) => ((done = true), n));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(done, false, 'it waits');
  w.sessions.add(id);
  await landing(true);
  assert.equal(await removal, 1);
  assert.deepEqual([...new Set(w.stopped)], [id]);
});

test('a repair keeps the highest lease seen as a floor nobody holds, and an unreadable floor is a lease nobody can name', async (t) => {
  const w = world(t);
  const gate = w.make();
  await gate.admit(HOME, 'host.hello', { home: stamp(2) });
  const b = { ...HOME, fingerprint: fp('b') };
  fs.writeFileSync(w.file, '{damaged');
  const after = w.make();
  assert.equal(after.health(), 'unreadable');
  assert.equal(await after.repair(), true);
  assert.deepEqual(after.newest(), { homeId: 'home-a', leaseEpoch: 2, by: null, was: null });
  // a key allowed again cannot take it above the floor, and at it does not become the holder
  await assert.rejects(after.admit(b, 'host.hello', { home: stamp(3) }), (e: any) => e.code === 'home_lease_unassigned');
  await after.admit(b, 'host.hello', { home: stamp(2) });
  assert.equal(after.newest()?.by, null);
  // an owner names a holder, and the lease moves from there
  assert.equal(await after.successor(fp('b'), 'floor'), true);
  await after.admit(b, 'host.hello', { home: stamp(3) });
  // the floor file itself damaged too: nothing above nothing until an owner names a holder
  fs.writeFileSync(w.file, '{damaged');
  fs.writeFileSync(path.join(w.dir, 'config', 'home-floor.json'), '{damaged');
  const blind = w.make();
  assert.equal(await blind.repair(), true);
  await assert.rejects(blind.admit(b, 'host.hello', { home: stamp(1) }), (e: any) => e.code === 'home_lease_unassigned');
  assert.equal(await blind.successor(fp('b'), 'floor'), true);
  await blind.admit(b, 'host.hello', { home: stamp(40) });
});

test('a repair judges the file when it is called: a file put right since is left alone, a junk one is repaired before anything read it', async (t) => {
  const w = world(t);
  const gate = w.make();
  await gate.admit(HOME, 'chat.start', start('claude:33333333-3333-4333-8333-333333333333'));
  const healthy = fs.readFileSync(w.file);
  fs.writeFileSync(w.file, '{damaged');
  const seen = w.make();
  assert.equal(seen.health(), 'unreadable');
  fs.writeFileSync(w.file, healthy);
  assert.equal(await seen.repair(), false);
  assert.equal(seen.health(), 'ok');
  assert.ok(fs.existsSync(w.file), 'the healthy file is where it was');
  assert.equal(fs.readdirSync(path.dirname(w.file)).filter((f) => f.includes('damaged-')).length, 0);
  assert.equal(w.notes.length, 0);
  // junk that nothing has read yet is judged by the repair itself
  fs.writeFileSync(w.file, '{damaged');
  assert.equal(await w.make().repair(), true);
  assert.equal(w.notes.at(-1).kind, 'lease.repaired');
});

test('a repair stops what still runs under the task folder, says so in the audit line, and keeps few copies', async (t) => {
  const w = world(t);
  const gate = w.make();
  const id = 'claude:44444444-4444-4444-8444-444444444444';
  await gate.admit(HOME, 'chat.start', start(id));
  w.sessions.add(id);
  const config = path.dirname(w.file);
  fs.writeFileSync(w.file, '{damaged');
  for (let i = 0; i < 8; i++) {
    for (const kind of ['damaged', 'unreadable']) {
      const f = path.join(config, `home-link.json.${kind}-${i}`);
      fs.writeFileSync(f, 'x');
      fs.utimesSync(f, 1000 + i, 1000 + i);
    }
  }
  const after = w.make();
  // the home's key is removed while the state is damaged: nothing can be stopped by name
  w.registered.delete(fp('a'));
  await assert.rejects(after.revoke(fp('a')), (e: any) => e.code === 'home_state_unreadable');
  assert.deepEqual(w.stopped, []);
  assert.equal(await after.repair(), true);
  assert.deepEqual(w.stopped, [id]);
  assert.equal(w.notes.at(-1).what.outcome, 'stopped 1, unverified 0');
  for (const kind of ['damaged', 'unreadable']) {
    const kept = fs.readdirSync(config).filter((f) => f.startsWith(`home-link.json.${kind}-`));
    assert.ok(kept.length <= 5, `${kind}: ${kept.length}`);
  }
  assert.ok(fs.existsSync(path.join(config, 'home-link.json.damaged-7')), 'the newest are the ones kept');
});

test("a marker planted in the work folder stops nothing: only the Host's own, under its folder name, is believed", async (t) => {
  const w = world(t);
  const gate = w.make();
  const mine = 'claude:55555555-5555-4555-8555-555555555555';
  const owners = 'claude:66666666-6666-4666-8666-666666666666';
  await gate.admit(HOME, 'chat.start', start(mine));
  w.sessions.add(mine);
  w.sessions.add(owners);
  const work = path.join(w.dir, 'work');
  const hash = (id: string) => crypto.createHash('sha256').update(id).digest('hex').slice(0, 32);
  // planted: the right name and folder, no proof; and a real marker copied under another chat's name
  fs.mkdirSync(path.join(work, hash(owners)));
  fs.writeFileSync(path.join(work, `${hash(owners)}.chat`), owners);
  fs.writeFileSync(path.join(work, 'copy.chat'), fs.readFileSync(path.join(work, `${hash(mine)}.chat`)));
  fs.writeFileSync(path.join(work, `${hash(owners)}.chat`), `${owners}\n${'0'.repeat(64)}`);
  fs.writeFileSync(w.file, '{damaged');
  assert.equal(await w.make().repair(), true);
  assert.deepEqual(w.stopped, [mine], "the owner's own chat is not stopped");
});

test("a start whose protocol call never answers stops counting after ten minutes, and the floor file's copies are kept few too", async (t) => {
  const w = world(t);
  const gate = w.make();
  const id = 'claude:77777777-7777-4777-8777-777777777777';
  await gate.admit(HOME, 'chat.start', start(id));
  gate.landing(fp('a'), id); // never ends
  await gate.admit(HOME, 'chat.start', start(id, 'key-00000002'));
  await gate.landing(fp('a'), id)(false);
  assert.ok(gate.startedBy(id), 'the first is still counted');
  w.clock.at += 11 * 60_000;
  await gate.admit(HOME, 'chat.start', start(id, 'key-00000003'));
  await gate.landing(fp('a'), id)(false);
  assert.equal(gate.startedBy(id), null, 'a call that never answered no longer keeps it');
  // the floor file's set-aside copies are trimmed with the state's
  const config = path.dirname(w.file);
  for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(config, `home-floor.json.damaged-${i}`), 'x');
  fs.writeFileSync(w.file, '{damaged');
  assert.equal(await w.make().repair(), true);
  assert.ok(fs.readdirSync(config).filter((f) => f.startsWith('home-floor.json.damaged-')).length <= 5);
});

test('a lost marker key leaves the sessions it could name unverified, and the repair says how many', async (t) => {
  const w = world(t);
  const gate = w.make();
  const id = 'claude:88888888-8888-4888-8888-888888888888';
  await gate.admit(HOME, 'chat.start', start(id));
  w.sessions.add(id);
  fs.rmSync(path.join(path.dirname(w.file), 'home-marker.key'));
  fs.writeFileSync(w.file, '{damaged');
  assert.equal(await w.make().repair(), true);
  assert.deepEqual(w.stopped, [], 'nothing can be named without the key');
  assert.equal(w.notes.at(-1).what.outcome, 'stopped 0, unverified 1');
});
