// CPace (shared/host/cpaceInternal.mjs behind the public door shared/host/cpace.mjs; draft-irtf-cfrg-cpace-20, CPACE-RISTR255-SHA512): the draft's published test vectors (appendix A.1 and B.3) byte for byte, the abort cases of its section 8 (an encoding that does not decode, the neutral element), the negative cases of a run (wrong password, session id or channel, changed message or associated data, a reflected share, a run finished twice, a wrong confirmation) and what the public door does and does not give.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
// @ts-ignore: plain ESM without declarations
import * as pub from '../shared/host/cpace.mjs';
// @ts-ignore
import * as cpace from '../shared/host/cpaceInternal.mjs';

const hex = (s: string) => Uint8Array.from(Buffer.from(s.replace(/\s+/g, ''), 'hex'));
const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const utf8 = (s: string) => new TextEncoder().encode(s);
const le = (b: Uint8Array) => b.reduceRight((n, byte) => (n << 8n) | BigInt(byte), 0n);

// appendix B.3
const PRS = utf8('Password');
const CI = hex('0b415f696e69746961746f720b425f726573706f6e646572');
const SID = hex('7e4b4791d6a8ef019b936c79fb7f2c57');
const ADA = utf8('ADa');
const ADB = utf8('ADb');
const YA_SCALAR = hex('da3d23700a9e5699258aef94dc060dfda5ebb61f02a5ea77fad53f4ff0976d08');
const YB_SCALAR = hex('d2316b454718c35362d83d69df6320f38578ed5984651435e2949762d900b80d');
const YA = 'd6bac480f2c386c394efc7c47adb9925dcd2630b64f240c50f8d0eec482b9157';
const YB = '3ea7e0b19560d7c0b0f5734f63b955286dfa8232b5ebe63324e2d9e7433f7258';
const K = '80b69a8a76457ab6a4d7f887a4bf6b55a2f80ac19c333f917a05fc9887c8b40f';
const ISK_IR =
  'b69effbf61b51d56401c0f65601abe428de8206feaaf0e32198896dcae7b35cd2b38950a39dfd5d4a79164614c2984f7daa460b588c1e80c3fa2068af7900447';
const fixed = (b: Uint8Array) => () => Uint8Array.from(b);
const inputs = (over: Record<string, any> = {}): any => ({ prs: PRS, ci: CI, sid: SID, ad: ADA, ...over });

test('A.1: prepend_len and lv_cat reproduce the draft’s vectors, and a length of 16384 or more takes three bytes', () => {
  assert.equal(toHex(cpace.prependLen(utf8(''))), '00');
  assert.equal(toHex(cpace.prependLen(utf8('1234'))), '0431323334');
  const r127 = Uint8Array.from({ length: 127 }, (_, i) => i);
  const r128 = Uint8Array.from({ length: 128 }, (_, i) => i);
  assert.equal(toHex(cpace.prependLen(r127)), `7f${toHex(r127)}`);
  assert.equal(toHex(cpace.prependLen(r128)), `8001${toHex(r128)}`);
  assert.equal(toHex(cpace.lvCat(utf8('1234'), utf8('5'), utf8(''), utf8('678'))), '043132333401350003363738');
  assert.equal(toHex(cpace.prependLen(new Uint8Array(16384)).subarray(0, 4)), '80800100');
  assert.equal(toHex(cpace.prependLen(new Uint8Array(300)).subarray(0, 3)), 'ac0200');
  assert.equal(pub.prependLen, cpace.prependLen);
  assert.equal(pub.lvCat, cpace.lvCat);
});

test('B.3.1: the generator string, its hash and the encoded generator, and a password that fills the block needs no zero padding', () => {
  const dsi = utf8('CPaceRistretto255');
  const str = cpace.generatorString(dsi, PRS, CI, SID, 128);
  assert.equal(str.length, 170);
  assert.equal(
    toHex(str),
    '11435061636552697374726574746f3235350850617373776f726464' +
      '00'.repeat(100) +
      '180b415f696e69746961746f720b425f726573706f6e646572107e4b4791d6a8ef019b936c79fb7f2c57',
  );
  const g = cpace.calculateGenerator(inputs());
  assert.equal(toHex(g.toBytes()), '222b6b195fe84b1652badb6f6a3ae3d24341e7306967f0b8115b40d5698c7e56');
  // len_zpad = max(0, 128 - 1 - len(prepend_len(PRS)) - len(prepend_len(DSI))): a long password has none
  const long = new Uint8Array(200).fill(7);
  assert.equal(toHex(cpace.generatorString(dsi, long, CI, SID, 128)), toHex(cpace.lvCat(dsi, long, new Uint8Array(0), CI, SID)));
  assert.equal(cpace.calculateGenerator(inputs({ prs: long })).toBytes().length, 32);
});

