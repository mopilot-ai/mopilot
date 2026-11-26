// What happens to a pairing in the gaps of its answer, and how a service stops (host/src/codePairService.mjs, R2b of #5576): one answer at a time with the person's proof awaited, a claim that takes the run in the gap, the credential the other Mac chose, the link taken back, connections off, closing and failing timers.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { CONFIRM_MS, LINGER_MS, VERIFY_MS } from '../host/src/codePairService.mjs';
import { cp, crypto, A } from './support/host/codePairKit.ts';
import { OFFER, enrollment, flush, world } from './support/host/codePairWorld.ts';

/** A verifier the test releases by hand, so a pairing can be in the gap of the person's proof. */
function held() {
  let release: (v: boolean) => void = () => undefined;
  return { verify: () => new Promise<boolean>((resolve) => (release = resolve)), release: (v: boolean) => release(v) };
}

test("answers are taken one at a time: while the person's proof is awaited a second accept, a deny, a cancel and the clock each find no question, the connection ending does not cancel it, and the pairing completes once", async (t) => {
  const gate = held();
  const w = world(t, { verify: gate.verify });
  const { offerId, code } = await w.service.offer(OFFER, w.who);
  const x = await w.toConfirm(code);
  const first = w.accept(offerId, w.who);
  await assert.rejects(w.service.answer({ offerId, accept: false }, w.who), { code: 'not_asked' });
  await assert.rejects(w.accept(offerId, w.who), { code: 'not_asked' });
  assert.deepEqual(w.service.cancel({ offerId }, w.who), { cancelled: false });
  // the clock that would say no is gone with the question (the check of the proof has its own, longer one)
  mock.timers.tick(VERIFY_MS - 1);
  for (const end of w.owner) end();
  await flush();
  assert.equal(w.service.open(), 1, 'nothing ended it');
  gate.release(true);
  const result = await first;
  assert.equal(result.accepted, true);
  assert.deepEqual(w.enrolled.length, 1, 'enrolled once');
  assert.equal(w.pairing.list().filter((c: any) => c.kind === 'controller').length, 1);
  assert.equal(x.a.finish(x.read().messages.at(-1)!.box).denied, false);
  assert.deepEqual(w.forgot, [], 'a pairing that was made keeps its link');
});

test('a claim that takes the run while the proof is awaited ends it with nothing enrolled and nothing added; a verifier that throws is no proof', async (t) => {
  const gate = held();
  const w = world(t, { verify: gate.verify });
  const { offerId, code } = await w.service.offer(OFFER, w.who);
  await w.toConfirm(code);
  const first = w.accept(offerId, w.who);
  const second = w.typing(code);
  second.send(second.a.first());
  await w.pump();
  await w.pump();
  gate.release(true);
  assert.deepEqual(await first, { accepted: false });
  assert.deepEqual([w.enrolled, w.forgot, w.pairing.list().filter((c: any) => c.kind === 'controller')], [[], [], []]);
  const bad = world(t, {
    verify: async () => {
      throw new Error('helper crashed');
    },
  });
  const o = await bad.service.offer(OFFER, bad.who);
  await bad.toConfirm(o.code);
  await assert.rejects(bad.accept(o.offerId, bad.who), { code: 'approval_unavailable' });
  assert.ok(bad.reported.some((m) => /helper crashed/.test(m)));
  assert.equal(bad.phases().at(-1), 'confirm', 'the person may still say no');
});

test('what the other Mac chose is a relay credential and nothing else: a client named in it is dropped before the Host enrols it', async (t) => {
  const w = world(t);
  const { offerId, code } = await w.service.offer(OFFER, w.who);
  const { hint, secret } = cp.parseCode(code) as any;
  const claimed: any = w.rv.claim({ hint, address: '10.3.3.3' });
  const a = cp.createInitiator({ crypto, secret, hint, rendezvousId: claimed.id, claims: 1, device: A, budget: cp.createRunBudget() });
  const send = (box: string) => w.rv.send({ id: claimed.id, ticket: claimed.ticket, claims: 1, box });
  send(a.first());
  await w.pump();
  send(
    a.second(w.rv.read({ id: claimed.id, ticket: claimed.ticket, after: 0 }).messages.at(-1).box, {
      ...enrollment,
      client: 'f'.repeat(64),
    }),
  );
  await w.pump();
  await w.accept(offerId, w.who);
  assert.equal(w.enrolled.length, 1);
  assert.ok(!('client' in w.enrolled[0]), 'the peer names no client');
  assert.equal(w.enrolled[0].hostId, enrollment.hostId);
});

