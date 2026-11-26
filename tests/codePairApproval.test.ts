// The person's proof of a pairing by code (host/src/codePairApproval.mjs, slice 4 of #5576): a key is enrolled once with proof it is held; an answer is accepted only over the exact text this Host made, signed by that key, in time; a controller's record counts only while it carries such a proof.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore
import { approvedNameOf } from '../host/src/codePairService.mjs';
// @ts-ignore: plain ESM without declarations
import {
  APPROVAL_TAG,
  ENROL_TAG,
  NOT_AFTER_MS,
  SKEW_MS,
  approvalTextFrom,
  approvalTextOf,
  carryHashOf,
  createApprovalKeys,
} from '../host/src/codePairApproval.mjs';

const helper = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as any;
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64');
  const sign = (text: string) => crypto.sign('sha256', Buffer.from(text), { key: privateKey, dsaEncoding: 'der' }).toString('base64');
  return { point, sign };
};
const peerKey = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.alloc(32, 7)]).toString('base64');
const peerHex = Buffer.alloc(32, 7).toString('hex');
const world = (t: any, over: { platform?: NodeJS.Platform; controllers?: number; now?: number } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-pair-approval-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = over.now ?? 1_000_000;
  const keys = createApprovalKeys({
    configDir: path.join(dir, 'config'),
    hostId: () => 'host-h',
    controllers: () => over.controllers ?? 0,
    // a Mac unless the test says otherwise: the Host's own platform is not what these tests are about (CI runs on Linux)
    platform: over.platform ?? 'darwin',
    now: () => clock,
  });
  const h = helper();
  const enrolWith = (weak = false) =>
    keys.enrol({ key: h.point, weak, signature: h.sign([ENROL_TAG, 'host-h', h.point, weak ? 'weak' : 'strong'].join('|')) });
  const text = (o: Record<string, unknown> = {}) =>
    approvalTextOf({
      hostId: 'host-h',
      offerId: 'r_x',
      safety: '123 456',
      peer: peerHex,
      name: 'Mac A',
      carry: { a: 1 },
      link: 'h_abcdefghijklmnop',
      notAfter: clock + NOT_AFTER_MS,
      accepted: true,
      ...o,
    } as any);
  return { dir, keys, h, enrolWith, text, tick: (ms: number) => void (clock += ms), file: path.join(dir, 'config', 'approval-key.json') };
};

test('a Mac with no enrolled key cannot accept a pairing, and says why; only a Mac can', (t) => {
  assert.deepEqual(world(t).keys.status(), { available: false, reason: 'no_approval_helper' });
  assert.deepEqual(world(t, { platform: 'linux' }).keys.status(), { available: false, reason: 'unsupported_platform' });
  assert.throws(() => world(t, { platform: 'linux' }).enrolWith(), { code: 'unsupported_platform' });
});

test('a key is enrolled once, with proof the helper holds it, and never while a controller exists', (t) => {
  const w = world(t);
  assert.deepEqual(w.enrolWith(true), { enrolled: true, weak: true });
  assert.deepEqual(w.keys.status(), { available: true, weak: true });
  assert.equal(fs.statSync(w.file).mode & 0o777, 0o600);
  assert.throws(() => w.enrolWith(), { code: 'already_enrolled' });
  // proof of a different key, a bad key, a signature over another text
  const fresh = world(t);
  const other = helper();
  const refuse = (key: string, signature: string) =>
    assert.throws(() => fresh.keys.enrol({ key, weak: false, signature }), { code: 'bad_proof' });
  refuse(fresh.h.point, other.sign([ENROL_TAG, 'host-h', fresh.h.point, 'strong'].join('|')));
  refuse(fresh.h.point, fresh.h.sign([ENROL_TAG, 'host-h', fresh.h.point, 'weak'].join('|')));
  refuse('AAAA', fresh.h.sign('x'));
  refuse(Buffer.alloc(65).toString('base64'), fresh.h.sign('x')); // the right size, not a point of the curve
  refuse(fresh.h.point, 'A'.repeat(40)); // the right shape, not a signature
  refuse(fresh.h.point, 'not a signature');
  assert.deepEqual(fresh.keys.status(), { available: false, reason: 'no_approval_helper' });
  assert.throws(() => world(t, { controllers: 1 }).enrolWith(), { code: 'controllers_exist' });
});

test('a file that is not exactly a key is no key', (t) => {
  const w = world(t);
  w.enrolWith();
  for (const bad of [
    '{',
    JSON.stringify({ v: 2, key: w.h.point, weak: false }),
    JSON.stringify({ v: 1, key: 'AAAA', weak: false }),
    JSON.stringify({ v: 1, key: w.h.point, weak: 'no' }),
  ]) {
    fs.writeFileSync(w.file, bad);
    assert.equal(w.keys.status().available, false, bad);
  }
});

