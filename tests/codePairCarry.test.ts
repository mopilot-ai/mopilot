// What the two sides hand each other inside the sealed bodies (shared/host/codePair.mjs `carry`, R2b of #5576): the controlling Mac's relay credential in m3 and the controlled Host's half of the pair in m4; a plain object of bounded size, sealed under keys only the two sides hold, never in the clear and never read before the proof of the key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, run, json } from './support/host/codePairKit.ts';

const enroll = { relayUrl: 'wss://relay.example/v1/ws', hostId: 'h_abcdefghijklmnop', secret: 'S'.repeat(43), pairId: 'p_abcdefgh' };
const half = { hostPub: 'k'.repeat(43), hostEphPub: 'e'.repeat(43) };

test("a carried object travels sealed both ways: the Host reads the credential from m3 and the controlling Mac the Host's half from m4", () => {
  const { a, b } = run();
  const m3 = a.second(b.receive(a.first()), enroll);
  const seen = b.receive3(m3);
  assert.deepEqual(seen.carry, enroll);
  const { message } = b.answer(true, half);
  const done = a.finish(message);
  assert.equal(done.denied, false);
  assert.deepEqual(done.carry, half);
  // sealed: neither message names anything it carries, and the relay's own view of m3 and m4 is only text it cannot open
  assert.doesNotMatch(Buffer.from(m3, 'base64url').toString('latin1'), /relay\.example|h_abcdef/);
  assert.doesNotMatch(Buffer.from(message, 'base64url').toString('latin1'), /kkkkkkkk/);
  assert.deepEqual(Object.keys(json(m3)).sort(), ['sealed', 'tag']);
});

test('nothing carried is nothing read: a run with no carry has none on either side, a denial carries nothing, and a Mac that carries none is told so', () => {
  const plain = run();
  const m3 = plain.a.second(plain.b.receive(plain.a.first()));
  assert.equal(plain.b.receive3(m3).carry, undefined);
  assert.equal(plain.a.finish(plain.b.answer(true).message).carry, undefined);
  const denied = run();
  const seen = denied.b.receive3(denied.a.second(denied.b.receive(denied.a.first()), enroll));
  assert.deepEqual(seen.carry, enroll);
  assert.deepEqual(denied.a.finish(denied.b.answer(false, half).message), { denied: true });
  const nulls = run();
  assert.equal(nulls.b.receive3(nulls.a.second(nulls.b.receive(nulls.a.first()), null as any)).carry, undefined);
});

test('what is carried is one plain object of a bounded size, or the run ends', () => {
  for (const bad of ['text', 7, [1], { big: 'x'.repeat(cp.MAX_CARRY) }]) {
    const r = run();
    const m2 = r.b.receive(r.a.first());
    assert.throws(() => r.a.second(m2, bad as any), { code: 'bad_body' }, String(bad).slice(0, 20));
    assert.throws(() => r.a.finish('x'), { code: 'out_of_turn' }, 'a run that failed does not go on');
  }
  const r = run();
  const m3 = r.a.second(r.b.receive(r.a.first()), { ok: 'x'.repeat(cp.MAX_CARRY - 20) });
  r.b.receive3(m3);
  assert.throws(() => r.b.answer(true, { big: 'x'.repeat(cp.MAX_CARRY) } as any), { code: 'bad_body' });
});
