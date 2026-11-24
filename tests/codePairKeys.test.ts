// Pairing two Macs by a code, the protocol layer (shared/host/codePair.mjs, #5576 R2a), part two: the key schedule (each input and what it changes), the proof that a device holds the key it claims, names, the run budgets on both sides, replays of one offer and claim, and where nonces come from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as pubCpace from '../shared/host/cpace.mjs';
import { ED25519_TORSION_SUBGROUP } from '@noble/curves/ed25519';
import { A, B, HINT, ID, OTHER, SETS, cp, createCrypto, crypto, device, json, run, shape, walk } from './support/host/codePairKit.ts';

test('the key schedule: every input changes what it should and nothing else, the transcript hash is the draft’s labelled hash, and a low-order ephemeral key is refused', () => {
  const rnd = (n: number, v: number) => new Uint8Array(n).fill(v);
  const isk = rnd(64, 1);
  const transcript = rnd(40, 2);
  const [dA, dB] = [rnd(32, 3), rnd(32, 4)];
  const ephA = crypto.prim.randomBytes(32);
  const ephB = crypto.prim.x25519Base(crypto.prim.randomBytes(32));
  const keys = (over: Record<string, any> = {}) =>
    cp.deriveKeys(
      crypto,
      { isk, transcript, ...over.run },
      over.dA ?? dA,
      over.dB ?? dB,
      over.eph ?? ephA,
      over.peer ?? ephB,
      over.id ?? ID,
    );
  const base = keys();
  const same = (k: any, ...names: string[]) => names.every((n) => Buffer.from(k[n]).equals(Buffer.from(base[n])));
  const differs = (k: any, ...names: string[]) => names.every((n) => !Buffer.from(k[n]).equals(Buffer.from(base[n])));
  assert.ok(
    differs(keys({ eph: crypto.prim.randomBytes(32) }), 'root') && same(keys({ eph: crypto.prim.randomBytes(32) }), 'toA', 'toB', 'safety'),
    'the ephemeral exchange is in the root and only there',
  );
  assert.ok(differs(keys({ peer: crypto.prim.x25519Base(crypto.prim.randomBytes(32)) }), 'root'));
  assert.ok(differs(keys({ dA: rnd(32, 9) }), 'toA', 'toB', 'root', 'safety'), 'device A in every key and in the number');
  assert.ok(differs(keys({ dB: rnd(32, 9) }), 'toA', 'toB', 'root', 'safety'), 'device B in every key and in the number');
  assert.ok(differs(keys({ id: OTHER }), 'toA', 'toB', 'root') && same(keys({ id: OTHER }), 'safety'), 'the offer is in every key');
  assert.ok(differs(keys({ run: { isk: rnd(64, 7) } }), 'toA', 'toB', 'root'), 'ISK is in every key');
  assert.ok(
    differs(keys({ run: { transcript: rnd(40, 8) } }), 'transcriptHash', 'safety') &&
      same(keys({ run: { transcript: rnd(40, 8) } }), 'toA', 'toB'),
    'the transcript is in the hash and the number',
  );
  assert.notDeepEqual([...base.toA], [...base.toB], 'one key per direction');
  assert.notDeepEqual([...base.toA], [...base.root]);
  assert.match(base.safety, /^\d{20}$/);
  assert.throws(
    () => keys({ peer: new Uint8Array(32) }),
    (e: any) => e.code === 'bad_message',
  );
  // the hash is the draft's, H("CPaceSidOutput" || transcript), not a bare hash of it
  assert.equal(Buffer.from(base.transcriptHash).length, 64);
  assert.deepEqual([...base.transcriptHash], [...pubSessionId({ transcript })]);
});

// the draft's labelled hash through the public door
// @ts-ignore
import * as pub from '../shared/host/cpace.mjs';
const pubSessionId = (run: { transcript: Uint8Array }) => pub.sessionIdOf(run as any);