test("an answer is the person's only when the enrolled key signed exactly this Host's accepted text, in time", (t) => {
  const w = world(t);
  assert.equal(w.keys.verify(w.text(), { sig: w.h.sign(w.text()) }), false, 'no key yet');
  w.enrolWith();
  const good = w.text();
  assert.equal(w.keys.verify(good, { sig: w.h.sign(good) }), true);
  assert.equal(w.keys.verify(good, { sig: helper().sign(good) }), false, 'another key');
  assert.equal(w.keys.verify(good, { sig: w.h.sign(good + 'x') }), false, 'another text');
  assert.equal(w.keys.verify(good, null), false);
  assert.equal(w.keys.verify(good, { sig: 5 }), false);
  for (const [name, over] of [
    ['another host', { hostId: 'host-other' }],
    ['a no', { accepted: false }],
    ['ran out', { notAfter: 999_999 }],
    ['dated too far ahead', { notAfter: 1_000_000 + NOT_AFTER_MS + SKEW_MS + 1 }],
    ['not a time', { notAfter: 'soon' }],
  ] as const) {
    const text = w.text(over);
    assert.equal(w.keys.verify(text, { sig: w.h.sign(text) }), false, name);
  }
  const short = [APPROVAL_TAG, 'host-h'].join('|');
  assert.equal(w.keys.verify(short, { sig: w.h.sign(short) }), false, 'not nine parts');
  const wrongTag = good.replace(APPROVAL_TAG, 'other-tag');
  assert.equal(w.keys.verify(wrongTag, { sig: w.h.sign(wrongTag) }), false);
  w.tick(NOT_AFTER_MS + 1);
  assert.equal(w.keys.verify(good, { sig: w.h.sign(good) }), false, 'time passed');
});

test('a controller record counts only with a proof for this Host and its own key, name and relay link; a record written by hand does not', (t) => {
  const w = world(t);
  const text = w.text();
  const link = 'h_abcdefghijklmnop';
  const record = (over: Record<string, unknown> = {}) =>
    ({ key: peerKey, name: 'Mac A', link, approval: { text, sig: w.h.sign(text) }, ...over }) as any;
  assert.equal(w.keys.verifyRecord(record()), false, 'no key yet');
  w.enrolWith();
  assert.equal(w.keys.verifyRecord(record()), true);
  w.tick(10 * NOT_AFTER_MS);
  assert.equal(w.keys.verifyRecord(record()), true, 'it was good when it was given');
  assert.equal(w.keys.verifyRecord({ key: peerKey, name: 'Mac A' }), false, 'no proof');
  assert.equal(w.keys.verifyRecord(record({ approval: { text: 5, sig: 'x' } })), false);
  assert.equal(w.keys.verifyRecord(record({ approval: { text, sig: helper().sign(text) } })), false, 'another key');
  const other = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.alloc(32, 9)]).toString('base64');
  assert.equal(w.keys.verifyRecord(record({ key: other })), false, "not that record's key");
  for (const bad of [w.text({ hostId: 'host-other' }), w.text({ accepted: false }), `${text}|more`]) {
    assert.equal(w.keys.verifyRecord(record({ approval: { text: bad, sig: w.h.sign(bad) } })), false, bad);
  }
});

test('a valid proof does not let a record be edited: another name, another relay link, or none is not what the person allowed', (t) => {
  const w = world(t);
  w.enrolWith();
  const text = w.text();
  const proof = { text, sig: w.h.sign(text) };
  const good = { key: peerKey, name: 'Mac A', link: 'h_abcdefghijklmnop', approval: proof } as any;
  assert.equal(w.keys.verifyRecord(good), true);
  assert.equal(w.keys.verifyRecord({ ...good, name: 'Mac B' }), false, 'renamed');
  assert.equal(w.keys.verifyRecord({ ...good, link: 'h_zzzzzzzzzzzzzzzz' }), false, "pointed at another client's relay link");
  assert.equal(w.keys.verifyRecord({ ...good, link: undefined }), false, 'its link taken off');
  // a pairing that brought no link is signed as one with none
  const none = w.text({ link: '' });
  assert.equal(w.keys.verifyRecord({ key: peerKey, name: 'Mac A', approval: { text: none, sig: w.h.sign(none) } } as any), true);
  assert.equal(
    w.keys.verifyRecord({ key: peerKey, name: 'Mac A', link: 'h_abcdefghijklmnop', approval: { text: none, sig: w.h.sign(none) } } as any),
    false,
  );
});

