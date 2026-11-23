// The Mac's sealed channel (electron/remote/channel.cjs) over the real device list and libsodium, with a fake relay and a simulated phone: sealing in order, opening, request-id idempotency, strict counters (replay, rewind and gap close the session), forged and malformed frames, hellos, saved ratchets across a restart, pairs and presence as the remote service reads them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as E from '../shared/remote/envelope.mjs';
import { MAX_SKIP } from '../shared/remote/crypto.mjs';
import { crypto } from './support/remotePhone.ts';
import { deferred, tick } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { SEEN_PER_PAIR, SEEN_MAX_BYTES, CHECKPOINT_AHEAD, RESYNC_EVENT } = require('../electron/remote/channel.cjs');

import { until, pairing, msg, request, wireOf, drain, openOut, rig } from './support/remoteChannelRig.ts';

test('send: a message is sealed under the pair’s next counter, in call order, and the phone opens it', async () => {
  const r = await rig();
  await Promise.all([
    r.channel.send(r.phone.pairId, msg('m_1')),
    r.channel.send(r.phone.pairId, msg('m_2')),
    r.channel.send(r.phone.pairId, msg('m_3')),
  ]);
  assert.deepEqual(
    r.relay.sent.map((w) => [w.pair, w.dir, w.ctr]),
    [1, 2, 3].map((n) => [r.phone.pairId, 'm2p', n]),
  );
  assert.deepEqual(
    r.relay.sent.map((w) => openOut(r.phone, w).id),
    ['m_1', 'm_2', 'm_3'],
  );
});

test('send: an unknown pair, a relay that refuses, and a message over 256 KB all reject', async () => {
  const r = await rig();
  await assert.rejects(r.channel.send('p_nobody0000', msg('m_1')), /Unknown pair/);
  r.relay.outcome = 'dropped';
  await assert.rejects(r.channel.send(r.phone.pairId, msg('m_2')), /not accepting/);
  r.relay.outcome = 'sent';
  await assert.rejects(r.channel.send(r.phone.pairId, msg('m_3', { patch: 'x'.repeat(E.MAX_FRAME_BYTES) })), { code: 'size' });
  await assert.rejects(r.channel.send(r.phone.pairId, msg('x'.repeat(65))), { code: 'message' }); // a sender's bad id is refused before it takes a counter
  await r.channel.send(r.phone.pairId, msg('m_4'));
  // the refused frame gave its counter back, so the next one reuses it and the phone sees no gap
  assert.deepEqual(
    r.relay.sent.map((f: any) => f.ctr),
    [1, 1],
    'a failed send does not break later ones',
  );
});

test('send: queued while the relay is down counts as sent (the relay client holds it)', async () => {
  const r = await rig();
  r.relay.outcome = 'queued';
  await r.channel.send(r.phone.pairId, msg('m_1'));
  assert.equal(r.relay.sent.length, 1);
});

test('receive: the phone’s messages reach the listeners with their pair id; a throwing listener and an unsubscribed one do not matter', async () => {
  const r = await rig();
  r.channel.onMessage(() => {
    throw new Error('service broke');
  });
  const off = r.channel.onMessage(() => assert.fail('unsubscribed'));
  off();
  r.relay.emit('frame', wireOf(r.phone, request('m_1')));
  r.relay.emit('frame', wireOf(r.phone, { id: 'a_1', t: 2, kind: 'ack', inReplyTo: 'x' }));
  await drain(r);
  assert.deepEqual(
    r.delivered.map(([p, m]) => [p, m.id]),
    [
      [r.phone.pairId, 'm_1'],
      [r.phone.pairId, 'a_1'],
    ],
  );
});

