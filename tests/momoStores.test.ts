// MoMo's data stores for Reset (electron/momo/stores.cjs) and main's momoReset:run (electron/app/ipc/momoReset.cjs): every store deleted in order even after one fails, one this build has none for said as not reset, MoMo paused first and kept paused (its settings too) when something failed, one run at a time, refused while MoMo is off. The invariant that every MoMo store registers is tests/momoStoresInvariant.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const stores = require('../electron/momo/stores.cjs');
const { registerMomoStore, resetMomoStores, memoryFilesReset, folderReset, removeFeedAndTopicFiles, momoResetting, whileResetting } =
  stores;
const { register } = require('../electron/app/ipc/momoReset.cjs');

test('stores are deleted in order, each after another failed; one with nothing registered is not reset; registration rules', async () => {
  const done: string[] = [];
  const offs = [
    registerMomoStore('memory', () => void done.push('memory')),
    registerMomoStore('sources', async () => {
      done.push('sources');
      throw new Error('disk');
    }),
    registerMomoStore('audit', async () => void done.push('audit')),
  ];
  const errors: string[] = [];
  const r = await resetMomoStores({ onError: (id: string, e: any) => errors.push(`${id}: ${e.message}`) });
  assert.deepEqual(done, ['memory', 'sources', 'audit']);
  assert.deepEqual(
    r.reset.map((s: any) => s.id),
    ['memory', 'audit'],
  );
  assert.deepEqual(
    r.notReset.map((s: any) => [s.id, s.reason]),
    [
      ['sources', 'failed'],
      ['connectors', 'absent'],
      ['routines', 'absent'],
      ['approvals', 'absent'],
      ['history', 'absent'],
      ['chats', 'absent'],
    ],
  );
  assert.deepEqual(errors, ['sources: disk']);
  // a later registration replaces the default; an old unregister leaves the new one
  const newer = async () => void done.push('memory 2');
  registerMomoStore('memory', newer);
  offs[0]();
  done.length = 0;
  await resetMomoStores();
  assert.ok(done.includes('memory 2'));
  for (const off of offs) off();
  assert.throws(() => registerMomoStore('nope', () => {}), /Not a MoMo store: nope/);
  assert.throws(() => registerMomoStore('approvals', 'x'), /needs a reset/);
});

test('memory’s reset deletes its files and the copies of unreadable ones, once queued writes settle, and nothing else', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-mem-'));
  for (const f of [
    'about-you.md',
    'persona.md',
    'facts.jsonl',
    'changes.jsonl',
    'memory-pass.json',
    'memory-pass.json.lock',
    'background-tokens.json',
    'background-tokens.json.lock',
    'fact-aliases.json',
    'fact-aliases.json.lock',
    'fact-aliases.json.unreadable-17-3',
    'persona.md.unreadable-17',
    'facts.jsonl.unreadable-17-2',
    'audit.key',
    'notes.md',
  ])
    fs.writeFileSync(path.join(dir, f), 'x');
  const order: string[] = [];
  await memoryFilesReset(dir, { idle: async () => void order.push('idle') })();
  assert.deepEqual(order, ['idle']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['audit.key', 'notes.md']);
  // no folder: nothing was kept; another failure is thrown
  await memoryFilesReset(path.join(dir, 'none'))();
  const eacces = Object.assign(new Error('EACCES'), { code: 'EACCES' });
  await assert.rejects(
    memoryFilesReset(dir, {
      fs: {
        readdirSync: () => {
          throw eacces;
        },
        rmSync: () => {},
      } as any,
    })(),
    /EACCES/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a folder store’s reset deletes its whole folder once queued writes settle; a reset in progress is known', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-folder-'));
  fs.mkdirSync(path.join(dir, 'files'));
  const order: string[] = [];
  await folderReset(dir, { idle: async () => void order.push('idle') })();
  assert.deepEqual(order, ['idle']);
  assert.equal(fs.existsSync(dir), false);
  await folderReset(dir)();
  assert.equal(momoResetting(), false);
  const during = await whileResetting(async () => momoResetting());
  assert.equal(during, true);
  await assert.rejects(
    whileResetting(async () => {
      throw new Error('x');
    }),
  );
  assert.equal(momoResetting(), false, 'over whichever way it ended');
});

