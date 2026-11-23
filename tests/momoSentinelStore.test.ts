// Where MoMo's sentinel keeps remembered approvals (#2139, electron/momo/sentinel.cjs load/save and sentinelStore.cjs): grants read back and checked, every change written whole, failed writes kept and retried, storage that can't be read never written over (an unreadable file kept aside), answers given before load() finished kept and merged, and the encrypted 0600 file itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeSafe, scratch } from './support/momo-trust.ts';

const require = createRequire(import.meta.url);
const { Sentinel, LEVELS, MAX_REMEMBER, fingerprintOf } = require('../electron/momo/sentinel.cjs');
const { sentinelFileStorage } = require('../electron/momo/sentinelStore.cjs');

const DAY = 24 * 60 * 60 * 1000;
const send = { chatId: 'momo-main', tool: 'mail_send', source: 'mail', kind: 'change', account: 'work', args: { to: 'ann@example.com' } };

/** A sentinel with storage whose askUser answers from `answers` in turn. */
function make(o: { answers?: any[]; storage?: any; now?: number } = {}) {
  const answers = [...(o.answers ?? [])];
  const s = new Sentinel({
    askUser: async () => answers.shift() ?? null,
    allowed: () => true,
    sources: { mail: { level: LEVELS.ASK } },
    storage: o.storage ?? null,
    now: o.now === undefined ? Date.now : () => o.now as number,
  });
  return { s, answers };
}
/** Storage in memory: what was written last, and how many writes. */
function memory(initial: unknown = null) {
  const m = {
    data: initial as any,
    writes: 0,
    read: async () => m.data,
    write: async (d: any) => ((m.data = JSON.parse(JSON.stringify(d))), m.writes++),
  };
  return m;
}

test('remembered approvals load from storage and every change is written whole; unreadable storage leaves none and is never written over', async () => {
  const writes: any[] = [];
  let fail = false;
  const storage = (data: unknown) => ({
    read: async () => data,
    write: async (d: any) => {
      if (fail) throw new Error('disk full');
      writes.push(JSON.parse(JSON.stringify(d)));
    },
  });
  const now = new Date(2026, 9, 23, 10).getTime();
  const fp = fingerprintOf(send);
  const good = {
    id: 'k1',
    effect: 'allow',
    fingerprint: fp,
    scope: '30d',
    createdAt: now,
    expiresAt: now + DAY,
    tool: 'mail_send',
    source: 'mail',
    account: 'work',
    summary: '',
  };
  const stale = { ...good, id: 'k0', expiresAt: now - 1 };
  const { s, answers } = make({
    now,
    storage: storage({
      v: 1,
      grants: [
        good,
        stale,
        null,
        { ...good, id: 'bad1', fingerprint: 'short' },
        { ...good, id: 'bad2', scope: 'once' },
        { ...good, id: 'bad3', expiresAt: now + MAX_REMEMBER + 1 },
        { ...good, id: 'bad4', expiresAt: undefined },
        { ...good, id: 'bad5', scope: 'chat' },
        { ...good, id: 'bad6', effect: 'deny', scope: '30d' },
        { ...good, id: 'bad7', effect: 'maybe' },
        { ...good, id: 'bad8', expiresAt: 'soon' },
        { ...good, id: '' },
      ],
    }),
  });
  await s.load();
  assert.deepEqual(
    s.list().map((g: any) => g.id),
    ['k1'],
  );
  await s.idle();
  assert.deepEqual(
    writes.at(-1).grants.map((g: any) => g.id),
    ['k1'],
    'the expired one was swept and written away',
  );
  assert.equal((await s.decide(send)).via, 'remembered');
  // two answers in a row: both end up in what was written last
  answers.push({ allow: true, scope: 'today' }, { allow: true, scope: '30d' });
  const [a, b] = await Promise.all([s.decide({ ...send, args: { a: 1 } }), s.decide({ ...send, args: { b: 2 } })]);
  assert.deepEqual([a.persisted, b.persisted], [true, true]);
  assert.equal(writes.at(-1).grants.length, 3);
  // a write that fails: the run can't be stored, so the send is refused and nothing is remembered; the next write carries everything
  fail = true;
  answers.push({ allow: true, scope: '30d' });
  assert.equal((await s.decide({ ...send, args: { c: 3 } })).reason, 'storage');
  assert.match(String(s.writeError), /disk full/);
  fail = false;
  s.revoke('k1');
  await s.idle();
  assert.equal(writes.at(-1).grants.length, 2);
  assert.equal(s.writeError, null);

  for (const data of [Promise.reject(new Error('cannot decrypt')), { v: 2, grants: [] }, { v: 1, grants: {} }, []]) {
    const w: any[] = [];
    const r = make({ storage: { read: async () => data, write: async (d: any) => w.push(d) }, answers: [{ allow: true, scope: 'once' }] });
    await r.s.load();
    assert.ok(r.s.loadError, 'the failure is kept');
    assert.equal((await r.s.decide(send)).reason, 'storage', 'refused before any card: a stored deny always or uncertain run is unknown');
    assert.equal((await r.s.decide({ ...send, kind: 'read', egress: undefined })).via, 'read', 'a read that sends nothing still runs');
    await r.s.idle();
    assert.deepEqual(w, [], 'nothing written over storage that could not be read');
  }
  const empty = make({ storage: storage(null) });
  await empty.s.load();
  assert.equal(empty.s.loadError, null);
  await make().s.load();
});

