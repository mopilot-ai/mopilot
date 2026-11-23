// Chat titles in push (electron/remote/pushTitles.cjs): opt-in and off by default, a per-pair key derived from the Mac's identity and sent to the phone once over the sealed channel, titles sealed in the documented format, and never in the clear, never for MoMo, never when the key is not ready.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fakeSafe, fs, prim, tempDir } from './support/remoteKit.ts';
import { tick } from './support/async-scenarios.ts';
import { chatRef } from '../shared/remote/ref.mjs';
import fs0 from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { PushTitles, TITLE_EVENT, AAD_PREFIX } = require('../electron/remote/pushTitles.cjs');
const { PUSH_BODY_AAD_PREFIX, PUSH_BODY_PAD_BYTES } = await import('../shared/remote/pushSettings.mjs');
const { createPushRequests } = require('../electron/platform/notifyPush.cjs');
const { Notifier } = require('../electron/platform/notify.cjs');
const { recentIgnored } = require('../electron/ignored.cjs');

function rig(
  o: { pairs?: string[]; identityFails?: boolean; sendFails?: boolean; file?: string; safe?: any; bodyOn?: () => boolean } = {},
) {
  const sent: { pair: string; msg: any }[] = [];
  const heard: ((pairId: string) => void)[] = [];
  let clock = 1000;
  const listeners: ((l: any[]) => void)[] = [];
  let list = (o.pairs ?? ['p1']).map((pairId) => ({ pairId }));
  const sk = prim.randomBytes(32);
  const titles = new PushTitles({
    file: o.file ?? path.join(tempDir(), 'push.key'),
    safe: o.safe ?? fakeSafe(),
    fs,
    prim,
    identity: { get: async () => (o.identityFails ? Promise.reject(new Error('no identity')) : { x: { sk } }) },
    channel: {
      onMessage: (fn: any) => (heard.push(fn), () => heard.splice(heard.indexOf(fn), 1)),
      send: async (pair: string, msg: any) => (o.sendFails ? Promise.reject(new Error('closed')) : void sent.push({ pair, msg })),
    },
    devices: { list: () => list, onChange: (fn: any) => (listeners.push(fn), () => listeners.splice(listeners.indexOf(fn), 1)) },
    now: () => clock,
    ...(o.bodyOn && { bodyOn: o.bodyOn }),
  });
  return {
    titles,
    phoneSpeaks: (pair: string) => heard.forEach((h) => h(pair)),
    advance: (ms: number) => (clock += ms),
    sent,
    sk,
    removePair: (id: string) => ((list = list.filter((p) => p.pairId !== id)), listeners.forEach((l) => l(list))),
    addPair: (id: string) => ((list = [...list, { pairId: id }]), listeners.forEach((l) => l(list))),
  };
}

function open(st: string, key: Uint8Array, ref: string) {
  const raw = Buffer.from(st, 'base64url');
  assert.ok(!st.includes('='));
  const plain = prim.aeadOpen(key, raw.subarray(0, 24), raw.subarray(24), new TextEncoder().encode(AAD_PREFIX + ref));
  return plain && new TextDecoder().decode(plain);
}

test('titles are off by default: no key is sent and nothing is sealed', async () => {
  const r = rig();
  await r.titles.start();
  assert.equal(r.titles.enabled, false);
  assert.equal(r.sent.length, 0);
  assert.equal(r.titles.seal('p1', 'ref', 'Secret chat'), null);
});

