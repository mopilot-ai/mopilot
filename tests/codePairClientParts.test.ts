// The parts of pairing by code on the controlling Mac that are not the run itself (R2b of #5576): the typed code's budget and its file, a count that cannot be written, the words of every ending, and the app wiring (electron/host/codePairBudgets.cjs, codePairClient.cjs, codePairWiring.cjs). The run is tests/codePairClient.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { controlled, fakeStore, rig, serve } from './support/codePairRig.ts';

const require = createRequire(import.meta.url);
const { fileStore, failure, FAILURES } = require('../electron/host/codePairClient.cjs');
const { createTypedCodeBudgets, KEEP_MS } = require('../electron/host/codePairBudgets.cjs');
const { createCodePairWiring } = require('../electron/host/codePairWiring.cjs');

const HASH = crypto.createHash('sha256').update('ABCDEFGH').digest('hex');
const CODE = { hint: 'ABC', secret: 'DEFGH' };

test('the budget of a typed code: one per code however it is typed, kept ten minutes, and written the way it is read back', () => {
  let t = 1_000_000;
  const store = fakeStore();
  const b = createTypedCodeBudgets({ store, now: () => t });
  const one = b.forCode(CODE);
  assert.equal(b.forCode(CODE), one);
  assert.equal(one.begin(), true);
  assert.deepEqual(Object.keys((store.value as any).codes), [HASH]);
  assert.equal(createTypedCodeBudgets({ store, now: () => t }).forCode(CODE).left, 2, 'a restart restores the count');
  t += KEEP_MS - 1;
  assert.equal(createTypedCodeBudgets({ store, now: () => t }).forCode(CODE).left, 2);
  t += 1;
  const fresh = createTypedCodeBudgets({ store, now: () => t });
  assert.equal(fresh.forCode(CODE).left, 3, 'after ten minutes it is a code of a new offer');
  fresh.sweep();
  assert.deepEqual(Object.keys((store.value as any).codes), []);
  assert.equal(store.aside, 0);
});

test('a count that is not exactly a count is a spent code', () => {
  const t = 1_000_000;
  for (const bad of [{ started: 'x', spent: false, at: t }, { started: 1 }, 'junk', null, { started: 9, spent: false, at: t }]) {
    const store = fakeStore({ v: 1, floor: 0, codes: { [HASH]: bad } });
    assert.equal(createTypedCodeBudgets({ store, now: () => t }).forCode(CODE).burned, true, JSON.stringify(bad));
    assert.equal(store.aside, 0, 'the rest of the store is still trusted');
  }
});

test('a store that is not a store of counts is set aside, and no code is believed new for ten minutes', () => {
  let t = 1_000_000;
  for (const junk of [[1], [], 5, 'x', null, true, {}, { v: 2, codes: {} }, { v: 1 }, { v: 1, codes: [] }]) {
    const store = fakeStore(junk);
    const budgets = createTypedCodeBudgets({ store, now: () => t });
    assert.equal(store.aside, 1, JSON.stringify(junk));
    assert.equal(budgets.forCode(CODE).burned, true, 'a code this store does not know is spent while it has no memory');
    // the floor is written, so a restart inside the ten minutes remembers it
    assert.equal((store.value as any).floor, t + KEEP_MS);
    assert.equal(createTypedCodeBudgets({ store, now: () => t + 5 * 60_000 }).forCode(CODE).burned, true);
    // and after it codes work again
    assert.equal(createTypedCodeBudgets({ store, now: () => t + KEEP_MS }).forCode(CODE).left, 3);
  }
  // a store that throws is set aside too, a file that cannot be moved or written does not stop the app, and the floor holds in memory
  const broken = {
    read: () => {
      throw new Error('disk');
    },
    write: () => {
      throw new Error('read-only');
    },
    setAside: () => {
      throw new Error('cannot move');
    },
  };
  const memory = createTypedCodeBudgets({ store: broken, now: () => t });
  assert.equal(memory.forCode(CODE).burned, true);
  t += KEEP_MS;
  assert.equal(
    createTypedCodeBudgets({ store: broken, now: () => t }).forCode(CODE).burned,
    true,
    'a new store that cannot read is paused again',
  );
});

