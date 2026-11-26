// Pairing another Mac by code, the controlled Host's side (host/src/codePairService.mjs, R2b of #5576), against the relay's own rendezvous in process: a whole run to a controller, the person's no, a wrong code that burns, a code that is used up, an offer that ends, one that belongs to its connection, and every way the Host refuses to accept.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
// @ts-ignore
import { MAX_OPEN, MAX_PER_HOUR, CONFIRM_MS, LINGER_MS, PROVE_MS } from '../host/src/codePairService.mjs';
// @ts-ignore
// @ts-ignore
import { cp, crypto, A, B } from './support/host/codePairKit.ts';
import { OFFER, enrollment, flush, half, world } from './support/host/codePairWorld.ts';

test("a whole run: a code, another Mac types it, the person is asked with its name and the safety number, allows in person, and the Mac is a controller that is told the Host's half", async (t) => {
  const w = world(t);
  const { offerId, code, expiresAt } = await w.service.offer(OFFER, w.who);
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.ok(expiresAt > 0);
  const x = await w.toConfirm(code);
  const confirm = w.events.find((e) => e.phase === 'confirm');
  assert.deepEqual([confirm.offerId, confirm.name, typeof confirm.safety], [offerId, A.name, 'string']);
  assert.equal(w.events.find((e) => e.phase === 'connecting').name, undefined, 'a name is told only after the code was proved');
  assert.equal(x.a.safety, confirm.safety, 'both Macs show the same number');
  const asked = w.service.approvalText({ offerId }, w.who);
  assert.match(asked.text, /^mopilot-code-pair-approval-v1\|host-h\|/);
  assert.deepEqual(
    [asked.fields.link, asked.fields.name, asked.fields.offerId, asked.fields.accepted],
    [enrollment.hostId, A.name, offerId, true],
    'the helper is given the fields, and the link is the one the other Mac brought',
  );
  assert.equal(asked.text.split('|').length, 10);
  assert.ok(asked.notAfter > 0);
  const result = await w.service.answer({ offerId, accept: true, approval: { signed: 'yes' } }, w.who);
  assert.equal(result.accepted, true);
  await flush();
  assert.deepEqual(w.enrolled, [enrollment]);
  const m4 = x.read().messages.at(-1)!.box;
  const done = x.a.finish(m4);
  assert.equal(done.denied, false);
  assert.deepEqual(done.carry, half);
  assert.equal(done.peerName, B.name);
  const [controller] = w.pairing.list().filter((c: any) => c.kind === 'controller');
  assert.equal(controller.name, A.name);
  assert.equal(controller.fingerprint, result.fingerprint);
  assert.deepEqual(w.phases().slice(-1), ['done']);
  assert.equal(w.service.open(), 0, 'the offer is over');
  // the relay keeps the offer until the other Mac had time to read the answer, then is told
  assert.ok(!w.relayCalls.includes('close'));
  mock.timers.tick(LINGER_MS);
  await flush();
  assert.ok(w.relayCalls.includes('close'));
  assert.deepEqual(
    w.audited.map((e) => e.kind),
    ['code.offered'],
  );
});

test("the person's no (and the clock's) reaches the other Mac as a denial, adds nothing, and ends the offer", async (t) => {
  const w = world(t);
  const { offerId, code } = await w.service.offer(OFFER, w.who);
  const x = await w.toConfirm(code);
  assert.deepEqual(await w.service.answer({ offerId, accept: false }, w.who), { accepted: false });
  await flush();
  assert.deepEqual(x.a.finish(x.read().messages.at(-1)!.box), { denied: true });
  assert.deepEqual(
    w.pairing.list().filter((c: any) => c.kind === 'controller'),
    [],
  );
  assert.deepEqual(w.phases().slice(-1), ['denied']);
  assert.equal(w.audited.at(-1).kind, 'code.refused');
  // nobody answering is a no
  const late = world(t);
  const o2 = await late.service.offer(OFFER, late.who);
  const y = await late.toConfirm(o2.code);
  mock.timers.tick(CONFIRM_MS);
  await flush();
  assert.deepEqual(late.phases().slice(-1), ['denied']);
  assert.deepEqual(y.a.finish(y.read().messages.at(-1)!.box), { denied: true });
});