test('a device must prove it holds the key it claims: a code holder that names another Mac’s key cannot finish, on either side', () => {
  // an attacker who knows the code claims the key of a Mac it does not hold
  const victim = device('Victim Mac');
  const forged = { ...A, pub: victim.pub };
  const x = run({ a: { device: forged } });
  assert.throws(
    () => x.b.receive3(x.a.second(x.b.receive(x.a.first()))),
    (e: any) => e.code === 'bad_proof',
  );
  // and the other direction: a responder that names a key it cannot sign with
  const y = run({ b: { device: { ...B, pub: victim.pub } } });
  const m3 = y.a.second(y.b.receive(y.a.first()));
  y.b.receive3(m3);
  assert.throws(
    () => y.a.finish(y.b.answer(true).message),
    (e: any) => e.code === 'bad_proof',
  );
  // a proof made for another run or another role is not this run's
  const z = run();
  const stolen = device('Stolen');
  const stealer = { ...A, sign: (m: Uint8Array) => stolen.sign(m) };
  const w = run({ a: { device: stealer } });
  assert.throws(
    () => w.b.receive3(w.a.second(w.b.receive(w.a.first()))),
    (e: any) => e.code === 'bad_proof',
  );
  assert.ok(z);
});

test('a name is cut and cleaned before anyone sees it: no layout, hidden or direction characters, at most MAX_NAME', () => {
  const dirty = `Bad\u0000 name\n‮evil‬​⁦x⁩﻿${'x'.repeat(200)}`;
  const { a, b } = run({ a: { device: { ...A, name: dirty } } });
  const seen = b.receive3(a.second(b.receive(a.first())));
  assert.equal([...seen.peerName].length, cp.MAX_NAME);
  assert.ok(!/[\u0000-\u001f​-‏‪-‮⁠-⁯﻿]/.test(seen.peerName));
  assert.ok(seen.peerName.startsWith('Bad nameevil'));
  const e = run({ a: { device: { ...A, name: 5 as any } } });
  assert.equal(e.b.receive3(e.a.second(e.b.receive(e.a.first()))).peerName, '');
});

test('the offer, hint and claim a machine is given are checked first', () => {
  const base = { crypto, secret: 'MX2F9', hint: HINT, rendezvousId: ID, claims: 1, device: A, budget: cp.createRunBudget() };
  for (const bad of [
    { rendezvousId: 'r_short' },
    { rendezvousId: 5 },
    { rendezvousId: `${ID}x` },
    { claims: 0 },
    { claims: 6 },
    { claims: 1.5 },
    { claims: '1' },
    { hint: 'K7' },
    { hint: 'K70' },
    { hint: 5 },
  ])
    for (const make of [cp.createInitiator, cp.createResponder])
      assert.throws(
        () => make({ ...base, ...bad } as any),
        (e: any) => e.code === 'bad_code',
        JSON.stringify(bad),
      );
  assert.doesNotThrow(() => cp.createInitiator({ ...base, claims: 5 }));
});

test('the budget counts a run when it starts, gives nothing back, makes the count durable before the run begins, and the third start burns the code', () => {
  const budget = cp.createRunBudget();
  assert.deepEqual([budget.begin(), budget.left], [true, 2]);
  assert.deepEqual([budget.begin(), budget.left], [true, 1]);
  assert.equal(budget.burned, false);
  assert.deepEqual([budget.begin(), budget.left, budget.burned], [true, 0, true]);
  assert.equal(budget.begin(), false, 'a fourth run is refused');
  const one = cp.createRunBudget();
  one.begin();
  one.confirmed();
  assert.deepEqual([one.burned, one.left, one.begin()], [true, 0, false], 'a confirmed code is spent: one use, no refund');
  assert.equal(cp.createRunBudget({ max: 1 }).begin(), true);
  // the count is written before a run starts: a write that fails starts nothing and counts nothing
  const written: number[] = [];
  const durable = cp.createRunBudget({ persist: (state: { started: number }) => void written.push(state.started) });
  durable.begin();
  durable.begin();
  assert.deepEqual(written, [1, 2]);
  let failing = true;
  const flaky = cp.createRunBudget({
    persist: () => {
      if (failing) throw new Error('disk full');
    },
  });
  assert.throws(() => flaky.begin(), /disk full/);
  assert.equal(flaky.left, 3, 'nothing was counted');
  failing = false;
  assert.equal(flaky.begin(), true);
});