test('a store that cannot be written does not count a run, and the code keeps its place', () => {
  const t = 1_000_000;
  let fail = false;
  const store = {
    ...fakeStore(),
    write: (v: unknown) =>
      fail
        ? (() => {
            throw new Error('full');
          })()
        : void ((store as any).value = v),
  };
  const budget = createTypedCodeBudgets({ store, now: () => t }).forCode(CODE);
  fail = true;
  assert.throws(() => budget.begin(), /full/);
  assert.equal(budget.left, 3);
  fail = false;
  assert.equal(budget.begin(), true);
});

test('a count that cannot be written ends the run before anything goes out, and says so', async () => {
  const r = await serve();
  const host = await controlled(r);
  const t = rig(r);
  t.store.write = () => {
    throw new Error('disk full');
  };
  const res = await t.client.addByCode(host.code);
  host.stop();
  assert.equal(res.code, 'unrecorded');
  assert.equal(res.cause, "Couldn't save this attempt. Try again.");
  assert.equal(t.log.length, 0);
});

test('every ending has a cause and, unless the service is off, a fix; the file store reads, writes and says what is wrong', async () => {
  for (const [code, f] of Object.entries(FAILURES) as [string, any][]) {
    assert.ok(f.cause('Studio').length > 0, code);
    assert.ok(f.cause('Studio').length < 70, `${code} stays short`);
    if (code !== 'off') assert.ok(f.fix?.id && f.fix.label, code);
  }
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-store-'));
  const file = path.join(dir, 's.json');
  const s = fileStore(file);
  assert.equal(s.read(), undefined, 'no file is no store, not a bad one');
  s.write({ a: 1 });
  assert.deepEqual(s.read(), { a: 1 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.writeFileSync(file, '{bad');
  assert.throws(() => s.read());
  // a file that cannot be trusted is moved aside, not deleted, and the next read finds none
  s.setAside();
  assert.equal(s.read(), undefined);
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith('s.json.corrupt-')).length, 1);
  // and through the budgets: a file of junk is set aside on the way in
  await new Promise((r) => setTimeout(r, 5));
  fs.writeFileSync(file, '[1]');
  createTypedCodeBudgets({ store: s, now: () => 1_000_000 });
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith('s.json.corrupt-')).length, 2);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).floor, 1_000_000 + KEEP_MS);
  fs.rmSync(dir, { recursive: true });
});

test('the app wiring: this app’s device key signs for it, the machine is listed with the address it was paired at, and without a relay it is off', async () => {
  const r = await serve();
  const host = await controlled(r);
  const fsx = await import('node:fs');
  const pathx = await import('node:path');
  const osx = await import('node:os');
  const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'cp-wire-'));
  const safe = {
    isEncryptionAvailable: () => true,
    encryptString: (x: string) => Buffer.from(`x${x}`),
    decryptString: (b: Buffer) => b.toString().slice(1),
  };
  const identity = require('../electron/host/pairingClient.cjs').loadIdentity(pathx.join(dir, 'key.json'), safe);
  const key = () => identity;
  // the key signs a pairing proof and nothing else
  assert.throws(() => identity.signCodePair(new TextEncoder().encode('pair\nh_x\nnonce')), /not a pairing proof/);
  assert.throws(() => identity.signCodePair(new Uint8Array(0)), /not a pairing proof/);
  const added: any[] = [];
  const log: string[] = [];
  const relay = {
    url: () => r.wsUrl,
    lane: {
      whenOpen: async () => undefined,
      intend: () => undefined,
      register: async () => undefined,
      settle: () => undefined,
      revoke: async (h: string) => void log.push(h),
    },
    adopt: () => undefined,
    forget: async () => true,
  };
  const wired = createCodePairWiring({
    dir,
    relay,
    registry: { add: (m: any) => void added.push(m) },
    key,
    enabled: () => true,
  });
  const res = await wired.addByCode(host.code);
  host.stop();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(added[0].address, added[0].id);
  assert.equal(added[0].name, 'Studio');
  assert.equal(added[0].socketPath, '');
  assert.equal(added[0].pairedBy, 'code', 'marked as a Mac this one only controls');
  // the name the other Mac is asked to allow is the one this Mac introduces itself with afterwards (no `.local`), so its signed record keeps matching
  assert.equal(host.seen.peerName, require('../electron/host/pairingClient.cjs').deviceName());
  assert.ok(!/\.local$/.test(host.seen.peerName));
  assert.equal(typeof wired.cancel, 'function');
  assert.equal(wired.sweep(), undefined);
  const bare = createCodePairWiring({ dir, relay: null, registry: { add: () => undefined }, key });
  assert.equal((await bare.addByCode('ABCD-EFGH')).code, 'off');
  // the default flag reads host.codePair, off
  const byFlag = createCodePairWiring({ dir, relay, registry: { add: () => undefined }, key });
  assert.equal((await byFlag.addByCode('ABCD-EFGH')).code, 'off');
});