test('turning it on sends each pair its key once as a sealed push.titleKey event; a new pair gets its own', async () => {
  const r = rig();
  await r.titles.setEnabled(true);
  await tick();
  assert.equal(r.sent.length, 1);
  const { pair, msg } = r.sent[0];
  assert.equal(pair, 'p1');
  assert.deepEqual([msg.kind, msg.ev], ['event', TITLE_EVENT]);
  assert.match(msg.patch.key, /^[0-9a-f]{64}$/);
  assert.equal(msg.patch.key, Buffer.from(r.titles.keyOf('p1')!).toString('hex'));
  await r.titles.setEnabled(true);
  assert.equal(r.sent.length, 1, 'not again for the same pair');
  r.addPair('p2');
  await tick();
  assert.equal(r.sent.length, 2);
  assert.notEqual(r.sent[1].msg.patch.key, msg.patch.key, 'each pair has its own key');
  r.titles.stop();
  r.addPair('p3');
  assert.equal(r.sent.length, 2);
});

test('a sealed title opens with the pair key under the documented aad and fresh nonces, and is bounded', async () => {
  const r = rig();
  await r.titles.setEnabled(true);
  const a = r.titles.seal('p1', 'ref-1', 'Fix the login bug')!;
  const b = r.titles.seal('p1', 'ref-1', 'Fix the login bug')!;
  assert.notEqual(a, b);
  assert.equal(open(a, r.titles.keyOf('p1')!, 'ref-1'), 'Fix the login bug');
  assert.equal(open(a, r.titles.keyOf('p1')!, 'other-ref'), null);
  assert.equal(open(a, r.titles.keyOf('p2')!, 'ref-1'), null);
  const long = open(r.titles.seal('p1', 'r', 'x'.repeat(500))!, r.titles.keyOf('p1')!, 'r')!;
  assert.ok(long.length <= 120);
  assert.equal(r.titles.seal('p1', 'r', ''), null);
  assert.equal(r.titles.seal('p1', 'r', undefined as any), null);
});

test('a pair whose key was not handed to the channel gets no sealed title', async () => {
  const r = rig({ sendFails: true });
  await r.titles.setEnabled(true);
  await tick();
  assert.equal(r.titles.seal('p1', 'r', 'Title'), null);
  assert.ok(recentIgnored().some((e: any) => e.context === 'send the push title key'));
});

test('the opt-in survives a restart; an unreadable identity leaves titles unsealed and is noted', async () => {
  const file = path.join(tempDir(), 'push.key');
  const safe = fakeSafe();
  await rig({ file, safe }).titles.setEnabled(true);
  const again = rig({ file, safe });
  await again.titles.start();
  assert.equal(again.titles.enabled, true);
  assert.equal(again.sent.length, 0, 'nothing is sent just for starting');
  assert.equal(again.titles.seal('p1', 'r', 'T'), null, 'the first push after a restart keeps the fixed title');
  await tick();
  assert.equal(again.sent.length, 1, 'a restarted Mac hands the key over again; the phone saves it idempotently');
  const broken = rig({ identityFails: true });
  await broken.titles.start();
  assert.equal(broken.titles.keyOf('p1'), null);
  assert.equal(broken.titles.seal('p1', 'r', 'T'), null);
  assert.ok(recentIgnored().some((e: any) => e.context === 'load the push title key'));
});

test('the push hook attaches the sealed title for chats only: never in the clear, never for MoMo', async () => {
  const r = rig();
  await r.titles.setEnabled(true);
  await tick();
  const reqs: any[] = [];
  const hook = createPushRequests({
    pairs: () => ['p1'],
    getKinds: () => ({ turn: true }),
    sink: (q: any) => reqs.push(q),
    seal: (pair: string, ref: string, title: string) => r.titles.seal(pair, ref, title),
  });
  const n = new Notifier({ getMode: () => 'always', show: () => ({ close() {} }), onBanner: hook.onBanner });
  n.notify('turn', 'chat-1', { title: 'Fix the login bug', body: 'private body', chatTitle: 'Fix the login bug' });
  n.notify('momo', 'momo-1', { status: 'needs', title: 'MoMo needs you', chatTitle: 'Plan my week' });
  n.notify('turn', 'chat-2', { title: 'T', body: '', chatTitle: 'T' });
  assert.equal(reqs.length, 3);
  const ref1 = chatRef('p1', 'chat-1');
  assert.equal(open(reqs[0].sealed, r.titles.keyOf('p1')!, ref1), 'Fix the login bug');
  assert.ok(!JSON.stringify(reqs).includes('Fix the login bug'));
  assert.ok(!JSON.stringify(reqs).includes('Plan my week'));
  assert.equal('sealed' in reqs[1], false);
  assert.equal(reqs[1].kind, 'momoNeedsYou');
  assert.equal(open(reqs[2].sealed, r.titles.keyOf('p1')!, chatRef('p1', 'chat-2')), 'T');
  // the key is not ready or titles are off again: the fixed title goes out
  await r.titles.setEnabled(false);
  n.notify('turn', 'chat-3', { title: 'Another' });
  assert.equal('sealed' in reqs[3], false);
});