test('both machines count in their budget before their first message exists: the responder in receive, the initiator in first; the third run is refused and a failed run is not refunded', () => {
  const written: string[] = [];
  const budget = cp.createRunBudget({ persist: (state: { started: number }) => void written.push(`count ${state.started}`) });
  const make = () =>
    cp.createResponder({
      crypto,
      secret: 'MX2F9',
      hint: HINT,
      rendezvousId: ID,
      claims: 1,
      device: B,
      budget: { ...budget, begin: () => (written.push('begin'), budget.begin()) },
    });
  const a1 = run().a;
  const r1 = make();
  const m1 = a1.first();
  assert.deepEqual(written, []);
  r1.receive(m1);
  assert.deepEqual(written, ['begin', 'count 1'], 'counted (and written) before the reply was made');
  // two more claims that fail: the third start is the last, the fourth is refused with `burned`
  for (let i = 0; i < 2; i++) {
    const r = cp.createResponder({ crypto, secret: 'MX2F9', hint: HINT, rendezvousId: ID, claims: 1, device: B, budget });
    assert.throws(
      () => r.receive('not a message'),
      (e: any) => e.code === 'bad_message',
    );
  }
  const r4 = cp.createResponder({ crypto, secret: 'MX2F9', hint: HINT, rendezvousId: ID, claims: 1, device: B, budget });
  assert.throws(
    () => r4.receive(run().a.first()),
    (e: any) => e.code === 'burned',
  );
  // the typing side: three starts of one typed code, then no more; a confirmed run spends it
  const typed = cp.createRunBudget();
  const start = () => cp.createInitiator({ crypto, secret: 'MX2F9', hint: HINT, rendezvousId: ID, claims: 1, device: A, budget: typed });
  for (let i = 0; i < 3; i++) assert.ok(start().first());
  assert.throws(
    () => start().first(),
    (e: any) => e.code === 'burned',
  );
  const good = cp.createRunBudget();
  const { a, b } = run({ a: { budget: good }, b: { budget: cp.createRunBudget() } });
  a.second(b.receive(a.first()));
  assert.equal(good.burned, true, 'the typed code is spent once the other side proved it knew it');
});

test('the secret is the only password: another secret is another run, and the channel, the offer and the claim are in every run', () => {
  const same = walk();
  assert.equal(same.b.answer(true).root.length, 32);
  const other = run({ a: { secret: 'MX2F8' } });
  assert.throws(
    () => other.a.second(other.b.receive(other.a.first())),
    (e: any) => e.code === 'bad_confirmation',
  );
  assert.notDeepEqual([...cp.ciOf(HINT, ID, 1)], [...cp.ciOf(HINT, ID, 2)]);
  assert.notDeepEqual([...cp.ciOf(HINT, ID, 1)], [...cp.ciOf(HINT, OTHER, 1)]);
  assert.notDeepEqual([...cp.ciOf(HINT, ID, 1)], [...cp.ciOf('ZZZ', ID, 1)]);
  assert.equal((cp as any).sidOf, undefined, 'there is no session id: it is empty on purpose');
  assert.equal(cp.unb64u('a'), null);
  assert.equal(cp.unb64u('!'), null);
  assert.deepEqual([...(cp.unb64u(cp.b64u(new Uint8Array([1, 2, 3, 4, 5]))) as Uint8Array)], [1, 2, 3, 4, 5]);
});

test('the edges: a body that is not an object, a text with two spellings, a message that is not an object', () => {
  for (const bad of ['not json', '[1]', 'null', '5', '"x"']) assert.equal(cp.bodyOf(new TextEncoder().encode(bad)), null, bad);
  assert.deepEqual(cp.bodyOf(new TextEncoder().encode('{"a":1}')), { a: 1 });
  for (const t of ['AB', 'AAB', 'AA==', 'A+/=']) assert.equal(cp.unb64u(t), null, t);
  assert.deepEqual([...(cp.unb64u('AQ') as Uint8Array)], [1]);
  for (const text of ['null', '5', '"x"', '{}'])
    assert.throws(
      () => run().b.receive(shape(JSON.parse(text) ?? {})),
      (e: any) => e.code === 'bad_message',
      text,
    );
});