test('the removed Feed’s and Topics’ files are deleted and nothing else; no folder is fine; other errors are thrown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-removed-'));
  const keep = ['routines.json', 'state.json', 'facts.jsonl', 'about-you.md', 'feed.txt', 'myfeed.json', 'topics.json', 'approvals.bin'];
  for (const f of [...keep, 'feed.json', 'feed.json.lock', 'feed.json.unreadable-1700000000000', 'feed.json.unreadable-17-2'])
    fs.writeFileSync(path.join(dir, f), 'x');
  for (const folder of ['topics', 'sources', 'audit']) {
    fs.mkdirSync(path.join(dir, folder));
    fs.writeFileSync(path.join(dir, folder, 'a.json'), 'x');
  }
  removeFeedAndTopicFiles(dir);
  assert.deepEqual(fs.readdirSync(dir).sort(), [...keep, 'audit', 'sources'].sort());
  assert.deepEqual(fs.readdirSync(path.join(dir, 'sources')), ['a.json'], 'what is kept is kept whole');
  // nothing left to delete: again is fine
  removeFeedAndTopicFiles(dir);
  assert.equal(fs.readdirSync(dir).length, keep.length + 2);
  // no folder: nothing was ever kept
  removeFeedAndTopicFiles(path.join(dir, 'none'));
  // any other failure is thrown, for the caller to note
  const eacces = Object.assign(new Error('EACCES'), { code: 'EACCES' });
  assert.throws(
    () =>
      removeFeedAndTopicFiles(dir, {
        fs: {
          readdirSync: () => {
            throw eacces;
          },
          rmSync: () => {},
        } as any,
      }),
    /EACCES/,
  );
  assert.throws(
    () =>
      removeFeedAndTopicFiles(dir, {
        fs: {
          readdirSync: () => {
            throw 'plain';
          },
          rmSync: () => {},
        } as any,
      }),
    (e: unknown) => e === 'plain',
  );
  // a file it can't delete is thrown too, after the ones before it went
  const removed: string[] = [];
  assert.throws(
    () =>
      removeFeedAndTopicFiles(dir, {
        fs: {
          readdirSync: () => ['feed.json', 'topics', 'state.json'],
          rmSync: (f: string, o: any) => {
            removed.push(`${path.basename(f)}${o.recursive ? '/' : ''}`);
            if (path.basename(f) === 'topics') throw eacces;
          },
        } as any,
      }),
    /EACCES/,
  );
  assert.deepEqual(removed, ['feed.json', 'topics/']);
  fs.rmSync(dir, { recursive: true, force: true });
});