test('a removed pair is forgotten, so the same pair coming back is handed its key again; rapid switches leave the last one saved', async () => {
  const file = path.join(tempDir(), 'push.key');
  const safe = fakeSafe();
  const r = rig({ file, safe });
  await r.titles.setEnabled(true);
  await tick();
  r.removePair('p1');
  await tick();
  r.addPair('p1');
  await tick();
  assert.equal(r.sent.length, 2);
  await Promise.all([r.titles.setEnabled(false), r.titles.setEnabled(true), r.titles.setEnabled(false)]);
  const again = rig({ file, safe });
  await again.titles.start();
  assert.equal(again.titles.enabled, false);
  // a failed save is reported to the caller and does not block the next one
  safe.broken = true;
  await assert.rejects(r.titles.setEnabled(true));
  assert.equal(r.titles.enabled, false, 'a switch that did not save is not on');
  safe.broken = false;
  await r.titles.setEnabled(true);
});

test('a key whose delivery failed is sent again with the next push, which keeps the fixed title', async () => {
  const r = rig();
  await r.titles.setEnabled(true);
  await tick();
  r.sent.length = 0;
  // simulate a failed first delivery
  r.titles.delivered.delete('p1');
  assert.equal(r.titles.seal('p1', 'r', 'Title'), null);
  await tick();
  assert.equal(r.sent.length, 1);
  assert.equal(typeof r.titles.seal('p1', 'r', 'Title'), 'string');
});

test('nothing is read until a push, the switch or a change of phones needs it; a push before the load keeps the fixed title', async () => {
  let reads = 0;
  const r = rig({ safe: { ...fakeSafe(), decryptString: (b: Buffer) => (reads++, fakeSafe().decryptString(b)) } });
  await tick();
  assert.equal(reads, 0);
  assert.equal(r.titles.seal('p1', 'r', 'T'), null);
  assert.equal(r.titles.ready !== null, true);
  r.addPair('p9');
  await r.titles.start();
});

test('when the phone talks to the Mac again its key is re-sent (at most every five minutes, only to a known pair, only while titles are on)', async () => {
  const r = rig();
  r.phoneSpeaks('p1');
  await tick();
  assert.equal(r.sent.length, 0, 'titles are off');
  await r.titles.setEnabled(true);
  await tick();
  assert.equal(r.sent.length, 1);
  r.phoneSpeaks('stranger');
  await tick();
  assert.equal(r.sent.length, 1, 'not a paired phone');
  r.phoneSpeaks('p1');
  await tick();
  assert.equal(r.sent.length, 2, 'the phone may have just selected this Mac');
  r.phoneSpeaks('p1');
  await tick();
  assert.equal(r.sent.length, 2, 'not again within five minutes');
  r.advance(5 * 60_000);
  r.phoneSpeaks('p1');
  await tick();
  assert.equal(r.sent.length, 3);
  assert.equal(r.sent[2].msg.patch.key, r.sent[0].msg.patch.key);
  r.removePair('p1');
  await tick();
  r.titles.stop();
  r.phoneSpeaks('p1');
  await tick();
  assert.equal(r.sent.length, 3, 'stopped');
});