test('a relay that replays the same offer and claim for two runs gets two different runs: other keys, other safety numbers, and nothing of one confirms in the other', () => {
  const one = walk();
  const two = walk();
  const end = (w: any) => {
    const answer = w.b.answer(true);
    return { answer, end: w.a.finish(answer.message) };
  };
  const [x, y] = [end(one), end(two)];
  assert.notDeepEqual([...x.answer.root], [...y.answer.root]);
  assert.notEqual(x.end.safety, y.end.safety);
  assert.notEqual(one.m1, two.m1);
  const a2 = run().a;
  a2.first();
  assert.throws(
    () => a2.second(one.m2),
    (e: any) => e.code === 'bad_confirmation',
  );
  const d = run();
  d.b.receive(d.a.first());
  assert.throws(
    () => d.b.receive3(one.m3),
    (e: any) => e.code === 'bad_confirmation',
  );
});

test('both nonces and the ephemeral keys are made inside the module: nothing passes them in, and the two sides of a run never share one', () => {
  const { a, b } = run();
  const m1 = a.first();
  const f1 = json(m1);
  const f2 = json(b.receive(m1));
  const p1 = cp.parseAd(cp.unb64u(f1.ad) as Uint8Array, 'initiator') as any;
  const p2 = cp.parseAd(cp.unb64u(f2.ad) as Uint8Array, 'responder') as any;
  assert.notDeepEqual([...p1.nonce], [...p2.nonce]);
  assert.notDeepEqual([...p1.eph], [...p2.eph]);
  const sneaky = cp.createInitiator({
    crypto,
    secret: 'MX2F9',
    hint: HINT,
    rendezvousId: ID,
    claims: 1,
    device: A,
    budget: cp.createRunBudget(),
    nonce: new Uint8Array(16),
    eph: new Uint8Array(32),
  } as any);
  const pg = cp.parseAd(cp.unb64u(json(sneaky.first()).ad) as Uint8Array, 'initiator') as any;
  assert.notDeepEqual([...pg.nonce], new Array(16).fill(0));
  assert.notDeepEqual([...pg.eph], new Array(32).fill(0));
});

test('what the budget wrote can be restored: a restart in the middle of a code keeps its count, and a spent code stays spent', () => {
  let saved: any = null;
  const make = (restore?: any) => cp.createRunBudget({ persist: (state: any) => (saved = { ...state }), restore });
  const first = make();
  first.begin();
  first.begin();
  assert.deepEqual(saved, { started: 2, spent: false });
  const again = make(saved);
  assert.deepEqual([again.left, again.burned], [1, false], 'two runs used, one left');
  assert.equal(again.begin(), true);
  assert.equal(again.begin(), false);
  const one = make();
  one.begin();
  one.confirmed();
  assert.deepEqual(saved, { started: 1, spent: true });
  const spent = make(saved);
  assert.deepEqual([spent.burned, spent.left, spent.begin()], [true, 0, false], 'still spent after a restart');
  // a stored value that is not exactly a count from 0 to the maximum and a boolean is a spent code, never more guesses
  for (const junk of [
    {},
    { started: Number.NaN },
    { started: 'abc', spent: 'yes' },
    { started: -5 },
    { started: -5, spent: false },
    'junk',
    42,
    { spent: 1 },
    { started: '2' },
    { started: 1.5, spent: false },
    { started: 99, spent: false },
    { started: 1 },
    { spent: false },
    null,
    [],
    { started: 1, spent: 'false' },
  ]) {
    const b = make(junk);
    assert.deepEqual([b.burned, b.left, b.begin()], [true, 0, false], JSON.stringify(junk));
  }
  for (const good of [
    { started: 0, spent: false },
    { started: 3, spent: false },
    { started: 3, spent: true },
    { started: 0, spent: true },
  ])
    assert.equal(make(good).burned, good.spent || good.started === 3);
  assert.equal(make().left, 3, 'nothing stored is a fresh code');
  // a write that fails on the spend does not un-spend the code
  const flaky = cp.createRunBudget({
    persist: (state: { spent: boolean }) => {
      if (state.spent) throw new Error('disk full');
    },
  });
  flaky.begin();
  assert.throws(() => flaky.confirmed(), /disk full/);
  assert.equal(flaky.burned, true);
});

