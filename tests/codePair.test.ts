// Pairing two Macs by a code, the protocol layer (shared/host/codePair.mjs, #5576 R2a), part one: the code and its parts, the associated data, a whole run of exactly four messages (accepted and denied) on both primitive sets the product uses, and what each failure does and leaves behind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { MAX_BOX_CHARS } from '../relay/src/rendezvous.mjs';
import { A, B, HINT, ID, OTHER, SETS, cp, createCrypto, crypto, device, json, run, shape, walk } from './support/host/codePairKit.ts';

test('a code: 5 secret characters drawn without bias, typed in any case with spaces or dashes, refused when a character is not of the alphabet, shown 4-4', () => {
  // bytes at or above 248 (the largest multiple of 31 below 256) are thrown away
  const bytes = [255, 250, 248, 0, 1, 2, 30, 31, 62, 247];
  const secret = cp.newSecret(() => Uint8Array.from(bytes));
  assert.equal(secret, [0, 1, 2, 30, 0].map((i) => cp.ALPHABET[i]).join(''), 'the first five bytes below 248, in order');
  assert.match(cp.newSecret(crypto.prim.randomBytes), /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/);
  assert.deepEqual(cp.parseCode('k7qm-x2f9'), { hint: 'K7Q', secret: 'MX2F9' });
  assert.deepEqual(cp.parseCode(' K7QM X2F9 '), { hint: 'K7Q', secret: 'MX2F9' });
  for (const bad of ['K7QM-X2F', 'K7QM-X2F90', 'K7QM-X2FO', 'K7QM-X2FI', 'K7QM-X2F1', 'K7QM-X2F0', 'K7QM-X2FL', '', 5, null, 'é7QM-X2F9'])
    assert.equal(cp.parseCode(bad as any), null, String(bad));
  assert.equal(cp.formatCode('K7Q', 'MX2F9'), 'K7QM-X2F9');
});

test('associated data: its label, role, device key, ephemeral key, nonce, offer and claim, and nothing else is read', () => {
  const part = { device: A.pub, eph: new Uint8Array(32).fill(2), nonce: new Uint8Array(16).fill(3), rendezvousId: ID, claims: 4 };
  const ad = cp.adOf('initiator', part);
  const parsed = cp.parseAd(ad, 'initiator') as any;
  assert.deepEqual([parsed.device, parsed.eph[0], parsed.nonce[0], parsed.rendezvousId, parsed.claims], [A.pub, 2, 3, ID, '4']);
  assert.equal(cp.parseAd(ad, 'responder'), null, 'the other role');
  assert.equal(cp.parseAd(ad.slice(0, -1), 'initiator'), null, 'cut short');
  assert.equal(cp.parseAd(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]), 'initiator'), null, 'a length that never ends');
  assert.equal(cp.parseAd(new Uint8Array([0x80]), 'initiator'), null);
  assert.equal(cp.parseAd(new Uint8Array([200, 1]), 'initiator'), null, 'a length past the end');
  assert.equal(cp.parseAd(new Uint8Array(0), 'initiator'), null);
  assert.equal(cp.parseAd(new Uint8Array(7), 'initiator'), null);
  // sizes: a device key of 31 bytes, a nonce of 15 or 17
  for (const bad of [
    { device: new Uint8Array(31) },
    { nonce: new Uint8Array(15) },
    { nonce: new Uint8Array(17) },
    { eph: new Uint8Array(33) },
  ])
    assert.equal(cp.parseAd(cp.adOf('initiator', { ...part, ...bad }), 'initiator'), null, Object.keys(bad)[0]);
});

for (const [aName, aSet] of Object.entries(SETS)) {
  for (const [bName, bSet] of Object.entries(SETS)) {
    test(`a whole run is four messages, one each, and both sides end with the same pair root, the same safety number and each other’s keys and names (initiator on ${aName}, responder on ${bName})`, () => {
      const ca = createCrypto(aSet());
      const cb = createCrypto(bSet());
      const da = device('Work MacBook', ca);
      const db = device('Studio Mac', cb);
      const a = cp.createInitiator({
        crypto: ca,
        secret: 'MX2F9',
        hint: HINT,
        rendezvousId: ID,
        claims: 1,
        device: da,
        budget: cp.createRunBudget(),
      });
      const b = cp.createResponder({
        crypto: cb,
        secret: 'MX2F9',
        hint: HINT,
        rendezvousId: ID,
        claims: 1,
        device: db,
        budget: cp.createRunBudget(),
      });
      const m1 = a.first();
      const m2 = b.receive(m1);
      const m3 = a.second(m2);
      const seen = b.receive3(m3);
      const answer = b.answer(true) as any;
      const end = a.finish(answer.message) as any;
      assert.deepEqual([seen.peerName, [...seen.peerDevice]], ['Work MacBook', [...da.pub]]);
      assert.equal(end.denied, false);
      assert.deepEqual([...end.root], [...answer.root]);
      assert.deepEqual([end.peerName, [...end.peerDevice]], ['Studio Mac', [...db.pub]]);
      assert.match(seen.safety, /^\d{20}$/);
      assert.equal(seen.safety, end.safety, 'the two Macs show the same number');
      for (const m of [m1, m2, m3, answer.message]) assert.ok(m.length <= MAX_BOX_CHARS, `a message of ${m.length} characters`);
    });
  }
}