test('a pairing that fails after the link was enrolled takes the link back: the controller could not be added, the answer could not be sent', async (t) => {
  const w = world(t);
  const { offerId, code } = await w.service.offer(OFFER, w.who);
  await w.toConfirm(code);
  (w.pairing as any).add = () => {
    throw new Error('table full');
  };
  await assert.rejects(w.accept(offerId, w.who), { code: 'failed' });
  assert.deepEqual(w.forgot, [enrollment.hostId]);
  assert.equal(w.phases().at(-1), 'failed');
  const s = world(t);
  const o = await s.service.offer(OFFER, s.who);
  await s.toConfirm(o.code);
  s.flags.sendFails = true;
  // the link is forgotten before the record goes, so a removal's tombstone (#5747) is never made for a pairing that did not finish
  const order: number[] = [];
  const remove = (s.pairing as any).remove.bind(s.pairing);
  (s.pairing as any).remove = (fp: string) => (order.push(s.forgot.length), remove(fp));
  await assert.rejects(s.accept(o.offerId, s.who), { code: 'relay' });
  assert.deepEqual(s.forgot, [enrollment.hostId]);
  assert.deepEqual(order, [1]);
  assert.deepEqual(
    s.pairing.list().filter((c: any) => c.kind === 'controller'),
    [],
  );
});

test('a Host that does not accept connections makes no code; closing the service ends every offer at once, the relay told, no timer left', async (t) => {
  const w = world(t);
  w.flags.open = false;
  await assert.rejects(w.service.offer(OFFER, w.who), { code: 'connections_off' });
  assert.deepEqual(w.relayCalls, []);
  w.flags.open = true;
  await w.service.offer(OFFER, w.who);
  await w.service.offer(OFFER, w.who);
  w.service.close();
  assert.equal(w.service.open(), 0);
  assert.deepEqual(w.phases().slice(-2), ['cancelled', 'cancelled']);
  assert.equal(w.relayCalls.filter((c) => c === 'close').length, 2);
});

test("a timer that fails reports it and goes on: the clock's no that cannot be written down, and a poll the relay port throws on", async (t) => {
  const w = world(t);
  const { code } = await w.service.offer(OFFER, w.who);
  await w.toConfirm(code);
  w.flags.auditThrows = true;
  mock.timers.tick(CONFIRM_MS);
  await flush();
  assert.ok(w.reported.some((m) => /audit down/.test(m)));
  const r = world(t, {
    relayRead: async () => {
      throw new Error('relay port threw');
    },
  });
  await r.service.offer(OFFER, r.who);
  await r.pump();
  assert.ok(r.reported.some((m) => /relay port threw/.test(m)));
});

test("the check of the person's proof has five seconds: a verifier that never answers is no proof, the question reopens, and the person may still say no", async (t) => {
  const w = world(t, { verify: () => new Promise(() => undefined) });
  const { offerId, code } = await w.service.offer(OFFER, w.who);
  await w.toConfirm(code);
  const answering = w.accept(offerId, w.who);
  const refused = assert.rejects(answering, { code: 'approval_unavailable' });
  mock.timers.tick(VERIFY_MS);
  await refused;
  assert.ok(w.reported.some((m) => /did not answer/.test(m)));
  assert.equal(w.phases().at(-1), 'confirm');
  assert.deepEqual([w.enrolled, w.forgot], [[], []]);
  assert.equal((await w.service.answer({ offerId, accept: false }, w.who)).accepted, false);
});

test("a Host that cannot take the person's proof makes no code and says why in the reason's own words; the key is enrolled through the service only when it can be", async (t) => {
  for (const [reason, words] of [
    ['no_approval_helper', /Set up pairing by code/],
    ['unsupported_platform', /available on Macs/],
    ['something_new', /not available here/],
  ] as const) {
    const w = world(t, { unavailable: reason });
    await assert.rejects(w.service.offer(OFFER, w.who), (e: any) => e.code === reason && words.test(e.message), reason);
  }
  const w = world(t);
  assert.throws(() => w.service.enrol({ key: 'k', weak: false, signature: 's' }), { code: 'no_approval_helper' });
});

test("the text to approve is made only for a question that is asked, only by the connection that made the offer, and is the one the answer's proof is checked against", async (t) => {
  const seenTexts: string[] = [];
  const w = world(t, { verify: async (text: string) => (seenTexts.push(text), true) });
  const { offerId, code } = await w.service.offer(OFFER, w.who);
  assert.throws(() => w.service.approvalText({ offerId }, w.who), { code: 'not_asked' });
  await w.toConfirm(code);
  assert.throws(() => w.service.approvalText({ offerId }, { owner: new Set() }), { code: 'no_such_offer' });
  const { text } = w.service.approvalText({ offerId }, w.who);
  await w.service.answer({ offerId, accept: true, approval: {} }, w.who);
  assert.deepEqual(seenTexts, [text]);
  assert.equal(w.pairing.list().find((c: any) => c.kind === 'controller')?.name, A.name);
});