test('a budget whose count cannot be written ends the run cleanly, on both sides, and leaves nothing a later message could reach', () => {
  const broken = () =>
    cp.createRunBudget({
      persist: () => {
        throw new Error('read-only disk');
      },
    });
  const r = run({ b: { budget: broken() } });
  const m1 = r.a.first();
  assert.throws(
    () => r.b.receive(m1),
    (e: any) => e.code === 'unrecorded',
  );
  assert.throws(
    () => r.b.receive3(shape({ tag: cp.b64u(new Uint8Array(64)), sealed: cp.b64u(new Uint8Array(60)) })),
    (e: any) => e.code === 'out_of_turn',
    'not a TypeError on a half-made run',
  );
  const a = run({ a: { budget: broken() } }).a;
  assert.throws(
    () => a.first(),
    (e: any) => e.code === 'unrecorded',
  );
  assert.throws(
    () => a.second('x'),
    (e: any) => e.code === 'out_of_turn',
  );
  // an unexpected failure in the third step (here: the write of the spent code) ends the run, and the answer cannot be given
  let spendFails = false;
  const budget = cp.createRunBudget({
    persist: (state: { spent: boolean }) => {
      if (spendFails && state.spent) throw new Error('disk full');
    },
  });
  const w = run({ b: { budget } });
  const m3 = w.a.second(w.b.receive(w.a.first()));
  spendFails = true;
  assert.throws(
    () => w.b.receive3(m3),
    (e: any) => e instanceof cp.CodePairError,
  );
  assert.throws(
    () => w.b.answer(true),
    (e: any) => e.code === 'out_of_turn',
  );
});

test('a proof is bound to its run and its role, and a confirmed code is spent on both sides', () => {
  // a signature recorded in one run replayed in another is no proof (the transcript hash is in what is signed)
  const recorded: Uint8Array[] = [];
  const recorder = { ...A, sign: (m: Uint8Array) => (recorded.push(A.sign(m)), recorded[recorded.length - 1] as Uint8Array) };
  const first = run({ a: { device: recorder } });
  first.b.receive3(first.a.second(first.b.receive(first.a.first())));
  const replayer = { ...A, sign: () => recorded[0] as Uint8Array };
  const second = run({ a: { device: replayer } });
  assert.throws(
    () => second.b.receive3(second.a.second(second.b.receive(second.a.first()))),
    (e: any) => e.code === 'bad_proof',
  );
  // a reflection when both sides hold the same device key: one side's proof presented as the other's is no proof (the role is in what is signed)
  let initiatorProof: Uint8Array | null = null;
  const same = device('Same Mac');
  const inner = { ...same, sign: (m: Uint8Array) => (initiatorProof = same.sign(m)) };
  const echo = { ...same, sign: () => initiatorProof as Uint8Array };
  const x = run({ a: { device: inner }, b: { device: echo } });
  x.b.receive3(x.a.second(x.b.receive(x.a.first())));
  assert.throws(
    () => x.a.finish(x.b.answer(true).message),
    (e: any) => e.code === 'bad_proof',
  );
  // the responder spends the code when the other side proved it knew it, whatever comes next
  const budget = cp.createRunBudget();
  const y = run({ b: { budget } });
  const m3 = y.a.second(y.b.receive(y.a.first()));
  assert.equal(budget.burned, false);
  y.b.receive3(m3);
  assert.deepEqual([budget.burned, budget.left], [true, 0]);
});