test('B.3.2 to B.3.5: the messages of A and B, the shared point and ISK of the initiator-responder run', () => {
  const a = cpace.initiateWith(fixed(YA_SCALAR), inputs({ ad: ADA }));
  assert.equal(toHex(a.message.Y), YA);
  const b = cpace.respondWith(fixed(YB_SCALAR), inputs({ ad: ADB }), a.message);
  assert.equal(toHex(b.message.Y), YB);
  assert.equal(toHex(cpace.scalarMultVfy(le(YA_SCALAR), hex(YB))!), K);
  assert.equal(toHex(cpace.scalarMultVfy(le(YB_SCALAR), hex(YA))!), K);
  assert.equal(
    toHex(cpace.transcriptIr(hex(YA), ADA, hex(YB), ADB)),
    '20d6bac480f2c386c394efc7c47adb9925dcd2630b64f240c50f8d0eec482b915703414461203ea7e0b19560d7c0b0f5734f63b955286dfa8232b5ebe63324e2d9e7433f725803414462',
  );
  assert.equal(toHex(b.run.isk), ISK_IR);
  const done = a.finish(b.message);
  assert.equal(toHex(done.isk), ISK_IR);
  assert.deepEqual(done.transcript, b.run.transcript);
  assert.deepEqual([done.role, b.run.role], ['initiator', 'responder']);
  assert.ok(Object.isFrozen(done) && Object.isFrozen(b.run));
});

test('B.3.10: scalar_mult and scalar_mult_vfy on a valid input', () => {
  const y = le(hex('7cd0e075fa7955ba52c02759a6c90dbbfc10e6d40aea8d283e407d88cf538a05'));
  const x = hex('2c3c6b8c4f3800e7aef6864025b4ed79bd599117e427c41bd47d93d654b4a51c');
  assert.equal(toHex(cpace.scalarMultVfy(y, x)!), '7c13645fe790a468f62c39beb7388e541d8405d1ade69d1778c5fe3e7f6b600e');
  const g = cpace.calculateGenerator(inputs());
  assert.equal(toHex(cpace.scalarMult(y, g)), toHex(g.multiply(y).toBytes()));
});

test('B.3.11 and section 8: an encoding that does not decode and the neutral element are G.I, and abort a run', () => {
  const y = le(hex('7cd0e075fa7955ba52c02759a6c90dbbfc10e6d40aea8d283e407d88cf538a05'));
  const invalid = hex('2b3c6b8c4f3800e7aef6864025b4ed79bd599117e427c41bd47d93d654b4a51c');
  const neutral = new Uint8Array(32);
  assert.equal(cpace.scalarMultVfy(y, invalid), null);
  assert.equal(cpace.scalarMultVfy(y, neutral), null);
  // non-canonical encodings (all ones, the field prime, a negative element) and a share of the wrong length never decode
  assert.equal(cpace.scalarMultVfy(y, hex('ff'.repeat(32))), null);
  assert.equal(cpace.scalarMultVfy(y, hex('edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f')), null);
  assert.equal(cpace.scalarMultVfy(y, hex(`01${'00'.repeat(31)}`)), null);
  assert.equal(cpace.scalarMultVfy(y, hex(YA).slice(0, 31)), null, 'a 31-byte share');
  assert.equal(cpace.scalarMultVfy(y, new Uint8Array(33)), null);
  for (const Y of [invalid, neutral, hex(YA).slice(0, 31)]) {
    const a = cpace.initiateWith(fixed(YA_SCALAR), inputs());
    assert.throws(
      () => a.finish({ Y, ad: ADB }),
      (e: any) => e.code === 'invalid_point',
    );
    assert.throws(
      () => cpace.respondWith(fixed(YB_SCALAR), inputs({ ad: ADB }), { Y, ad: ADA }),
      (e: any) => e.code === 'invalid_point',
    );
    assert.throws(
      () => pub.respond(inputs({ ad: ADB }), { Y, ad: ADA }),
      (e: any) => e instanceof pub.CpaceAbort && e.code === 'invalid_point',
    );
  }
});