test('idempotency: a retried request is not delivered twice, and the reply already given goes out again', async () => {
  const r = await rig();
  r.relay.emit('frame', wireOf(r.phone, request('m_1')));
  r.relay.emit('frame', wireOf(r.phone, request('m_1')));
  await drain(r);
  assert.equal(r.delivered.length, 1, 'a duplicate while the request is still being worked on is dropped');
  assert.equal(r.relay.sent.length, 0);
  await r.channel.send(r.phone.pairId, { id: 'm_r', t: 3, kind: 'reply', inReplyTo: 'm_1', ok: true, result: { n: 1 } });
  r.relay.emit('frame', wireOf(r.phone, request('m_1')));
  await drain(r);
  await until(() => r.relay.sent.length === 2);
  assert.equal(r.delivered.length, 1);
  assert.equal(r.relay.sent.length, 2, 'the stored reply is sent again, sealed under a new counter');
  assert.deepEqual(
    openOut(r.phone, r.relay.sent[1]),
    openOut(
      {
        ...r.phone,
        phone: {
          ...r.phone.phone,
          rx: crypto.createReceiver({ pair: r.phone.pairId, dir: 'm2p', chain: E.fromHex(r.phone.record.tx.chain), ctr: 0 }),
        },
      } as any,
      r.relay.sent[0],
    ),
  );
  assert.notEqual(r.relay.sent[1].ctr, r.relay.sent[0].ctr);
});

test('idempotency: an answer to a request nobody asked is not remembered, and a reply that fails to send again is noted', async () => {
  const r = await rig();
  await r.channel.send(r.phone.pairId, { id: 'm_r', t: 3, kind: 'reply', inReplyTo: 'never-asked', ok: true });
  r.relay.emit('frame', wireOf(r.phone, request('never-asked')));
  await drain(r);
  assert.equal(r.delivered.length, 1, 'it is a new request');
  r.relay.emit('frame', wireOf(r.phone, request('m_2')));
  await drain(r);
  await r.channel.send(r.phone.pairId, { id: 'm_r2', t: 3, kind: 'reply', inReplyTo: 'm_2', ok: true });
  r.relay.outcome = 'dropped';
  r.relay.emit('frame', wireOf(r.phone, request('m_2')));
  await drain(r);
  await tick();
  assert.equal(r.delivered.length, 2);
});

test('idempotency: the last 1,000 request ids per pair are remembered, the oldest forgotten first', async () => {
  const r = await rig();
  for (let i = 0; i <= SEEN_PER_PAIR; i++) {
    r.relay.emit('frame', wireOf(r.phone, request(`m_${i}`)));
    if (i % 32 === 31) await drain(r);
  }
  await drain(r);
  assert.equal(r.delivered.length, SEEN_PER_PAIR + 1);
  r.relay.emit('frame', wireOf(r.phone, request(`m_${SEEN_PER_PAIR}`)));
  await drain(r);
  assert.equal(r.delivered.length, SEEN_PER_PAIR + 1, 'the newest is still remembered');
  r.relay.emit('frame', wireOf(r.phone, request('m_0')));
  await drain(r);
  assert.equal(r.delivered.length, SEEN_PER_PAIR + 2, 'the oldest was forgotten');
});

test('idempotency: remembered replies are bounded by size too, and the newest is always kept', async () => {
  const r = await rig();
  const big = 'x'.repeat(200_000);
  const count = Math.ceil(SEEN_MAX_BYTES / big.length) + 2;
  for (let i = 0; i < count; i++) {
    r.relay.emit('frame', wireOf(r.phone, request(`m_${i}`)));
    await drain(r);
    await r.channel.send(r.phone.pairId, { id: `r_${i}`, t: 3, kind: 'reply', inReplyTo: `m_${i}`, ok: true, result: { big } });
  }
  const before = r.delivered.length;
  r.relay.emit('frame', wireOf(r.phone, request(`m_${count - 1}`)));
  await drain(r);
  assert.equal(r.delivered.length, before, 'the newest reply is still remembered');
  r.relay.emit('frame', wireOf(r.phone, request('m_0')));
  await drain(r);
  assert.equal(r.delivered.length, before + 1, 'the oldest was let go to stay under the budget');
});

test('idempotency: each pair has its own memory', async () => {
  const a = pairing('phone-1', 'p_pairedphone1');
  const b = pairing('phone-2', 'p_pairedphone2');
  const r = await rig({ phones: [a, b] });
  r.relay.emit('frame', wireOf(a, request('m_1')));
  r.relay.emit('frame', wireOf(b, request('m_1')));
  await Promise.all([drain(r, a), drain(r, b)]);
  assert.deepEqual(
    r.delivered.map(([p]) => p),
    ['p_pairedphone1', 'p_pairedphone2'],
  );
});