test("accepting needs the person's proof: with none, with a verifier that says no, or with a credential the Host cannot use, nothing is added and the person may still say no", async (t) => {
  for (const [name, over, code] of [
    ['no verifier', { verify: undefined }, 'approval_unavailable'],
    ['verifier says no', { verify: async () => false }, 'approval_unavailable'],
    ['credential refused', { enrollFails: true }, 'bad_credential'],
  ] as const) {
    const w = world(t, over);
    const { offerId, code: typed } = await w.service.offer(OFFER, w.who);
    await w.toConfirm(typed);
    await assert.rejects(w.accept(offerId, w.who), { code }, name);
    assert.deepEqual(
      w.pairing.list().filter((c: any) => c.kind === 'controller'),
      [],
      name,
    );
    assert.deepEqual(w.phases().slice(-1), ['confirm'], `${name}: still asked`);
    assert.equal((await w.service.answer({ offerId, accept: false }, w.who)).accepted, false);
  }
  // the credential the other Mac brought is judged by the relay-enrollment parser, not trusted
  const bad = world(t);
  const o = await bad.service.offer(OFFER, bad.who);
  const { hint, secret } = cp.parseCode(o.code) as any;
  const claimed: any = bad.rv.claim({ hint, address: '10.2.2.2' });
  const a = cp.createInitiator({ crypto, secret, hint, rendezvousId: claimed.id, claims: 1, device: A, budget: cp.createRunBudget() });
  const send = (box: string) => bad.rv.send({ id: claimed.id, ticket: claimed.ticket, claims: 1, box });
  send(a.first());
  await bad.pump();
  send(
    a.second(bad.rv.read({ id: claimed.id, ticket: claimed.ticket, after: 0 }).messages.at(-1).box, {
      relayUrl: 'ftp://x',
      hostId: 'nope',
    }),
  );
  await bad.pump();
  await assert.rejects(bad.accept(o.offerId, bad.who), { code: 'bad_credential' });
});

test('a policy that forbids controllers refuses the offer, and one that turned on while the person was being asked makes an accept a refusal the other Mac is told', async (t) => {
  const off = world(t, { allows: false });
  await assert.rejects(off.service.offer(OFFER, off.who), { code: 'policy_refused' });
  assert.deepEqual(off.relayCalls, [], 'nothing was asked of the relay');
  const w = world(t);
  const { offerId, code } = await w.service.offer(OFFER, w.who);
  const x = await w.toConfirm(code);
  w.flags.allows = false;
  assert.deepEqual(await w.accept(offerId, w.who), { accepted: false });
  await flush();
  assert.deepEqual([w.phases().at(-1), w.events.at(-1).code], ['failed', 'policy_refused']);
  assert.deepEqual(x.a.finish(x.read().messages.at(-1)!.box), { denied: true });
  assert.deepEqual(
    w.pairing.list().filter((c: any) => c.kind === 'controller'),
    [],
  );
});

test('a wrong code is a run that stalls: the Mac is told nothing, the offer waits for another try, and the third use burns it', async (t) => {
  const w = world(t);
  const { code } = await w.service.offer(OFFER, w.who);
  for (let i = 0; i < 3; i++) {
    const x = typing(w, code, 'WRONG');
    x.send(x.a.first());
    await w.pump();
    await w.pump();
    assert.equal(w.events.at(-1).phase, 'proving', `try ${i + 1}: the Host cannot tell a wrong code from a slow Mac`);
    mock.timers.tick(PROVE_MS);
    await flush();
    assert.equal(w.events.at(-1).phase, i < 2 ? 'waiting' : 'used_up', `try ${i + 1}`);
  }
  assert.equal(w.service.open(), 0);
  // the neutral words never say how close the code was
  assert.ok(w.events.every((e) => !('name' in e) && !('safety' in e)));
});
function typing(w: any, code: string, secret?: string) {
  return w.typing(code, secret ? { secret } : {});
}

test('another Mac typing the code while one is being asked about ends the offer as used up: the relay moved on to the new claim, so the first Mac could no longer be answered, and nobody is asked about it', async (t) => {
  const w = world(t);
  const { offerId, code } = await w.service.offer(OFFER, w.who);
  await w.toConfirm(code);
  const second = w.typing(code);
  second.send(second.a.first());
  await w.pump();
  await w.pump();
  assert.equal(w.phases().at(-1), 'used_up');
  assert.equal(w.service.open(), 0);
  await assert.rejects(w.accept(offerId, w.who), { code: 'no_such_offer' });
  assert.deepEqual(
    w.pairing.list().filter((c: any) => c.kind === 'controller'),
    [],
  );
});