test('waiting between polls leaves no listener on the run’s signal', async () => {
  const { sleepFor } = require('../electron/host/codePairClient.cjs');
  const control = new AbortController();
  let live = 0;
  const add = control.signal.addEventListener.bind(control.signal);
  const remove = control.signal.removeEventListener.bind(control.signal);
  control.signal.addEventListener = ((...a: any[]) => (live++, (add as any)(...a))) as any;
  control.signal.removeEventListener = ((...a: any[]) => (live--, (remove as any)(...a))) as any;
  for (let i = 0; i < 5; i++) await sleepFor(1, control.signal);
  assert.equal(live, 0);
  // and an abort still ends the wait at once
  const waiting = sleepFor(60_000, control.signal);
  control.abort();
  await waiting;
});

test('the machines service offers pairing by code, and answers that it is not available where there is no relay', async (t) => {
  const fsx = await import('node:fs');
  const osx = await import('node:os');
  const pathx = await import('node:path');
  const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'cp-machines-'));
  t.after(() => fsx.rmSync(dir, { recursive: true, force: true }));
  const { createRegistry } = require('../electron/host/registry.cjs');
  const { createMachines } = require('../electron/host/machines.cjs');
  const registry = createRegistry({ file: pathx.join(dir, 'r.json'), status: async () => ({}) });
  let allowed = true;
  const m = createMachines({ dir, allowed: () => allowed, watch: () => undefined, registry, installer: {}, pool: { get: () => ({}) } });
  t.after(() => m.dispose());
  assert.equal((await m.addByCode('ABCD-EFGH')).code, 'off');
  assert.equal(m.cancelAddByCode(), undefined);
  allowed = false;
  await assert.rejects(async () => m.addByCode('ABCD-EFGH'), /not available/);
  // the wiring without a relay: nothing to cancel or sweep
  const bare = createCodePairWiring({ dir, relay: null, registry: { add: () => undefined }, key: () => ({}) });
  assert.equal(bare.cancel(), undefined);
  assert.equal(bare.sweep(), undefined);
});

test('a store whose floor is not a number reads as no floor, and a write that fails after a count leaves that count as it was', () => {
  const t = 1_000_000;
  const store = fakeStore({ v: 1, floor: 'soon', codes: {} });
  const budget = createTypedCodeBudgets({ store, now: () => t }).forCode(CODE);
  assert.equal(store.aside, 0, 'a floor that is not a number is no reason to distrust the counts');
  assert.equal(budget.begin(), true);
  const write = store.write;
  store.write = () => {
    throw new Error('full');
  };
  assert.throws(() => budget.begin(), /full/);
  assert.equal(budget.left, 2, 'the failed count was not taken');
  store.write = write;
  assert.equal(budget.begin(), true);
  assert.equal(budget.left, 1);
});

test('a code that no ending knows reads as the generic failure, never as an error', () => {
  assert.deepEqual(failure('nothing-says-this'), {
    ok: false,
    code: 'nothing-says-this',
    cause: FAILURES.failed.cause(''),
    fix: FAILURES.failed.fix,
  });
});

test('a floor far in the future is cut to ten minutes from the time it is read', () => {
  let t = 1_000_000;
  const store = fakeStore({ v: 1, floor: t * 1000, codes: {} });
  const budgets = createTypedCodeBudgets({ store, now: () => t });
  assert.equal(budgets.forCode(CODE).burned, true, 'inside the ten minutes a code this store does not know is spent');
  t += KEEP_MS;
  assert.equal(budgets.forCode({ hint: 'XYZ', secret: 'DEFGH' }).left, 3, 'and after them it is not');
});