test('counters: a replayed or rewound frame is dropped and counted; the session stays open and the next frame works', async () => {
  const r = await rig();
  const closed: any[] = [];
  r.channel.onPairClosed((e: any) => closed.push(e));
  const first = wireOf(r.phone, msg('m_1'));
  const second = wireOf(r.phone, msg('m_2'));
  r.relay.emit('frame', second);
  r.relay.emit('frame', first);
  r.relay.emit('frame', second);
  await drain(r);
  assert.deepEqual(closed, [], 'nothing a sender can do with old frames ends the session');
  assert.equal(r.channel.stats.duplicates, 2);
  assert.equal(r.relay.sent.length, 0, 'and the phone is not told anything');
  r.relay.emit('frame', wireOf(r.phone, msg('m_3')));
  await drain(r);
  assert.deepEqual(
    r.delivered.map(([, m]) => m.id),
    ['m_2', 'm_3'],
  );
});

test('counters: a gap beyond the limit is dropped and the phone is told once a minute; the session stays open', async () => {
  let t = 1_000_000;
  const r = await rig({ now: () => t });
  const closed: string[] = [];
  r.channel.onPairClosed((e: any) => closed.push(e.code));
  const far = wireOf(r.phone, msg('m_1'));
  r.relay.emit('frame', { ...far, ctr: MAX_SKIP + 2 });
  await drain(r);
  await until(() => r.relay.sent.length === 1);
  const notice = openOut(r.phone, r.relay.sent[0]);
  assert.deepEqual([notice.ev, notice.kind, notice.patch], [RESYNC_EVENT, 'event', { reason: 'gap' }]);
  // a few seconds later, still inside the minute
  t += 5_000;
  r.relay.emit('frame', { ...far, ctr: MAX_SKIP + 3 });
  await drain(r);
  assert.equal(r.relay.sent.length, 1, 'not told again within the minute');
  t += 61_000;
  r.relay.emit('frame', { ...far, ctr: MAX_SKIP + 4 });
  await drain(r);
  await until(() => r.relay.sent.length === 2);
  assert.deepEqual(closed, []);
  assert.deepEqual([r.channel.stats.gaps, r.channel.stats.throttled], [3, 0]);
  r.relay.emit('frame', wireOf(r.phone, msg('m_ok')));
  await drain(r);
  assert.equal(r.delivered.length, 1, 'a frame in order still opens');
});

test('frames that are forged, malformed or for no pair are dropped and counted, never answered', async () => {
  const r = await rig();
  const good = wireOf(r.phone, msg('m_1'));
  r.relay.emit('frame', null);
  r.relay.emit('frame', { ...good, pair: 'x' });
  r.relay.emit('frame', { ...good, box: '@@' });
  r.relay.emit('frame', { ...good, pair: 'p_nobodyhere1' });
  r.relay.emit('frame', { ...good, box: E.toBase64(new Uint8Array(40)) });
  const notJson = E.toWire(r.phone.phone.tx.seal(E.utf8('plain text, not a message')));
  r.relay.emit('frame', notJson);
  r.relay.emit('frame', wireOf(r.phone, { id: '', kind: 'event' }));
  assert.equal(r.delivered.length, 0);
  await drain(r);
  assert.equal(r.channel.droppedFrames, 7);
  assert.equal(r.relay.sent.length, 0);
  r.relay.emit('frame', wireOf(r.phone, msg('m_2')));
  await drain(r);
  assert.equal(r.delivered.length, 1, 'the receiver stayed in step through all of it');
});

test('hello: a frame of counter 0 goes to the pairing service, and a failing one is contained', async () => {
  const seen: any[] = [];
  const r = await rig({
    onHello: (f: any) => {
      seen.push(f);
      throw new Error('pairing broke');
    },
  });
  const hello = { pair: 'p_somenewpair', dir: 'p2m', ctr: 0, nonce: 'AA==', box: 'AA==' };
  r.relay.emit('frame', hello);
  await tick();
  assert.deepEqual([seen[0].pair, seen[0].ctr, seen[0].box], ['p_somenewpair', 0, Uint8Array.of(0)]);
  const bare = await rig();
  bare.relay.emit('frame', hello);
  await tick();
  assert.equal(bare.delivered.length, 0);
});