test('a run agrees on ISK only when the password, the session id, the channel, both messages and both associated data match', () => {
  const run = (b: Record<string, unknown> = {}, tamper?: (m: { Y: Uint8Array; ad: Uint8Array }) => { Y: Uint8Array; ad: Uint8Array }) => {
    const a = pub.initiate(inputs({ ad: ADA }));
    const sent = tamper ? tamper(a.message) : a.message;
    const r = pub.respond(inputs({ ad: ADB, ...b }), sent);
    return { a: a.finish(r.message).isk, b: r.run.isk };
  };
  const ok = run();
  assert.deepEqual(ok.a, ok.b);
  assert.equal(ok.a.length, 64);
  assert.notDeepEqual(run().a, ok.a, 'two runs never share a key (fresh scalars)');
  for (const wrong of [{ prs: utf8('Passw0rd') }, { sid: hex('7e4b4791d6a8ef019b936c79fb7f2c58') }, { ci: utf8('other channel') }]) {
    const r = run(wrong);
    assert.notDeepEqual(r.a, r.b, `a different ${Object.keys(wrong)[0]} gives a different key`);
  }
  const changedAd = run({}, (m) => ({ Y: m.Y, ad: utf8('ADx') }));
  assert.notDeepEqual(changedAd.a, changedAd.b, 'a changed associated data is a different transcript');
  const mine = pub.initiate(inputs());
  const other = pub.initiate(inputs());
  const r = pub.respond(inputs({ ad: ADB }), other.message);
  assert.notDeepEqual(mine.finish(r.message).isk, r.run.isk, 'a message of another run does not agree');
});

test('a share equal to one’s own is refused, a run is finished once and then holds nothing, and bad inputs are refused before any work', () => {
  const a = cpace.initiateWith(fixed(YA_SCALAR), inputs());
  assert.throws(
    () => a.finish({ Y: a.message.Y, ad: ADB }),
    (e: any) => e.code === 'reflection',
  );
  assert.throws(
    () => a.finish({ Y: hex(YB), ad: ADB }),
    (e: any) => e.code === 'used',
    'even a refused finish ends the run: the scalar is gone',
  );
  const b = pub.initiate(inputs());
  const reply = pub.respond(inputs({ ad: ADB }), b.message);
  b.finish(reply.message);
  assert.throws(
    () => b.finish(reply.message),
    (e: any) => e.code === 'used',
  );
  assert.throws(
    () => cpace.respondWith(fixed(YA_SCALAR), inputs({ ad: ADB }), a.message),
    (e: any) => e.code === 'reflection',
  );
  assert.throws(
    () => pub.initiate(inputs({ ad: 'x' })),
    (e: any) => e.code === 'bad_input',
  );
  assert.throws(
    () => cpace.initiateWith(() => new Uint8Array(5), inputs()),
    (e: any) => e.code === 'bad_input',
  );
  const y = 5n;
  assert.throws(
    () => cpace.scalarMultVfy(y, 'x' as any),
    (e: any) => e.code === 'bad_input',
  );
  assert.throws(
    () => cpace.scalarMultVfy(y, Buffer.alloc(32)),
    (e: any) => e.code === 'bad_input',
    'a Buffer is refused: copy into a Uint8Array',
  );
  assert.throws(
    () => cpace.prependLen('x' as any),
    (e: any) => e.code === 'bad_input',
  );
  assert.throws(
    () => cpace.calculateGenerator({ prs: 'p' as any, ci: CI, sid: SID }),
    (e: any) => e.code === 'bad_input',
  );
  assert.throws(() => cpace.scalarMultVfy(0n, hex(YA)), /invalid scalar/);
  assert.throws(() => cpace.scalarMultVfy(1n << 253n, hex(YA)), /invalid scalar/);
});