test('decide() waits for the read; a read that failed is tried again, and once it succeeds what was answered meanwhile is merged and written', async () => {
  const fp = fingerprintOf({ ...send, args: { to: 'eve@example.com' } });
  const denied = {
    id: 'd1',
    effect: 'deny',
    fingerprint: fp,
    scope: 'always',
    createdAt: 1,
    tool: 'mail_send',
    source: 'mail',
    account: '',
    summary: '',
  };
  let release: (v: unknown) => void = () => {};
  const store = memory();
  store.read = () => new Promise((r) => (release = r));
  const { s, answers } = make({ storage: store });
  const deciding = s.decide({ ...send, args: { to: 'eve@example.com' } });
  release({ v: 1, grants: [denied, { ...denied }] });
  assert.equal((await deciding).reason, 'deny-always', 'decided with what storage held, not before');
  // the Keychain is locked at first: every change asks once, a deny always given then is kept and written once it opens
  let locked = true;
  const later = memory({ v: 1, grants: [denied] });
  const read = later.read;
  later.read = async () => (locked ? Promise.reject(Object.assign(new Error('locked'), { code: 'unreadable' })) : read());
  const k = make({ storage: later, answers: [{ allow: true, scope: 'once' }] });
  assert.equal((await k.s.decide({ ...send, args: { to: 'eve@example.com' } })).reason, 'storage');
  assert.equal(later.writes, 0);
  // the user revokes the deny always before the Keychain opens: once it does, the stored one doesn't come back
  k.s.revoke('d1');
  locked = false;
  assert.equal((await k.s.decide({ ...send, args: { to: 'eve@example.com' } })).via, 'asked', 'the next decide reads again');
  await k.s.idle();
  assert.deepEqual(later.data.grants, []);
  assert.equal(k.s.loadError, null);
  // two decides at once share one read
  let reads = 0;
  const shared = memory();
  shared.read = async () => (reads++, null);
  const t = make({ storage: shared, answers: [null, null] });
  await Promise.all([t.s.decide(send), t.s.decide(send)]);
  assert.equal(reads, 1);
  void answers;
});

