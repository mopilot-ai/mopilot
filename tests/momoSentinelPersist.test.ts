// MoMo's sentinel (#2139, electron/momo/sentinel.cjs) across time and restarts: a side effect still running counts as uncertain (a retry asks), and taint survives a restart through storage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Sentinel, fingerprintOf } = require('../electron/momo/sentinel.cjs');

const send = {
  chatId: 'momo-main',
  tool: 'mail_send',
  source: 'mail',
  kind: 'change',
  args: { to: 'ann@example.com' },
  egress: { recipients: ['ann@example.com'] },
};
const readMail = { chatId: 'momo-main', tool: 'mail_search', source: 'mail', kind: 'read' };
const fetch = { chatId: 'momo-main', tool: 'web_fetch', source: 'web', kind: 'read', egress: { hosts: ['evil.example'] } };

function make(o: { answers?: any[]; storage?: any } = {}) {
  const answers = [...(o.answers ?? [])];
  const cards: any[] = [];
  const s = new Sentinel({
    askUser: async (card: any) => (cards.push(card), answers.shift() ?? null),
    allowed: () => true,
    sources: { mail: { level: 'ask', private: true }, web: { level: 'read' } },
    storage: o.storage ?? null,
  });
  return { s, cards, answers };
}
/** Storage in memory: what was written last, and every write. */
function memory(initial: unknown = null) {
  const m = {
    data: initial as any,
    writes: 0,
    read: async () => m.data,
    write: async (d: any) => ((m.data = JSON.parse(JSON.stringify(d))), m.writes++),
  };
  return m;
}

test('while an allowed side effect runs, the same action asks again; its outcome ends that', async () => {
  const { s, cards } = make({ answers: [{ allow: true, scope: '30d' }] });
  const first = await s.decide(send);
  assert.equal(first.via, 'asked');
  // the harness timed the call out, the send is still going, the model tries again
  assert.equal((await s.decide(send)).reason, 'no-answer');
  assert.deepEqual(cards.at(-1).reasons, ['uncertain']);
  s.noteOutcome('momo-main', first.fingerprint, 'done');
  assert.equal((await s.decide(send)).via, 'remembered');
  // two calls decided at once: the second asks
  s.noteOutcome('momo-main', first.fingerprint, 'done');
  const [a, b] = await Promise.all([s.decide(send), s.decide(send)]);
  assert.deepEqual([a.via, b.reason], ['remembered', 'no-answer']);
  // a read that sends data out counts too; a plain read doesn't
  assert.equal((await s.decide(fetch)).via, 'read');
  assert.equal((await s.decide(fetch)).reason, 'no-answer');
  assert.equal((await s.decide({ ...fetch, egress: undefined })).via, 'read');
  assert.equal((await s.decide({ ...fetch, egress: undefined })).via, 'read');
  assert.equal(fingerprintOf(send), first.fingerprint);
});

test('a chat that read private data is still marked after a restart, until it is cleared', async () => {
  const store = memory();
  const before = make({ storage: store });
  await before.s.load();
  await before.s.decide(readMail);
  await before.s.decide(readMail);
  await before.s.idle();
  assert.deepEqual(store.data.taint, { 'momo-main': ['mail'] });
  assert.equal(store.writes, 1, 'the same source again writes nothing');
  const after = make({ storage: store, answers: [{ allow: true, scope: 'once' }] });
  await after.s.load();
  assert.deepEqual(after.s.taintOf('momo-main'), ['mail']);
  assert.equal((await after.s.decide(fetch)).via, 'asked', 'the fetch after the restart asks');
  after.s.clearChat('momo-main');
  await after.s.idle();
  assert.deepEqual(store.data.taint, {});
  // taint that can't be read is left out, the rest kept
  const odd = make({ storage: memory({ v: 1, grants: [], taint: { 'momo-a': ['mail', 3, ''], '': ['mail'], 'momo-b': 'mail' } }) });
  await odd.s.load();
  assert.deepEqual([odd.s.taintOf('momo-a'), odd.s.taintOf('momo-b')], [['mail'], []]);
  const none = make({ storage: memory({ v: 1, grants: [], taint: [] }) });
  await none.s.load();
  assert.deepEqual(none.s.taintOf('momo-main'), []);
});

test('runs are counted: two identical sends in flight keep asking until both are reported', async () => {
  const { s } = make({
    answers: [
      { allow: true, scope: 'once' },
      { allow: true, scope: 'once' },
    ],
  });
  const fp = fingerprintOf(send);
  assert.equal((await s.decide(send)).via, 'asked');
  assert.equal((await s.decide(send)).via, 'asked', 'the user said yes to a second one while the first runs');
  s.noteOutcome('momo-main', fp, 'done');
  assert.equal((await s.decide(send)).reason, 'no-answer', 'one still runs');
  s.noteOutcome('momo-main', fp, 'done');
  // nothing remembered (once): it asks, but no longer for being uncertain
  const { s: t, cards } = make({ answers: [{ allow: true, scope: '30d' }] });
  await t.decide(send);
  t.noteOutcome('momo-main', fp, 'done');
  t.noteOutcome('momo-main', fp, 'done');
  assert.equal((await t.decide(send)).via, 'remembered', 'an extra report never goes below zero');
  assert.equal(cards.length, 1);
});