test('saved ratchets: the send side is saved 64 counters ahead, so a restart never reuses a counter', async () => {
  const r = await rig();
  let writes = 0;
  const update = r.devices.update.bind(r.devices);
  r.devices.update = (...a: any[]) => (a[1].tx && writes++, update(...a));
  for (let i = 0; i < CHECKPOINT_AHEAD; i++) await r.channel.send(r.phone.pairId, msg(`m_${i}`));
  assert.equal(writes, 1);
  assert.equal(r.devices.get('phone-1').tx.ctr, CHECKPOINT_AHEAD);
  await r.channel.send(r.phone.pairId, msg('m_next'));
  assert.equal(writes, 2);
  const lastUsed = r.relay.sent.at(-1).ctr;
  const again = await r.restart();
  await again.channel.send(r.phone.pairId, msg('after'));
  const resumed = again.relay.sent[0];
  assert.ok(resumed.ctr > lastUsed, `${resumed.ctr} is past ${lastUsed}`);
  assert.equal(openOut(r.phone, resumed).id, 'after', 'the phone skips the gap');
});

test('saved ratchets: the receive side and last-seen are saved, so a replay after a restart is refused', async () => {
  const r = await rig();
  const f1 = wireOf(r.phone, msg('m_1'));
  const f2 = wireOf(r.phone, msg('m_2'));
  r.relay.emit('frame', f1);
  r.relay.emit('frame', f2);
  await until(() => r.devices.get('phone-1').rx.ctr === 2);
  const d = r.devices.get('phone-1');
  assert.equal(typeof d.lastSeenAt, 'number');
  const again = await r.restart();
  const got: unknown[] = [];
  again.channel.onMessage((_pair: string, m: unknown) => got.push(m));
  again.relay.emit('frame', f2);
  await again.channel.sessions.get(r.phone.pairId).receiving;
  assert.equal(again.channel.stats.duplicates, 1, 'refused after the restart, without ending the session');
  assert.deepEqual(got, []);
  const g = await (async () => {
    const x = await r.restart();
    return x;
  })();
  g.relay.emit('frame', wireOf(r.phone, msg('m_3')));
  assert.equal(g.devices.get('phone-1').rx.ctr, 2, 'a stopped channel saves nothing more');
});

test('saved ratchets: frames in quick succession are written one at a time and the newest state is the one that lands', async () => {
  const r = await rig();
  const gate = deferred<void>();
  const update = r.devices.update.bind(r.devices);
  let inFlight = 0;
  let peak = 0;
  const seenCtr: number[] = [];
  r.devices.update = async (id: string, patch: any) => {
    if (!patch.rx) return update(id, patch);
    inFlight++;
    peak = Math.max(peak, inFlight);
    seenCtr.push(patch.rx.ctr);
    await gate.promise;
    inFlight--;
    return update(id, patch);
  };
  for (let i = 0; i < 4; i++) r.relay.emit('frame', wireOf(r.phone, msg(`m_${i}`)));
  gate.resolve();
  await until(() => r.devices.get('phone-1').rx.ctr === 4);
  assert.equal(peak, 1);
  assert.deepEqual(seenCtr, [1, 2, 3, 4]);
});

test('send: a failed checkpoint write rejects that send and a later one tries again', async () => {
  const r = await rig();
  const update = r.devices.update.bind(r.devices);
  let fail = true;
  r.devices.update = async (id: string, patch: any) => {
    if (patch.tx && fail) throw new Error('disk full');
    return update(id, patch);
  };
  await assert.rejects(r.channel.send(r.phone.pairId, msg('m_1')), /disk full/);
  assert.equal(r.relay.sent.length, 0, 'nothing is sent that a restart could repeat');
  fail = false;
  await r.channel.send(r.phone.pairId, msg('m_2'));
  assert.equal(r.relay.sent.length, 1);
});

test('send: a phone unpaired while its checkpoint is being saved gets nothing', async () => {
  const r = await rig();
  const gate = deferred<void>();
  const update = r.devices.update.bind(r.devices);
  r.devices.update = async (id: string, patch: any) => (patch.tx && (await gate.promise), update(id, patch));
  const sending = r.channel.send(r.phone.pairId, msg('m_1'));
  const caught = sending.catch((e: Error) => e.message);
  const removing = r.devices.remove('phone-1');
  gate.resolve();
  await removing.catch(() => undefined);
  assert.match(String(await caught), /being changed|Unknown pair/);
  assert.equal(r.relay.sent.length, 0);
});