test('remembered approvals live in one encrypted 0600 file in a 0700 folder and come back in a new sentinel', async () => {
  const safe = fakeSafe();
  const file = path.join(scratch(), 'momo', 'approvals.bin');
  const make = () =>
    new Sentinel({
      askUser: async () => ({ allow: true, scope: '30d' }),
      allowed: () => true,
      sources: { mail: { level: 'ask' } },
      storage: sentinelFileStorage({ file, safeStorage: safe }),
    });
  const a = make();
  await a.load();
  assert.equal(a.loadError, null, 'no file yet is no approvals, not a failure');
  assert.equal((await a.decide(send)).persisted, true);
  // the send went through; a run never reported would count as uncertain after a restart
  a.noteOutcome(send.chatId, fingerprintOf(send), 'done');
  await a.idle();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /mail_send/);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['approvals.bin', 'approvals.bin.lock'], 'no temporary file left');
  await a.storage.close();
  const b = make();
  await b.load();
  assert.equal((await b.decide(send)).via, 'remembered');
  await b.idle();
  await b.storage.close();
  // a file that can't be decrypted is a load failure, never an empty list, and left as it is until the user sets it aside
  fs.writeFileSync(file, 'tampered');
  const c = make();
  await c.load();
  assert.equal(c.loadError.code, 'unreadable');
  assert.equal((await c.decide(send)).reason, 'storage');
  await c.idle();
  assert.equal(fs.readFileSync(file, 'utf8'), 'tampered', 'never written over');
  const keptAs = await c.setAsideStored();
  assert.match(keptAs, /approvals\.bin\.unreadable-\d+$/);
  assert.equal(fs.readFileSync(keptAs, 'utf8'), 'tampered');
  assert.equal((await c.decide({ ...send, args: { n: 2 } })).persisted, true, 'empty from then on, and written');
  assert.equal(await c.storage.setAside().then(() => 'again'), 'again', 'setting aside twice is fine');
  await c.close();
  fs.rmSync(keptAs);
  const bare = sentinelFileStorage({ file: path.join(scratch(), 'none', 'approvals.bin'), safeStorage: safe });
  assert.match(await bare.setAside(), /unreadable/, 'no file: nothing moved, still fine');
  await bare.close();
  assert.equal(
    await new Sentinel({ askUser: async () => null, storage: memory() }).setAsideStored(),
    null,
    'a store that cannot set aside',
  );
  assert.equal(await new Sentinel({ askUser: async () => null }).setAsideStored(), null, 'no storage: nothing to set aside');
  // a second owner of the folder is refused
  const first = sentinelFileStorage({ file, safeStorage: safe });
  await first.read();
  await assert.rejects(
    sentinelFileStorage({ file, safeStorage: safe, lock: { pid: 99, isAlive: () => true } }).read(),
    (e: any) => e.code === 'locked',
  );
  await first.close();
  await first.close();

  safe.available = false;
  const off = sentinelFileStorage({ file, safeStorage: safe });
  await assert.rejects(off.read(), { code: 'unavailable' });
  await assert.rejects(off.write({ v: 1, grants: [] }), { code: 'unavailable' });
  const throwing = sentinelFileStorage({
    file,
    safeStorage: {
      isEncryptionAvailable: () => {
        throw new Error('x');
      },
    } as any,
  });
  await assert.rejects(throwing.read(), { code: 'unavailable' });
  assert.throws(() => sentinelFileStorage({ file: 'rel', safeStorage: safe }), /absolute file/);

  // a failed rename removes its temporary file; a read error other than a missing file is the error
  safe.available = true;
  const broken = sentinelFileStorage({
    file,
    safeStorage: safe,
    lock: { pid: 77, isAlive: () => false },
    fs: {
      ...fsp,
      rename: async () => Promise.reject(new Error('EXDEV')),
      readFile: async () => Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' })),
    } as any,
  });
  await assert.rejects(broken.write({ v: 1, grants: [] }), /EXDEV/);
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp')),
    [],
  );
  await assert.rejects(broken.read(), { code: 'EACCES' });
  await assert.rejects(
    sentinelFileStorage({
      file,
      safeStorage: safe,
      lock: { pid: 78, isAlive: () => false },
      fs: {
        ...fsp,
        rename: async (from: string, to: string) =>
          to.includes('.unreadable-') ? Promise.reject(Object.assign(new Error('EBUSY'), { code: 'EBUSY' })) : fsp.rename(from, to),
      } as any,
    }).setAside(),
    { code: 'EBUSY' },
  );
});

test('revoke all and clearing a chat before storage could be read stay done once it is read', async () => {
  const now = Date.now();
  const grant = (id: string, extra = {}) => ({
    id,
    effect: 'allow',
    fingerprint: 'a'.repeat(64),
    scope: '30d',
    createdAt: now,
    expiresAt: now + DAY,
    tool: 't',
    source: 'mail',
    account: '',
    summary: '',
    ...extra,
  });
  const held = {
    v: 1,
    grants: [grant('g1'), grant('c1', { scope: 'chat', chatId: 'momo-main' }), grant('c2', { scope: 'chat', chatId: 'momo-other' })],
    taint: { 'momo-main': ['mail'] },
  };
  for (const step of ['all', 'chat'] as const) {
    let locked = true;
    const store = memory(JSON.parse(JSON.stringify(held)));
    const read = store.read;
    store.read = async () => (locked ? Promise.reject(Object.assign(new Error('locked'), { code: 'unreadable' })) : read());
    const { s } = make({ storage: store });
    await s.load();
    if (step === 'all') assert.equal(s.revokeAll(), 0, 'nothing in memory yet, but it is remembered');
    else s.clearChat('momo-main');
    locked = false;
    await s.load();
    await s.idle();
    const ids = s
      .list()
      .map((g: any) => g.id)
      .sort();
    assert.deepEqual(ids, step === 'all' ? [] : ['c2', 'g1'], step);
    assert.deepEqual(s.taintOf('momo-main'), step === 'all' ? ['mail'] : []);
    assert.deepEqual(store.data.grants.map((g: any) => g.id).sort(), ids, 'and written');
  }
});