function openBody(blob: string, key: Uint8Array, ref: string) {
  const raw = Buffer.from(blob, 'base64url');
  const plain = prim.aeadOpen(key, raw.subarray(0, 24), raw.subarray(24), new TextEncoder().encode(PUSH_BODY_AAD_PREFIX + ref));
  return plain && new TextDecoder().decode(plain);
}

test('the push body opt-in: off seals nothing and sends no key; on, the key goes out and the body is sealed under its own AAD', async () => {
  let on = false;
  const r = rig({ bodyOn: () => on });
  await r.titles.start();
  assert.equal(r.titles.sealBody('p1', 'ref', 'Morning brief'), null, 'off: nothing');
  await tick();
  assert.equal(r.sent.length, 0, 'off: no key is sent');
  on = true;
  // the key is not on the phone yet: this one keeps the fixed text, and the key goes out now
  assert.equal(r.titles.sealBody('p1', 'ref', 'Morning brief'), null);
  await tick();
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].msg.ev, TITLE_EVENT);
  const blob = r.titles.sealBody('p1', 'ref', 'Morning brief')!;
  assert.ok(blob && !blob.includes('='));
  assert.equal(openBody(blob, r.titles.keyOf('p1')!, 'ref')!.trim(), 'Morning brief');
  assert.equal(Buffer.from(openBody(blob, r.titles.keyOf('p1')!, 'ref')!).length, PUSH_BODY_PAD_BYTES, 'padded to one length');
  assert.equal(open(blob, r.titles.keyOf('p1')!, 'ref'), null, 'not openable as a title');
  assert.equal(openBody(blob, r.titles.keyOf('p1')!, 'other'), null, 'bound to its ref');
  // every body is one length, whatever the name
  const short = r.titles.sealBody('p1', 'ref', 'A')!;
  assert.equal(short.length, blob.length);
  // no text, or opt-out: nothing
  assert.equal(r.titles.sealBody('p1', 'ref', ''), null);
  on = false;
  assert.equal(r.titles.sealBody('p1', 'ref', 'Morning brief'), null);
});

test('a body longer than the pad is sealed whole, and the opt-in alone makes the phone talk get its key again', async () => {
  let on = true;
  const r = rig({ bodyOn: () => on });
  await r.titles.start();
  r.phoneSpeaks('p1');
  await tick();
  assert.equal(r.sent.length, 1, 'the key goes out while only the body opt-in is on');
  const long = 'x'.repeat(PUSH_BODY_PAD_BYTES + 20);
  assert.equal(openBody(r.titles.sealBody('p1', 'ref', long)!, r.titles.keyOf('p1')!, 'ref'), long);
  on = false;
  r.advance(10 * 60_000);
  r.phoneSpeaks('p1');
  await tick();
  assert.equal(r.sent.length, 1, 'both opt-ins off: no key');
});

test('the shared vectors: the Mac seals each name to exactly the blob the phone and the iOS extension are tested to open', async () => {
  const v = JSON.parse(fs0.readFileSync(path.join(import.meta.dirname, 'fixtures/push-body-vectors.json'), 'utf8'));
  assert.equal(v.aadPrefix, PUSH_BODY_AAD_PREFIX);
  assert.equal(v.padBytes, PUSH_BODY_PAD_BYTES);
  const r = rig({ bodyOn: () => true });
  const key = Uint8Array.from(Buffer.from(v.keyHex, 'hex'));
  r.titles.keyOf = () => key;
  await r.titles.start();
  const nonce = Uint8Array.from(Buffer.from(v.nonceHex, 'hex'));
  const real = prim.randomBytes;
  prim.randomBytes = () => nonce;
  try {
    // the first ask hands the phone its key; the next seals
    for (const { name, sealed } of v.vectors) {
      r.titles.sealBody('p1', v.ref, name);
      assert.equal(r.titles.sealBody('p1', v.ref, name), sealed, name);
    }
  } finally {
    prim.randomBytes = real;
  }
});
