// MoMo's opt-in push body on the phone (A6; mobile/src/push/sealedTitle.ts, payload.ts, dataMessage.ts, the iOS extension's Swift mirror): the shared vectors open, the body is shown only for a single MoMo "needs you" with this phone's titles switch on and a stored key, every failure leaves today's notification exactly, and an old phone, an old Mac or an old relay in the chain gets today's notification too.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { toBase64 } from '../shared/remote/envelope.mjs';
import { PUSH_BODY_AAD_PREFIX, PUSH_BODY_PAD_BYTES } from '../shared/remote/pushSettings.mjs';
import { apnsBody, fcmMessage } from '../relay/src/pushPayload.mjs';
import { parsePushPayload } from '../mobile/src/push/payload';
import { bodyAad, openSealedBody, openSealedTitle, titleAad } from '../mobile/src/push/sealedTitle';
import { buildNotification } from '../mobile/src/push/dataMessage';
import { DEFAULT_PREFS } from '../mobile/src/push/prefs';

const require = createRequire(import.meta.url);
const prim = require('../electron/platform/sodiumPrimitives.cjs').createSodiumPrimitives();
const open = (key: Uint8Array, nonce: Uint8Array, box: Uint8Array, aad: Uint8Array) => prim.aeadOpen(key, nonce, box, aad);
const vectors = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures/push-body-vectors.json'), 'utf8'));
const key = Uint8Array.from(Buffer.from(vectors.keyHex, 'hex'));
const REF = vectors.ref;
const BLOB: string = vectors.vectors[0].sealed;
const titlesOn = async () => ({ ...DEFAULT_PREFS, titles: true });
const titlesOff = async () => ({ ...DEFAULT_PREFS, titles: false });
const keys = async () => [key];
const base = { kind: 'momoNeedsYou', ref: REF, count: 1 };
const build = (data: unknown, o: { prefs?: () => Promise<any>; keys?: () => Promise<Uint8Array[]> } = {}) =>
  buildNotification(data, { keys: o.keys ?? keys, open, prefs: o.prefs ?? titlesOn });
/** A blob sealed under `aad` for `plain`, as the Mac would. */
function seal(plain: Uint8Array, aad: Uint8Array, k = key) {
  const nonce = Uint8Array.from({ length: 24 }, (_, i) => i + 1);
  return toBase64(Uint8Array.from([...nonce, ...prim.aeadSeal(k, nonce, plain, aad)]));
}
const text = (s: string) => new TextEncoder().encode(s);

test('the shared vectors open to the names, padded to one length, and are bound to their ref and to the body AAD', () => {
  assert.equal(vectors.aadPrefix, PUSH_BODY_AAD_PREFIX);
  assert.equal(new TextDecoder().decode(bodyAad('r')), `${PUSH_BODY_AAD_PREFIX}r`);
  for (const { name, sealed } of vectors.vectors) {
    assert.equal(openSealedBody({ sealed, ref: REF, keys: [key], open }), name);
    assert.equal(openSealedBody({ sealed, ref: 'another', keys: [key], open }), null, 'a replay under another handle');
    assert.equal(openSealedTitle({ sealed, ref: REF, keys: [key], open }), null, 'a body is never a title');
  }
  const lengths = new Set(vectors.vectors.map((v: any) => v.sealed.length));
  assert.equal(lengths.size, 1, 'every blob is one length');
  assert.equal(PUSH_BODY_PAD_BYTES, vectors.padBytes);
  // and a title is never a body
  assert.equal(openSealedBody({ sealed: seal(text('Fix the bug'), titleAad(REF)), ref: REF, keys: [key], open }), null);
});

test('a push parses its body only on a MoMo "needs you", and bounded', () => {
  assert.equal(parsePushPayload({ ...base, sb: BLOB })?.sealedBody, BLOB);
  for (const kind of ['needsYou', 'done', 'machineOffline', 'cleared'])
    assert.equal('sealedBody' in (parsePushPayload({ ...base, kind, sb: BLOB }) ?? {}), false, kind);
  for (const sb of ['', 7, null, {}, 'x'.repeat(2049)])
    assert.equal('sealedBody' in (parsePushPayload({ ...base, sb }) ?? {}), false, String(sb).slice(0, 8));
  // everything else about the payload is as it was
  const { sealedBody: _drop, ...rest } = parsePushPayload({ ...base, card: 'c1', sb: BLOB })!;
  assert.deepEqual(rest, parsePushPayload({ ...base, card: 'c1' }));
});