// The text the Swift helper must build from the fields the Host gives it (host.codePair.approvalText `fields`): ten parts joined by `|`, the name hashed as UTF-8, the credential's hash taken from the Host. If this vector changes, the helper's vector changes with it.
const VECTOR = {
  fields: {
    hostId: 'h_0123456789abcdef',
    offerId: 'r_AAAAAAAAAAAAAAAAAAAAAA',
    safety: '123 456',
    peer: '07'.repeat(32),
    name: 'Du\u2019s MacBook',
    carryHash: '051cd44b0519420df4af7031483d9015ff939cc73e44e59522d07996ec5daddf',
    link: 'h_abcdefghijklmnop',
    notAfter: 1800000120000,
    accepted: true,
  },
  text: 'mopilot-code-pair-approval-v1|h_0123456789abcdef|r_AAAAAAAAAAAAAAAAAAAAAA|123 456|0707070707070707070707070707070707070707070707070707070707070707|b507895844054f540097cf4ebbad177ee4717915a243700d7a121ab6b64923ff|051cd44b0519420df4af7031483d9015ff939cc73e44e59522d07996ec5daddf|h_abcdefghijklmnop|1800000120000|1',
  carry: {
    relayUrl: 'wss://relay.example/v1/ws',
    hostId: 'h_abcdefghijklmnop',
    secret: 'S'.repeat(43),
    pairId: 'p_pairpairpair',
    appPub: 'AAAA',
    appEphPub: 'BBBB',
  },
};

test("the name in the fields is the name as the record stores it: cleaned like every client's name, never half a character; the helper hashes exactly the string it is given (UTF-8)", () => {
  assert.equal(approvedNameOf('  Work\tMac \u0007 '), 'Work Mac');
  assert.equal(approvedNameOf(`${'x'.repeat(79)}😀`), 'x'.repeat(79));
  assert.equal(approvedNameOf(`${'x'.repeat(78)} 😀`), 'x'.repeat(78), 'a space left at the end by the cut is trimmed too');
  assert.equal(approvedNameOf(approvedNameOf('😀'.repeat(60))), approvedNameOf('😀'.repeat(60)), 'its own fixed point');
  assert.equal(approvedNameOf(VECTOR.fields.name), VECTOR.fields.name, "the vector's name is already one");
});

test('the signed text has a fixed vector, for the native helper to match byte for byte', () => {
  assert.equal(approvalTextFrom(VECTOR.fields), VECTOR.text);
  assert.equal(carryHashOf(VECTOR.carry), VECTOR.fields.carryHash);
  const { carryHash: _hash, ...rest } = VECTOR.fields;
  assert.equal(approvalTextOf({ ...rest, carry: VECTOR.carry }), VECTOR.text);
  assert.equal(VECTOR.text.split('|').length, 10);
  assert.equal(approvalTextFrom({ ...VECTOR.fields, accepted: false }).endsWith('|0'), true);
});

test('the text names a credential that is not there as nothing, and the same text for the same facts', (t) => {
  const w = world(t);
  assert.equal(w.text({ carry: undefined }), w.text({ carry: null }));
  assert.notEqual(w.text({ carry: { a: 1 } }), w.text({ carry: { a: 2 } }));
});

test('KNOWN GAP (#5617): a key file that is replaced is believed, and a revoked record written back verifies again; these hold only until a protected key and a tombstone exist', (t) => {
  const w = world(t);
  w.enrolWith();
  const text = w.text();
  const kept = { key: peerKey, name: 'Mac A', link: 'h_abcdefghijklmnop', approval: { text, sig: w.h.sign(text) } } as any;
  assert.equal(w.keys.verifyRecord(kept), true);
  // nothing records a revocation: the kept copy of a record that was removed verifies again when it is written back
  assert.equal(w.keys.verifyRecord(kept), true, 'restored');
  // a process of this user that replaces the key file signs its own approvals
  const mine = helper();
  fs.writeFileSync(w.file, JSON.stringify({ v: 1, key: mine.point, weak: false, at: 0 }));
  assert.equal(w.keys.verifyRecord(kept), false, 'the old proofs fail under the new key');
  const forged = w.text({ name: 'Mallory' });
  assert.equal(
    w.keys.verifyRecord({ ...kept, name: 'Mallory', approval: { text: forged, sig: mine.sign(forged) } }),
    true,
    'but its own are believed',
  );
});

test('reset forgets the enrolled key: no pairing is accepted until one is enrolled again, and it is safe to repeat', (t) => {
  const w = world(t);
  w.enrolWith();
  assert.equal(w.keys.status().available, true);
  w.keys.reset();
  assert.deepEqual(w.keys.status(), { available: false, reason: 'no_approval_helper' });
  assert.ok(!fs.existsSync(w.file));
  w.keys.reset();
  assert.deepEqual(w.enrolWith(), { enrolled: true, weak: false }, 'a key can be enrolled again');
});