function setup(o: { allowed?: boolean; save?: (set: any) => boolean } = {}) {
  const handlers = new Map<string, any>();
  let state: any = { prefs: { momo: { brain: { main: { harness: 'claude' } }, routines: { proactivity: 'high' } } } };
  const writes: any[] = [];
  const live: any = {
    patchPrefs: (set: any) => {
      writes.push(set.momo);
      if (o.save && !o.save(set)) return false;
      state = { prefs: { ...state.prefs, ...set } };
      return true;
    },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-reset-'));
  fs.writeFileSync(path.join(dir, 'facts.jsonl'), 'x');
  // the sources hub's copies
  fs.mkdirSync(path.join(dir, 'sources', 'calendar'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sources', 'calendar', 'events.bin'), 'x');
  const allowed = { on: o.allowed ?? true };
  register(
    { handle: (ch: string, fn: any) => void handlers.set(ch, fn) },
    { readState: () => state, live },
    { allowed: () => allowed.on, memoryDir: dir },
  );
  return { run: () => handlers.get('momoReset:run')({}), writes, allowed, live, dir, momo: () => state.prefs.momo };
}

test('momoReset:run pauses MoMo first, deletes every store, then resets the settings; what it can’t reach is said', async () => {
  const h = setup();
  const r = await h.run();
  assert.deepEqual(
    h.writes[0],
    { brain: { main: { harness: 'claude' } }, routines: { proactivity: 'high' }, paused: true },
    'paused first',
  );
  assert.deepEqual(fs.readdirSync(h.dir), [], 'memory and the sources’ copies deleted');
  assert.deepEqual(h.momo(), {}, 'settings back to defaults, the main chat’s brain too: not paused, setup shown again');
  assert.deepEqual(r.value.reset, [
    { id: 'memory', label: "MoMo's memory" },
    { id: 'sources', label: 'its copies of your sources and the files it made' },
    { id: 'connectors', label: 'connected accounts' },
    { id: 'settings', label: 'its settings' },
  ]);
  assert.deepEqual(
    r.value.notReset.map((s: any) => [s.id, s.reason]),
    ['routines', 'approvals', 'audit', 'history', 'chats'].map((id) => [id, 'absent']),
  );
});

test('momoReset:run with nothing of MoMo’s saved yet: paused, then reset', async () => {
  const h = setup();
  h.live.patchPrefs({ momo: undefined });
  h.writes.length = 0;
  await h.run();
  assert.deepEqual(h.writes[0], { paused: true });
});

test('momoReset:run: a store that fails keeps MoMo paused and its settings; one run at a time; refusals', async () => {
  const h = setup();
  const off = registerMomoStore('sources', async () => {
    throw new Error('locked');
  });
  const r = await h.run();
  off();
  assert.equal(h.momo().paused, true, 'still paused');
  assert.equal(h.momo().routines.proactivity, 'high', 'settings kept');
  assert.deepEqual(
    r.value.notReset.find((s: any) => s.id === 'settings'),
    { id: 'settings', label: 'its settings', reason: 'failed' },
  );
  assert.equal(r.value.notReset.find((s: any) => s.id === 'sources').reason, 'failed');

  // two asks while one runs share it
  let release: () => void = () => {};
  const offSlow = registerMomoStore('routines', () => new Promise<void>((res) => (release = res)));
  const a = h.run();
  const b = h.run();
  await new Promise((res) => setTimeout(res, 0));
  release();
  const [ra, rb] = await Promise.all([a, b]);
  offSlow();
  assert.deepEqual(ra, rb);
  assert.equal(h.writes.filter((w: any) => w?.paused === true && w.routines).length, 2, 'one pause per run: the first run and this one');

  // settings that won't save after the stores went
  const late = setup({ save: (set) => set.momo.paused === true });
  const rl = await late.run();
  assert.equal(rl.value.notReset.at(-1).id, 'settings');
  // MoMo couldn't be paused: nothing is reset
  const stuck = setup({ save: () => false });
  assert.deepEqual(await stuck.run(), { error: { message: "Couldn't pause MoMo, so nothing was reset.", code: 'save_failed' } });
  assert.deepEqual(fs.readdirSync(stuck.dir).sort(), ['facts.jsonl', 'sources']);
  // MoMo off for the account
  const no = setup({ allowed: false });
  assert.deepEqual(await no.run(), { error: { message: 'MoMo is not available.', code: 'not_allowed' } });
  assert.deepEqual(no.writes, []);
  // main before chats registered: no writer yet
  const early = setup();
  delete early.live.patchPrefs;
  assert.equal((await early.run()).error.code, 'save_failed');
  // a thrown non-Error still comes back as a message
  const handlers = new Map<string, any>();
  register(
    { handle: (ch: string, fn: any) => void handlers.set(ch, fn) },
    {
      readState: () => {
        throw 'disk';
      },
      live: { patchPrefs: () => true },
    },
    { allowed: () => true, memoryDir: os.tmpdir() },
  );
  assert.deepEqual(await handlers.get('momoReset:run')({}), { error: { message: 'disk', code: null } });
  // the real gate by default: closed in a test run
  const real = new Map<string, any>();
  register(
    { handle: (ch: string, fn: any) => void real.set(ch, fn) },
    { app: { getPath: () => os.tmpdir() }, readState: () => ({}), live: {} },
  );
  assert.equal((await real.get('momoReset:run')({})).error.code, 'not_allowed');
});

test('MoMo’s one folder is in the app’s data folder', () => {
  assert.equal(stores.momoDir('/data/MoPilot'), path.join('/data/MoPilot', 'momo'));
});