test('the safety number shows as soon as the other side’s tag checked out, a finished run keeps nothing, and two runs have two roots', () => {
  const { a, b } = run();
  const m2 = b.receive(a.first());
  assert.equal(a.safety, null);
  const m3 = a.second(m2);
  assert.match(a.safety, /^\d{20}$/);
  assert.equal(b.receive3(m3).safety, a.safety);
  a.finish(b.answer(true).message);
  assert.equal(a.safety, null);
  const x = walk().b.answer(true).root;
  assert.notDeepEqual([...x], [...walk().b.answer(true).root]);
});

test('a denied run is a sealed answer, and the pair root never exists', () => {
  const { a, b } = run();
  b.receive3(a.second(b.receive(a.first())));
  const answer = b.answer(false);
  assert.equal(answer.root, undefined);
  assert.deepEqual(a.finish(answer.message), { denied: true });
});

test('a wrong secret ends the run at the initiator before it reveals anything: it never sends a third message; the same typed code is not a second run', () => {
  const { a, b } = run({ a: { secret: 'MX2F8' } });
  const m2 = b.receive(a.first());
  assert.throws(
    () => a.second(m2),
    (e: any) => e.code === 'bad_confirmation',
  );
  assert.throws(
    () => a.second(m2),
    (e: any) => e.code === 'out_of_turn',
    'and it does not try again',
  );
  const x = run({ b: { secret: 'ZZZZZ' } });
  assert.throws(
    () => x.a.second(x.b.receive(x.a.first())),
    (e: any) => e.code === 'bad_confirmation',
  );
  // a hint the two sides do not share is in the channel: the confirmation fails
  const h = run({ b: { hint: 'ZZZ' } });
  assert.throws(
    () => h.a.second(h.b.receive(h.a.first())),
    (e: any) => e.code === 'bad_confirmation',
  );
});

test('a message of another claim or offer, a changed message and a bad point are refused; a failed step leaves no run behind', () => {
  const old = run({ claims: 1 });
  const first1 = old.a.first();
  assert.throws(
    () => run({ claims: 2 }).b.receive(first1),
    (e: any) => e.code === 'bad_message',
  );
  assert.throws(
    () => run({ b: { rendezvousId: OTHER } }).b.receive(first1),
    (e: any) => e.code === 'bad_message',
  );
  // a relay that rewrites the offer so that this responder accepts it: the reply names the offer the responder is in, and the initiator finds the mismatch
  const rewrite = (m: string, rendezvousId: string, claims: number) => {
    const f = json(m);
    const role = f.tag ? 'responder' : 'initiator';
    const ad = cp.parseAd(cp.unb64u(f.ad) as Uint8Array, role) as any;
    const again = cp.adOf(role, { device: ad.device, eph: ad.eph, nonce: ad.nonce, rendezvousId, claims });
    return shape({ ...f, ad: cp.b64u(again) });
  };
  const swap = run({ b: { rendezvousId: OTHER } });
  const swapped = swap.b.receive(rewrite(swap.a.first(), OTHER, 1));
  assert.throws(
    () => swap.a.second(swapped),
    (e: any) => e.code === 'bad_message',
  );
  const both = run({ b: { rendezvousId: OTHER } });
  const back = rewrite(both.b.receive(rewrite(both.a.first(), OTHER, 1)), ID, 1);
  assert.throws(
    () => both.a.second(back),
    (e: any) => e.code === 'bad_confirmation',
  );
  // the responder's associated data changed on the way: the tag no longer fits
  const t = run();
  const reply = json(t.b.receive(t.a.first()));
  const ad = Buffer.from(reply.ad, 'base64url');
  ad[40] = (ad[40] ?? 0) ^ 1;
  assert.throws(
    () => t.a.second(shape({ ...reply, ad: cp.b64u(ad) })),
    (e: any) => e.code === 'bad_confirmation',
  );
  // not this protocol, a point that is no point, the neutral element
  const first = json(run().a.first());
  for (const bad of [
    '!!',
    cp.b64u(new TextEncoder().encode('[]')),
    shape({ Y: first.Y }),
    shape({ ...first, extra: 'AA' }),
    shape({ ...first, Y: 5 }),
    shape({ ...first, ad: 'AAAA' }),
  ])
    assert.throws(
      () => run().b.receive(bad),
      (e: any) => e.code === 'bad_message',
    );
  for (const Y of [new Uint8Array(32), new Uint8Array(32).fill(255), new Uint8Array(33)])
    assert.throws(
      () => run().b.receive(shape({ ...first, Y: cp.b64u(Y) })),
      (e: any) => e.code === 'bad_message',
    );
  // a message of the wrong role (a reflection of the responder's own message) is not a first message
  const own = run();
  const echoed = own.b.receive(own.a.first());
  assert.throws(
    () => run().b.receive(echoed),
    (e: any) => e.code === 'bad_message',
  );
  // a first message with an ephemeral key of low order: exactly bad_message, and nothing of the run is left for a later tag to be checked against
  const w = run();
  const real = json(w.a.first());
  const evil = cp.adOf('initiator', { device: A.pub, eph: new Uint8Array(32), nonce: new Uint8Array(16), rendezvousId: ID, claims: 1 });
  assert.throws(
    () => w.b.receive(shape({ Y: real.Y, ad: cp.b64u(evil) })),
    (e: any) => e.code === 'bad_message',
  );
  assert.throws(
    () => w.b.receive3(shape({ tag: cp.b64u(new Uint8Array(64)), sealed: cp.b64u(new Uint8Array(60)) })),
    (e: any) => e.code === 'out_of_turn',
  );
  const v = run();
  const m2v = v.b.receive(v.a.first());
  const bad2 = json(m2v);
  assert.throws(
    () =>
      v.a.second(
        shape({
          ...bad2,
          ad: cp.b64u(
            cp.adOf('responder', { device: B.pub, eph: new Uint8Array(32), nonce: new Uint8Array(16), rendezvousId: ID, claims: 1 }),
          ),
        }),
      ),
    (e: any) => ['bad_message', 'bad_confirmation'].includes(e.code),
  );
  assert.throws(
    () => v.a.finish('x'),
    (e: any) => e.code === 'out_of_turn',
    'a failed second step leaves nothing to finish',
  );
});