test('with this phone’s titles switch on and the key stored, the routine name is the body and the title stays the fixed text', async () => {
  const n = await build({ ...base, sb: BLOB });
  assert.equal(n?.body, 'Morning brief');
  assert.equal(n?.title, 'MoMo needs you');
  assert.equal(n?.id, `momoNeedsYou:${REF}`);
  assert.deepEqual(n?.data, { kind: 'momoNeedsYou', ref: REF });
});

/** The notification a push gets when nothing about a body is known: today's. */
const today = async (data: any, prefs = titlesOn) => build(data, { prefs });

test('every failure leaves today’s notification exactly: no body key, no error text, no other plaintext', async () => {
  const plain = await today(base);
  assert.equal('body' in plain!, false);
  const cases: Array<[string, any, { prefs?: () => Promise<any>; keys?: () => Promise<Uint8Array[]> }]> = [
    ['titles switch off', { ...base, sb: BLOB }, { prefs: titlesOff }],
    ['no key stored', { ...base, sb: BLOB }, { keys: async () => [] }],
    ['a key that is not the pair’s', { ...base, sb: BLOB }, { keys: async () => [Uint8Array.from({ length: 32 }, (_, i) => i)] }],
    ['several chats merged', { ...base, count: 2, sb: BLOB }, {}],
    ['not a MoMo notice', { kind: 'needsYou', ref: REF, count: 1, sb: BLOB }, {}],
    ['a bad blob', { ...base, sb: 'not-a-blob' }, {}],
    ['a title blob under the body field', { ...base, sb: seal(text('Fix the bug'), titleAad(REF)) }, {}],
    ['a blob for another handle', { ...base, ref: 'other', sb: BLOB }, {}],
    ['too long', { ...base, sb: seal(text('x'.repeat(201)), bodyAad(REF)) }, {}],
    ['only controls', { ...base, sb: seal(text(' \u0007 \u0000 '), bodyAad(REF)) }, {}],
    ['not text', { ...base, sb: seal(Uint8Array.of(0xff, 0xfe, 0xfd), bodyAad(REF)) }, {}],
    ['a key store that throws', { ...base, sb: BLOB }, { keys: async () => Promise.reject(new Error('keychain locked')) }],
  ];
  for (const [label, data, o] of cases) {
    const { sb: _sb, ...withoutBody } = data;
    const got = await build(data, o);
    const expected = await build(withoutBody, o);
    assert.deepEqual(got, expected, label);
    assert.equal(got && 'body' in got, false, label);
  }
  // the message's own words are never shown, a body included
  const spoof = await build({ ...base, sb: BLOB, body: 'Wire the money', title: 'Wire the money', alert: 'x' });
  assert.equal(spoof?.title, 'MoMo needs you');
  assert.equal(spoof?.body, 'Morning brief');
});

test('the body is cleaned like a title: controls become spaces and the Mac’s padding is dropped', async () => {
  const dirty = seal(text('Morning\u0007\nbrief'.padEnd(PUSH_BODY_PAD_BYTES)), bodyAad(REF));
  assert.equal((await build({ ...base, sb: dirty }))?.body, 'Morning brief');
});

test('a new phone with no `sb` (an old Mac, or a new Mac behind an old relay) shows today’s alert, with no body', async () => {
  // old Mac + new relay + new phone: no `sb` is sent
  const oldMac = await build({ ...base });
  assert.equal(oldMac && 'body' in oldMac, false);
  // new Mac + old relay + new phone: an old relay drops `sealedBody`, so the push reaches the phone as an old Mac's
  const message = {
    platform: 'apns',
    token: 't',
    kind: 'momoNeedsYou',
    title: 'MoMo needs you',
    count: 1,
    collapseId: 'c',
    ref: REF,
  } as any;
  const throughOldRelay = apnsBody(message) as any;
  assert.equal('sb' in throughOldRelay, false);
  assert.equal('mutable-content' in throughOldRelay.aps, false);
  assert.deepEqual(await build(throughOldRelay), await build({ ...base }));
});