test('an offer belongs to the connection that made it: another connection cannot answer or cancel it, and ending the connection cancels it', async (t) => {
  const w = world(t);
  const { offerId, code } = await w.service.offer(OFFER, w.who);
  await w.toConfirm(code);
  const stranger = { owner: new Set<() => void>() };
  await assert.rejects(w.service.answer({ offerId, accept: true, approval: {} }, stranger), { code: 'no_such_offer' });
  await assert.rejects(async () => w.service.approvalText({ offerId }, stranger), { code: 'no_such_offer' });
  assert.deepEqual(w.service.cancel({ offerId }, stranger), { cancelled: false });
  assert.deepEqual(w.service.status(stranger), { approval: { available: true, weak: false }, hostId: 'host-h', paused: false, offers: [] });
  assert.deepEqual(
    w.service.status(w.who).offers.map((o: any) => o.offerId),
    [offerId],
  );
  for (const end of w.owner) end();
  assert.equal(w.service.open(), 0);
  assert.equal(w.phases().at(-1), 'cancelled');
  assert.deepEqual(w.service.cancel({ offerId }, w.who), { cancelled: false }, 'already over');
});

test('an offer ends when its time is up or the relay no longer knows it; a cancel ends it at once', async (t) => {
  const w = world(t);
  const a = await w.service.offer(OFFER, w.who);
  w.tick(10 * 60_000);
  await w.pump();
  assert.equal(w.phases().at(-1), 'expired');
  assert.equal(w.service.open(), 0);
  const b = await w.service.offer(OFFER, w.who);
  assert.deepEqual(w.service.cancel({ offerId: b.offerId }, w.who), { cancelled: true });
  assert.equal(w.phases().at(-1), 'cancelled');
  assert.ok(a.offerId !== b.offerId);
  // the relay forgetting an offer (a restart of the relay) is an end, not a crash
  const c = await w.service.offer(OFFER, w.who);
  w.rv.close({ id: c.offerId, ticket: 'x'.repeat(22) });
  w.rv.sweep();
  w.tick(10 * 60_000);
  await w.pump();
  assert.equal(w.phases().at(-1), 'expired');
});

test("the relay's refusals are the Host's: an unreachable or unauthorised relay makes no code, and too many open or too many in an hour are refused before the relay is asked", async (t) => {
  const bad = world(t, { offerFails: 'unauthorized' });
  await assert.rejects(bad.service.offer(OFFER, bad.who), { code: 'unauthorized' });
  const down = world(t, { offerFails: 'unreachable' });
  await assert.rejects(down.service.offer(OFFER, down.who), { code: 'relay' });
  const many = world(t);
  for (let i = 0; i < MAX_OPEN; i++) await many.service.offer(OFFER, many.who);
  await assert.rejects(many.service.offer(OFFER, many.who), { code: 'limited' });
  assert.equal(many.service.open(), MAX_OPEN);
  const hourly = world(t);
  for (let i = 0; i < MAX_PER_HOUR; i++) {
    const o = await hourly.service.offer(OFFER, hourly.who);
    hourly.service.cancel({ offerId: o.offerId }, hourly.who);
  }
  await assert.rejects(hourly.service.offer(OFFER, hourly.who), { code: 'limited' });
  hourly.tick(60 * 60_000 + 1);
  await hourly.service.offer(OFFER, hourly.who);
});

test('a code whose count could not be written ends the offer with the cause', async (t) => {
  if (process.getuid?.() === 0) return;
  const w = world(t);
  const { code } = await w.service.offer(OFFER, w.who);
  fs.chmodSync(w.dir, 0o500);
  try {
    const x = w.typing(code);
    x.send(x.a.first());
    await w.pump();
    assert.deepEqual([w.phases().at(-1), w.events.at(-1).code], ['failed', 'unrecorded']);
  } finally {
    fs.chmodSync(w.dir, 0o700);
  }
});

test('a relay that cannot take the answer undoes the pairing: the Mac is no controller and the person is told', async (t) => {
  const w = world(t);
  const { offerId, code } = await w.service.offer(OFFER, w.who);
  await w.toConfirm(code);
  w.flags.sendFails = true;
  await assert.rejects(w.accept(offerId, w.who), { code: 'relay' });
  assert.deepEqual(
    w.pairing.list().filter((c: any) => c.kind === 'controller'),
    [],
  );
  assert.deepEqual([w.phases().at(-1), w.events.at(-1).code], ['failed', 'relay']);
});