for (const [name, make] of Object.entries(SETS)) {
  test(`a signature is checked strictly, not left to the primitive set: small-order and non-canonical keys, small-order nonces and a non-canonical S are refused (${name})`, () => {
    const c = createCrypto(make());
    const hash = crypto.prim.randomBytes(64);
    const message = (role: string) =>
      pubCpace.lvCat(new TextEncoder().encode('mopilot-code-pair-v1|device-proof'), new TextEncoder().encode(role), hash);
    const { pk, sk } = c.prim.edKeypair();
    const sig = c.prim.edSign(sk, message('initiator'));
    assert.equal(cp.provedBy(c, pk, 'initiator', hash, cp.b64u(sig)), true, 'a good proof');
    assert.equal(cp.provedBy(c, pk, 'responder', hash, cp.b64u(sig)), false, 'the other role');
    assert.equal(cp.provedBy(c, pk, 'initiator', crypto.prim.randomBytes(64), cp.b64u(sig)), false, 'another run');
    assert.equal(cp.provedBy(c, pk, 'initiator', hash, cp.b64u(sig.slice(0, 63))), false);
    assert.equal(cp.provedBy(c, pk.slice(0, 31), 'initiator', hash, cp.b64u(sig)), false);
    assert.equal(cp.provedBy(c, pk, 'initiator', hash, 5), false);
    // every point of small order as the key, with the signature that a lax verifier accepts for it (R the identity, S zero)
    const identitySig = new Uint8Array(64);
    identitySig[0] = 1;
    for (const point of ED25519_TORSION_SUBGROUP)
      assert.equal(
        cp.provedBy(c, Uint8Array.from(Buffer.from(point, 'hex')), 'initiator', hash, cp.b64u(identitySig)),
        false,
        point.slice(0, 8),
      );
    // encodings of a point that are not the canonical one (a y that is not below the field prime)
    for (const bad of [
      'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
      'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
    ])
      assert.equal(
        cp.provedBy(c, Uint8Array.from(Buffer.from(bad, 'hex')), 'initiator', hash, cp.b64u(identitySig)),
        false,
        bad.slice(0, 4),
      );
    // a real key whose nonce R is a point of small order, and one whose S is not below the group order
    const smallR = Uint8Array.from(sig);
    smallR.set(Uint8Array.from(Buffer.from('0100000000000000000000000000000000000000000000000000000000000000', 'hex')), 0);
    assert.equal(cp.provedBy(c, pk, 'initiator', hash, cp.b64u(smallR)), false, 'R of small order');
    const big = Uint8Array.from(sig);
    let carry = 0n;
    const L = 7237005577332262213973186563042994240857116359379907606001950938285454250989n;
    let s = 0n;
    for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(sig[i] as number);
    s += L;
    for (let i = 32; i < 64; i++) {
      big[i] = Number(s & 255n);
      s >>= 8n;
    }
    assert.equal(carry, 0n);
    assert.equal(cp.provedBy(c, pk, 'initiator', hash, cp.b64u(big)), false, 'S plus the group order');
    // through a whole run: a device that names a small-order key is refused whatever it signs
    const forged = {
      pub: Uint8Array.from(Buffer.from(ED25519_TORSION_SUBGROUP[0] as string, 'hex')),
      name: 'Forged',
      sign: () => identitySig,
    };
    const ca = createCrypto(make());
    const a = cp.createInitiator({
      crypto: ca,
      secret: 'MX2F9',
      hint: HINT,
      rendezvousId: ID,
      claims: 1,
      device: forged,
      budget: cp.createRunBudget(),
    });
    const b = cp.createResponder({
      crypto: ca,
      secret: 'MX2F9',
      hint: HINT,
      rendezvousId: ID,
      claims: 1,
      device: B,
      budget: cp.createRunBudget(),
    });
    assert.throws(
      () => b.receive3(a.second(b.receive(a.first()))),
      (e: any) => e.code === 'bad_proof',
    );
  });
}

test('names lose Unicode tag characters, Hangul fillers, the combining grapheme joiner and the blank braille pattern too', () => {
  const sneaky = `Mac\u{e0041}\u{e007f}\u115f\u1160\u3164\uffa0\u034f\u2800 pro`;
  const { a, b } = run({ a: { device: { ...A, name: sneaky } } });
  assert.equal(b.receive3(a.second(b.receive(a.first()))).peerName, 'Mac pro');
});