test('the scalar is 32 random bytes with the bits above 252 cleared, little endian, and a zero is sampled again', () => {
  assert.equal(
    cpace.sampleScalar(() => Uint8Array.from({ length: 32 }, () => 0xff)),
    (1n << 252n) - 1n,
  );
  const sequence = [new Uint8Array(32), Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 0xf0 : 0)), hex(`01${'00'.repeat(31)}`)];
  let n = 0;
  assert.equal(
    cpace.sampleScalar(() => sequence[n++]!),
    1n,
    'a zero and a value that clears to zero are sampled again',
  );
  assert.equal(n, 3);
  const a = cpace.sampleScalar();
  const b = cpace.sampleScalar();
  assert.ok(a > 0n && a < 1n << 252n && a !== b, 'the default source is the library’s CSPRNG');
});

test('key confirmation (draft 9.4) through the public door: each side’s tag over its own message, checked as the other side’s, in constant time; a reflected own tag is refused', () => {
  const a = pub.initiate(inputs({ ad: ADA }));
  const b = pub.respond(inputs({ ad: ADB }), a.message);
  const runA = a.finish(b.message);
  const runB = b.run;
  const ta = pub.ownConfirmation(runA);
  const tb = pub.ownConfirmation(runB);
  // against Node's own SHA-512 and HMAC over the draft's formulas
  const macKey = crypto
    .createHash('sha512')
    .update(Buffer.concat([Buffer.from('CPaceMac'), Buffer.from(SID), Buffer.from(runA.isk)]))
    .digest();
  assert.equal(
    toHex(ta),
    crypto
      .createHmac('sha512', macKey)
      .update(Buffer.from(pub.lvCat(runA.own.Y, ADA)))
      .digest('hex'),
  );
  assert.equal(
    toHex(tb),
    crypto
      .createHmac('sha512', macKey)
      .update(Buffer.from(pub.lvCat(runB.own.Y, ADB)))
      .digest('hex'),
  );
  assert.equal(pub.verifyPeerConfirmation(runB, ta), true, 'the responder accepts the initiator’s tag');
  assert.equal(pub.verifyPeerConfirmation(runA, tb), true, 'the initiator accepts the responder’s tag');
  assert.equal(pub.verifyPeerConfirmation(runA, ta), false, 'a side’s own tag sent back (a reflection) is refused');
  assert.equal(pub.verifyPeerConfirmation(runB, tb), false);
  const bad = Uint8Array.from(ta);
  bad[0] = (bad[0] ?? 0) ^ 1;
  assert.equal(pub.verifyPeerConfirmation(runB, bad), false, 'a changed tag');
  assert.equal(pub.verifyPeerConfirmation(runB, ta.slice(0, 63)), false, 'a short tag');
  assert.equal(pub.verifyPeerConfirmation(runB, 'x' as any), false);
  // a run of other inputs has other tags
  const c = pub.initiate(inputs({ ad: ADA, prs: utf8('Passw0rd') }));
  const d = pub.respond(inputs({ ad: ADB }), c.message);
  assert.equal(pub.verifyPeerConfirmation(d.run, pub.ownConfirmation(c.finish(d.message))), false);
  // the lower-level pieces agree with the draft
  assert.equal(toHex(cpace.confirmationKey(SID, runA.isk)), macKey.toString('hex'));
});