test('a re-pair while the old pair still has a save in flight: the old pair’s write does not land on the new one', async () => {
  const r = await rig();
  const gate = deferred<void>();
  const update = r.devices.update.bind(r.devices);
  r.devices.update = async (...a: any[]) => (a[1].rx && (await gate.promise), update(...a));
  r.relay.emit('frame', wireOf(r.phone, msg('m_1')));
  const repair = pairing('phone-1', 'p_repairedphone');
  await r.devices.add(repair.record);
  gate.resolve();
  await new Promise((res) => setTimeout(res, 50));
  const d = r.devices.get('phone-1');
  assert.deepEqual([d.pairId, d.rx.ctr, d.rx.chain], ['p_repairedphone', 0, repair.record.rx.chain]);
});

test('pairs: the pair ids, and a listener told when phones are paired, replaced or removed — not on every save', async () => {
  const r = await rig();
  const heard: string[][] = [];
  r.channel.onPairsChanged((p: string[]) => heard.push(p));
  r.channel.onPairsChanged(() => {
    throw new Error('listener broke');
  });
  const off = r.channel.onPairsChanged(() => assert.fail('unsubscribed'));
  off();
  assert.deepEqual(r.channel.pairs(), ['p_pairedphone1']);
  await r.devices.update('phone-1', { lastSeenAt: 5 });
  assert.deepEqual(heard, []);
  const second = pairing('phone-2', 'p_pairedphone2');
  await r.devices.add(second.record);
  const repair = pairing('phone-1', 'p_repairedphone');
  await r.devices.add(repair.record);
  await r.devices.remove('phone-2');
  assert.deepEqual(heard, [['p_pairedphone1', 'p_pairedphone2'], ['p_pairedphone2', 'p_repairedphone'], ['p_repairedphone']]);
  await assert.rejects(r.channel.send('p_pairedphone1', msg('m_1')), /Unknown pair/);
  await r.channel.send('p_repairedphone', msg('m_2'));
  assert.equal(r.relay.sent[0].pair, 'p_repairedphone');
});

test('presence: online while the relay is up, sleeping when the Mac said so, gone when the relay is down or the pair unknown', async () => {
  const r = await rig();
  assert.equal(r.channel.presence(r.phone.pairId), 'online');
  r.relay.presence = 'sleeping';
  assert.equal(r.channel.presence(r.phone.pairId), 'sleeping');
  r.relay.state = 'backoff';
  assert.equal(r.channel.presence(r.phone.pairId), 'gone');
  r.relay.state = 'open';
  assert.equal(r.channel.presence('p_nobody0000'), 'gone');
});

test('relay events: a pair the relay removed is forgotten here; other events and unknown pairs change nothing', async () => {
  const r = await rig();
  r.relay.emit('event', { ev: 'pair.joined', pair: r.phone.pairId });
  r.relay.emit('event', { ev: 'mailbox.dropped', pair: r.phone.pairId });
  r.relay.emit('event', { ev: 'pair.removed', pair: 'p_nobody0000' });
  r.relay.emit('event', { ev: 'pair.removed' });
  r.relay.emit('event', null);
  await tick();
  assert.deepEqual(r.channel.pairs(), [r.phone.pairId]);
  const heard: string[][] = [];
  r.channel.onPairsChanged((p: string[]) => heard.push(p));
  r.relay.emit('event', { ev: 'pair.removed', pair: r.phone.pairId, reason: 'revoked' });
  await until(() => r.devices.list().length === 0);
  assert.deepEqual(heard, [[]]);
  assert.equal(r.devices.list().length, 0);
});

test('relay events: a removal that cannot be saved closes the connection and keeps a local recovery entry', async () => {
  const r = await rig();
  r.devices.removePair = async () => Promise.reject(new Error('disk full'));
  r.relay.emit('event', { ev: 'pair.removed', pair: r.phone.pairId });
  await tick();
  assert.deepEqual(r.channel.pairs(), []);
  assert.equal(r.devices.list().length, 1);
  assert.equal(r.devices.isRetired(r.phone.pairId), true);
});

test('stop: the channel lets go of the relay and the list, and forgets its pairs', async () => {
  const r = await rig();
  assert.equal(r.relay.listeners(), 5);
  r.channel.stop();
  assert.equal(r.relay.listeners(), 0);
  assert.deepEqual(r.channel.pairs(), []);
  r.relay.emit('frame', wireOf(r.phone, msg('m_1')));
  assert.equal(r.delivered.length, 0);
});