test('a send still running when the app quit is uncertain after the restart; the stored runs that cannot be read are left out', async () => {
  const store = memory();
  const before = make({ storage: store, answers: [{ allow: true, scope: '30d' }] });
  await before.s.decide(send);
  await before.s.idle();
  const fp = fingerprintOf(send);
  assert.deepEqual(store.data.runs, { 'momo-main': { [fp]: { running: 1, uncertain: 0 } } });
  // the app quits before the outcome is reported
  const after = make({ storage: store, answers: [null, { allow: true, scope: 'once' }] });
  assert.equal((await after.s.decide(send)).reason, 'no-answer');
  assert.deepEqual(after.cards[0].reasons, ['uncertain']);
  assert.equal((await after.s.decide(send)).via, 'asked', 'the user says yes knowing it may have gone');
  after.s.noteOutcome('momo-main', fp, 'done');
  assert.equal((await after.s.decide(send)).via, 'remembered');
  after.s.noteOutcome('momo-main', fp, 'done');
  await after.s.idle();
  assert.deepEqual(store.data.runs, {}, 'every run reported: nothing left');
  // malformed runs are skipped
  const odd = make({
    storage: memory({
      v: 1,
      grants: [],
      runs: { 'momo-a': { [fp]: { running: 'x', uncertain: -1 }, short: { running: 1 }, [`${'b'.repeat(64)}`]: 3 }, '': {}, 'momo-b': [] },
    }),
  });
  await odd.s.load();
  odd.s.noteOutcome('momo-a', fp, 'done');
  await odd.s.close();
});

test('a run is on the disk before decide() allows it: a crash before the write leaves nothing run; storage that cannot be read refuses before a card', async () => {
  const store = memory();
  store.read = async () => Promise.reject(Object.assign(new Error('locked'), { code: 'unreadable' }));
  const { s, cards } = make({ storage: store, answers: [{ allow: true, scope: 'once' }] });
  assert.equal((await s.decide({ ...fetch, chatId: 'momo-fresh' })).reason, 'storage', 'its taint and runs are unknown');
  assert.equal(cards.length, 0);
  assert.equal((await s.decide({ ...readMail, chatId: 'momo-fresh' })).via, 'read', 'a read that sends nothing still runs');
  await s.close();
  await new Sentinel({ askUser: async () => null }).close();
});

test('decide() resolves only after the run was written; if the app dies first, the restarted one knows nothing ran and nothing is allowed twice', async () => {
  const fp = fingerprintOf(send);
  const grant = {
    id: 'k',
    effect: 'allow',
    fingerprint: fp,
    scope: '30d',
    createdAt: Date.now(),
    expiresAt: Date.now() + 1e6,
    tool: 'mail_send',
    source: 'mail',
    account: '',
    summary: '',
  };
  const store = memory({ v: 1, grants: [grant] });
  let release: () => void = () => {};
  const write = store.write;
  (store as any).write = (d: any) => new Promise<void>((r) => (release = () => r(write(d) as any)));
  const { s } = make({ storage: store });
  let allowed = false;
  const deciding = s.decide(send).then((d: any) => (allowed = d.allow));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(allowed, false, 'not allowed while the run is not on the disk');
  // the app dies here: what a restart reads holds no run, and nothing ran
  assert.equal(store.data.runs, undefined);
  release();
  await deciding;
  assert.equal(allowed, true);
  assert.deepEqual(store.data.runs, { 'momo-main': { [fp]: { running: 1, uncertain: 0 } } });
  // a write that fails takes the run back: refused, and the next try is not uncertain
  const failing = memory({ v: 1, grants: [grant] });
  let fail = true;
  const w2 = failing.write;
  failing.write = async (d: any) => (fail ? Promise.reject(new Error('disk full')) : w2(d));
  const f = make({ storage: failing, answers: [{ allow: true, scope: 'once' }] });
  assert.equal((await f.s.decide(send)).reason, 'storage');
  assert.equal((await f.s.decide(fetch)).reason, 'storage', 'a read that sends data out too');
  fail = false;
  assert.equal((await f.s.decide(send)).via, 'remembered', 'the run that never happened is not counted');
  // a yes after an uncertain run whose write fails keeps the earlier uncertain run
  const g = make({
    storage: memory({ v: 1, grants: [], runs: { 'momo-main': { [fp]: { running: 0, uncertain: 1 } } } }),
    answers: [{ allow: true, scope: 'once' }, null],
  });
  const st = (g.s as any).storage;
  const w3 = st.write;
  st.write = async () => Promise.reject(new Error('disk full'));
  assert.equal((await g.s.decide(send)).reason, 'storage');
  st.write = w3;
  assert.equal((await g.s.decide(send)).reason, 'no-answer');
  assert.deepEqual(g.cards.at(-1).reasons, ['uncertain']);
});