test('sealed bodies: a changed one, one of another run and one read in the wrong direction are nothing; a message out of turn ends the run', () => {
  const x = run();
  const m3x = json(x.a.second(x.b.receive(x.a.first())));
  const sealed = Buffer.from(m3x.sealed, 'base64url');
  sealed[sealed.length - 1] = (sealed[sealed.length - 1] ?? 0) ^ 1;
  const y = run();
  const m3y = json(y.a.second(y.b.receive(y.a.first())));
  assert.throws(
    () => y.b.receive3(shape({ tag: m3y.tag, sealed: cp.b64u(sealed) })),
    (e: any) => e.code === 'bad_body',
  );
  const z = run();
  const m3z = json(z.a.second(z.b.receive(z.a.first())));
  assert.throws(
    () => z.b.receive3(shape({ tag: m3z.tag, sealed: m3x.sealed })),
    (e: any) => e.code === 'bad_body',
  );
  // a reflection: the initiator's own sealed body handed back to it as the answer is under the other direction's key and is not opened
  const w = run();
  const m3w = json(w.a.second(w.b.receive(w.a.first())));
  assert.throws(
    () => w.a.finish(shape({ sealed: m3w.sealed })),
    (e: any) => e.code === 'bad_body',
  );
  // the same through a whole run in which the responder answers: the answer under the responder's direction opens, its own m3 body does not
  const u = run();
  const m3u = json(u.a.second(u.b.receive(u.a.first())));
  u.b.receive3(shape(m3u));
  const m4u = json(u.b.answer(true).message);
  assert.ok(m4u.sealed !== m3u.sealed);
  // a short sealed body
  const s = run();
  const m3s = json(s.a.second(s.b.receive(s.a.first())));
  assert.throws(
    () => s.b.receive3(shape({ tag: m3s.tag, sealed: cp.b64u(new Uint8Array(10)) })),
    (e: any) => e.code === 'bad_body',
  );
  // out of turn
  assert.throws(
    () => run().a.second('x'),
    (e: any) => e.code === 'out_of_turn',
  );
  const q = run();
  q.a.first();
  assert.throws(
    () => q.a.first(),
    (e: any) => e.code === 'out_of_turn',
  );
  const r = run();
  assert.throws(
    () => r.b.receive3('x'),
    (e: any) => e.code === 'out_of_turn',
  );
  assert.throws(
    () => r.b.answer(true),
    (e: any) => e.code === 'out_of_turn',
  );
  assert.throws(
    () => run().a.finish('x'),
    (e: any) => e.code === 'out_of_turn',
  );
  const d = run();
  d.b.receive(d.a.first());
  assert.throws(
    () => d.b.receive('again'),
    (e: any) => e.code === 'out_of_turn',
  );
  const g = run();
  g.b.receive(g.a.first());
  assert.throws(
    () => g.a.finish('!!'),
    (e: any) => e.code === 'out_of_turn',
  );
});