test('an answer without the text having been asked for is no proof: it is not allowed, whatever the signature', async (t) => {
  const w = world(t);
  const { offerId, code } = await w.service.offer(OFFER, w.who);
  await w.toConfirm(code);
  await assert.rejects(w.service.answer({ offerId, accept: true, approval: { sig: 'x' } }, w.who), { code: 'approval_unavailable' });
  assert.deepEqual(
    w.pairing.list().filter((c: any) => c.kind === 'controller'),
    [],
  );
});

test('a name the protocol and the client table clean differently (trailing space, tabs, a character the 80-unit cut would halve) still gives a controller that is believed: the proof names the name as the record stores it', async (t) => {
  const names = ['Work Mac   ', '\tWork\tMac\u0007 ', `${'x'.repeat(79)}😀`, `${'x'.repeat(78)} 😀`, '😀'.repeat(60)];
  for (const peer of names) {
    const w = world(t, { real: true, peer });
    const { offerId, code } = await w.service.offer(OFFER, w.who);
    await w.toConfirm(code);
    const answered = await w.accept(offerId, w.who);
    assert.equal(answered.accepted, true, JSON.stringify(peer));
    const [controller] = w.pairing.list().filter((c: any) => c.kind === 'controller');
    assert.ok(controller, `a controller that is believed: ${JSON.stringify(peer)}`);
    assert.ok(![...controller.name].some((ch) => ch === '\ud83d' || ch === '\ud800'), 'no half of a character');
    assert.ok(controller.name.length <= 80);
  }
});

test('reset approval: refused while a code is open, then every controller and the key go; a step that fails says reset again, and the next reset finishes', async (t) => {
  const w = world(t, { real: true });
  const { offerId, code } = await w.service.offer(OFFER, w.who);
  assert.throws(() => w.service.resetApproval(), { code: 'busy' });
  await w.toConfirm(code);
  assert.equal((await w.accept(offerId, w.who)).accepted, true);
  assert.equal(w.pairing.list().filter((c: any) => c.kind === 'controller').length, 1);
  mock.timers.tick(LINGER_MS);
  assert.equal(w.service.open(), 0);
  assert.deepEqual(w.service.resetApproval(), { reset: true, controllers: 1 });
  assert.deepEqual(
    w.pairing.list().filter((c: any) => c.kind === 'controller'),
    [],
  );
  assert.deepEqual(w.service.status(w.who).approval, { available: false, reason: 'no_approval_helper' });
  assert.equal(w.audited.at(-1).kind, 'code.reset', 'the reset itself is in the audit trail');
  // a step that fails: said, and the next reset finishes it
  let fails = true;
  const f = world(t, {
    reset: () => {
      if (fails) throw new Error('disk full');
    },
  });
  assert.throws(() => f.service.resetApproval(), { code: 'reset_incomplete' });
  assert.ok(
    f.reported.some((m: string) => /disk full/.test(m)),
    JSON.stringify(f.reported),
  );
  fails = false;
  assert.deepEqual(f.service.resetApproval(), { reset: true, controllers: 0 });
  // a Host built without the ports cannot
  assert.throws(() => world(t).service.resetApproval(), { code: 'unsupported' });
});

test('a controller paired by code keeps the name the person approved: renaming itself changes nothing, and its record stays believed', async (t) => {
  const w = world(t, { real: true });
  const { offerId, code } = await w.service.offer(OFFER, w.who);
  await w.toConfirm(code);
  const { fingerprint } = await w.accept(offerId, w.who);
  const name = w.pairing.list().find((c: any) => c.fingerprint === fingerprint)?.name;
  assert.ok(name);
  // the controller introduces itself with another name (the app's own, or a later rename of the Mac)
  assert.equal(w.pairing.rename(fingerprint, `${name} renamed`), true);
  const after = w.pairing.list().find((c: any) => c.fingerprint === fingerprint);
  assert.ok(after, 'still a controller: its proof still verifies');
  assert.equal(after.name, name, 'the approved name is kept');
  assert.equal(w.pairing.stillKnows(fingerprint), true);
  // this Mac's own label: shown in the row, the approved name kept, the record still believed
  assert.equal(w.pairing.rename(fingerprint, 'Studio', { owner: true }), true);
  assert.equal(w.pairing.list().find((c: any) => c.fingerprint === fingerprint)?.name, 'Studio');
  assert.equal(w.pairing.stillKnows(fingerprint), true, 'still believed under its label');
});