test('the public door gives no K, no scalar, no random source and no direction-less check; the internal file is the only other place with them', async () => {
  assert.deepEqual(Object.keys(pub).sort(), [
    'CPACE_SPEC',
    'CpaceAbort',
    'initiate',
    'lvCat',
    'ownConfirmation',
    'prependLen',
    'respond',
    'sessionIdOf',
    'verifyPeerConfirmation',
  ]);
  const a = pub.initiate({ ...inputs(), random: fixed(YA_SCALAR) });
  assert.notEqual(toHex(a.message.Y), YA, 'a `random` option is ignored by the public door: the OS source is the only one');
  const fs = await import('node:fs');
  for (const file of ['cpace.mjs', 'cpaceInternal.mjs']) {
    const text = fs.readFileSync(new URL(`../shared/host/${file}`, import.meta.url), 'utf8');
    assert.match(text, /draft-irtf-cfrg-cpace-20/);
    assert.doesNotMatch(text, /from 'node:|require\(|fetch\(|Date\.now|process\./);
  }
  assert.match(pub.CPACE_SPEC, /draft-irtf-cfrg-cpace-20 CPACE-RISTR255-SHA512/);
});

test('a run shares no array with the caller or with the messages it returned, and a peer message is read once', () => {
  const sid = Uint8Array.from(SID);
  const a = pub.initiate(inputs({ ad: ADA, sid }));
  const b = pub.respond(inputs({ ad: ADB }), a.message);
  const reply = { Y: Uint8Array.from(b.message.Y), ad: Uint8Array.from(b.message.ad) };
  const run = a.finish(reply);
  const tagB = pub.ownConfirmation(b.run);
  const tagA = pub.ownConfirmation(run);
  assert.notEqual(run.own, a.message);
  assert.notEqual(run.own.Y, a.message.Y);
  assert.notEqual(run.peer.Y, reply.Y);
  assert.notEqual(run.peer.ad, reply.ad);
  assert.notEqual(run.sid, sid);
  assert.ok(Object.isFrozen(run.own) && Object.isFrozen(run.peer));
  // whatever the caller does to its own arrays afterwards changes no confirmation
  reply.Y.fill(0);
  reply.ad.fill(0);
  a.message.Y.fill(0);
  a.message.ad.fill(0);
  sid.fill(0);
  assert.equal(pub.verifyPeerConfirmation(run, tagB), true);
  assert.equal(pub.ownConfirmation(run).join(), tagA.join());
  // the responder's run too
  const c = pub.initiate(inputs({ ad: ADA }));
  const msg = { Y: Uint8Array.from(c.message.Y), ad: Uint8Array.from(c.message.ad) };
  const d = pub.respond(inputs({ ad: ADB }), msg);
  const tagC = pub.ownConfirmation(c.finish(d.message));
  msg.Y.fill(0);
  assert.equal(pub.verifyPeerConfirmation(d.run, tagC), true);
  assert.notEqual(d.run.own.Y, d.message.Y);
  // a message whose fields change when read twice is read once: the run is of the first value
  let reads = 0;
  const e = pub.initiate(inputs({ ad: ADA }));
  const f = pub.respond(inputs({ ad: ADB }), e.message);
  const sneaky = {
    get Y() {
      reads++;
      return reads === 1 ? f.message.Y : new Uint8Array(32);
    },
    ad: f.message.ad,
  };
  assert.deepEqual(e.finish(sneaky).isk, f.run.isk);
  assert.equal(reads, 1);
  // a 33-byte share through finish aborts
  const g = pub.initiate(inputs({ ad: ADA }));
  assert.throws(
    () => g.finish({ Y: new Uint8Array(33), ad: ADB }),
    (err: any) => err.code === 'invalid_point',
  );
});

test('B.3.7: the labelled hash of the transcript (the draft’s sid_output), through the internal function and the public door', () => {
  const transcript = cpace.transcriptIr(hex(YA), ADA, hex(YB), ADB);
  const want =
    'bb1c449b35f0ea79a65c209f329a693d475e0ce2387bed9fe4b78f60b2a27c219813fb2cfe175ef40d2222d9261e66da7d78f7c55a303b1b8611dcdfab880c47';
  assert.equal(toHex(cpace.sidOutput(transcript)), want);
  const a = cpace.initiateWith(fixed(YA_SCALAR), inputs({ ad: ADA }));
  const b = cpace.respondWith(fixed(YB_SCALAR), inputs({ ad: ADB }), a.message);
  assert.equal(toHex(pub.sessionIdOf(b.run)), want, 'the responder’s run');
  assert.equal(toHex(pub.sessionIdOf(a.finish(b.message))), want, 'the initiator’s run');
});

test('the message a run returns shares no array with the associated data the caller gave', () => {
  const given = Uint8Array.from(ADA);
  const a = pub.initiate(inputs({ ad: given }));
  assert.notEqual(a.message.ad, given);
  a.message.ad.fill(0);
  assert.deepEqual([...given], [...ADA]);
});