test('a refusal of the run with an offer that is not asked about: nothing is waiting to be allowed, and an offer that is not here is not one', async (t) => {
  const w = world(t);
  const { offerId } = await w.service.offer(OFFER, w.who);
  await assert.rejects(w.accept(offerId, w.who), { code: 'not_asked' });
  await assert.rejects(w.service.answer({ offerId: 'r_' + 'x'.repeat(22), accept: false }, w.who), { code: 'no_such_offer' });
});

test('a Host built with only what it needs makes its own randomness and keeps no audit or report: an emit that throws is reported, not fatal', async (t) => {
  const w = world(t, { bare: true });
  const throwing = {
    owner: new Set<() => void>(),
    emit: () => {
      throw new Error('connection gone');
    },
  };
  const { offerId, code } = await w.service.offer(OFFER, throwing as any);
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.deepEqual(w.service.cancel({ offerId }, throwing), { cancelled: true });
  assert.equal(w.service.open(), 0);
});

test('ending an offer twice (a connection ending after a cancel) tells nothing the second time', async (t) => {
  const w = world(t);
  await w.service.offer(OFFER, w.who);
  const before = w.events.length;
  const [end] = [...w.owner];
  end();
  end();
  assert.equal(w.events.length, before + 1);
});

test('what the relay says that is not a run: a mailbox that cannot be read is tried again, one that is gone ends the offer, a claim number it should not give or a message that is not text is a failed run, and a message already seen is skipped', async (t) => {
  let answer: any = { ok: false, reason: 'unreachable' };
  const w = world(t, { relayRead: async () => answer });
  await w.service.offer(OFFER, w.who);
  await w.pump();
  assert.equal(w.service.open(), 1, 'a relay that cannot be reached is tried again');
  answer = { ok: false, reason: 'limited' };
  await w.pump();
  assert.equal(w.service.open(), 1);
  // a message that is no text is a failed run the person is told nothing of
  answer = { ok: true, claims: 1, expiresAt: 1, messages: [{ n: 1, box: 5 }] };
  await w.pump();
  assert.equal(w.phases().at(-1), 'waiting');
  // a message at or before the last one seen is skipped
  answer = { ok: true, claims: 2, expiresAt: 1, messages: [] };
  await w.pump();
  assert.equal(w.phases().at(-1), 'connecting');
  answer = { ok: true, claims: 2, expiresAt: 1, messages: [{ n: 0, box: 'x' }] };
  await w.pump();
  assert.equal(w.phases().at(-1), 'connecting');
  // a claim number the protocol refuses is a failed run too
  answer = { ok: true, claims: 99, expiresAt: 1, messages: [] };
  await w.pump();
  assert.equal(w.phases().at(-1), 'waiting');
  answer = { ok: false, reason: 'gone' };
  await w.pump();
  assert.equal(w.phases().at(-1), 'expired');
  const named = world(t, { relayRead: async () => ({ ok: false, reason: 'no_such_code' }) });
  await named.service.offer(OFFER, named.who);
  await named.pump();
  assert.equal(named.phases().at(-1), 'expired');
});

test('a code that cannot be made safely is refused before anyone is told: the Host is paused after losing its memory, the relay made an id the Host cannot use, or one that was already used up', async (t) => {
  const paused = world(t, { before: (dir: string) => fs.writeFileSync(path.join(dir, 'code-pair.json'), 'junk') });
  await assert.rejects(paused.service.offer(OFFER, paused.who), { code: 'paused' });
  assert.deepEqual(paused.relayCalls, [], 'nothing was asked of the relay');
  assert.equal(paused.service.status(paused.who).paused, true);
  const id = `r_${'Z'.repeat(22)}`;
  const minted = (made: string) => async () => ({ ok: true, id: made, hint: 'K7Q', ticket: 'T'.repeat(22), expiresAt: 9_999_999 });
  const odd = world(t, { relayOffer: minted('not-an-id') });
  await assert.rejects(odd.service.offer(OFFER, odd.who), { code: 'relay' });
  assert.ok(odd.relayCalls.includes('close'), 'the relay is told the offer is not wanted');
  const used = world(t, {
    relayOffer: minted(id),
    before: (dir: string) =>
      fs.writeFileSync(
        path.join(dir, 'code-pair.json'),
        JSON.stringify({ v: 1, offers: { [id]: { started: 3, spent: false, at: 1_000_000 } } }),
      ),
  });
  await assert.rejects(used.service.offer(OFFER, used.who), { code: 'burned' });
  assert.ok(used.relayCalls.includes('close'));
});