test('a sealed `sb` reaching an old phone, or a phone whose switch is off, changes nothing it shows', async () => {
  const message = {
    platform: 'apns',
    token: 't',
    kind: 'momoNeedsYou',
    title: 'MoMo needs you',
    count: 1,
    collapseId: 'c',
    ref: REF,
  } as any;
  // new Mac + new relay + old phone: the relay's alert is exactly the old one, plus fields an old reader never looks at (`sb`, and `mutable-content` that only starts the extension, which acts on `st` alone)
  const throughNewRelay = apnsBody({ ...message, sealedBody: BLOB }) as any;
  const { sb, ...apsExtras } = throughNewRelay;
  const { 'mutable-content': mutable, ...aps } = apsExtras.aps;
  assert.equal(sb, BLOB);
  assert.equal(mutable, 1);
  assert.deepEqual({ ...apsExtras, aps }, apnsBody(message));
  const fcm = fcmMessage({ ...message, platform: 'fcm', sealedBody: BLOB }) as any;
  const { sb: _fcmSb, ...fcmRest } = fcm.data;
  assert.deepEqual(fcmRest, (fcmMessage({ ...message, platform: 'fcm' }) as any).data);
  // an old phone's reader (`kind`, `ref`, `count`, `st`, `card`) ignores the new field and gets what it gets today
  const oldReader = (data: any) => ({ kind: data.kind, ref: data.ref, count: data.count, st: data.st, card: data.card });
  assert.deepEqual(oldReader(fcm.data), oldReader((fcmMessage({ ...message, platform: 'fcm' }) as any).data));
  // new phone, new everything, but the person's switch is off here: today's notification
  assert.deepEqual(await build({ ...base, sb: BLOB }, { prefs: titlesOff }), await build({ ...base }, { prefs: titlesOff }));
});

test('the iOS extension mirrors it: its own AAD, body only for a single MoMo "needs you", the title path never reads `sb`, no error text', () => {
  const swift = (f: string) => fs.readFileSync(path.join(import.meta.dirname, '../mobile/plugins', f), 'utf8');
  const sealedTitle = swift('Shared/SealedTitle.swift');
  const service = swift('NotificationService.swift');
  assert.ok(sealedTitle.includes(`static let bodyAadPrefix = "${PUSH_BODY_AAD_PREFIX}"`));
  assert.match(
    sealedTitle,
    /static func openBody\(_ sealed: String, ref: String, keys: \[\[UInt8\]\]\) -> String\? \{\s+open\(sealed, ref: ref, keys: keys, aadPrefix: bodyAadPrefix\)/,
  );
  assert.match(sealedTitle, /plain\.count <= 200/, 'the same bound as the TS opener');
  // the body is opened only for kind momoNeedsYou, from `sb`, never merged
  const openBody = service.slice(service.indexOf('static func openBody'), service.indexOf('/// The last outcome'));
  assert.match(
    openBody,
    /\(info\["kind"\] as\? String\) == "momoNeedsYou", let sealed = info\["sb"\] as\? String, let ref = info\["ref"\] as\? String else \{ return nil \}/,
  );
  assert.match(openBody, /if isMerged\(info\) \{ return nil \}/);
  assert.match(openBody, /SealedTitle\.openBody\(sealed, ref: ref, keys: SealedTitle\.titleKeys\(\)\)/);
  // the body is set only from the opened text; the title path reads `st` alone
  assert.match(service, /let body = NotificationService\.openBody\(content\.userInfo\) \{ content\.body = body \}/);
  const openTitle = service.slice(service.indexOf('static func openTitle'), service.indexOf('static func openBody'));
  assert.ok(!openTitle.includes('"sb"') && openTitle.includes('"st"'));
  assert.equal([...service.matchAll(/content\.body = /g)].length, 1, 'one place sets the body');
  assert.ok(!/content\.body = ["'(]/.test(service) && !service.includes('localizedDescription'), 'no literal or error text');
});
