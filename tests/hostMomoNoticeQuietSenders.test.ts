// An accepted quiet rule for a sender (the learning service's `quietSenders()`) keeps that sender's would-be tell-now out of it, in code after the model reads (host/src/momoNotice.mjs, shared/momoNotice/pipeline.ts): a held matter that says why and counts the rule as used; never for money, credentials, risk wording, a deadline or urgency today; never unless the sender check passed; never for a sender a tell-me-now rule names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answer, mail, minutes, rig } from './support/host/momoNoticeRig.ts';

const QUIET = [{ domain: 'acme.com', address: null, ruleId: 'r1' }];
const GMAIL = { 'Authentication-Results': 'mx.google.com; dmarc=pass header.from=gmail.com' };

async function told(t: any, learning: any, over: object = {}, verdict = 'tell_now') {
  const w = rig(t);
  w.state.learning = learning;
  await w.store.learnDomains(['acme.com', 'gmail.com', 'other.com']);
  await w.notice.tick();
  w.clock.at += minutes(10);
  w.world.threads.t1 = mail('t1', { date: '2026-11-24T12:05:00Z', body: 'A big sale on shoes.', ...over });
  w.answers.push(answer(verdict, 'A promo.'));
  w.told.length = 0;
  const out = await w.notice.tick();
  return { w, out };
}
const decision = (w: any, id = 'gmail:t1') => w.notice.views.decisions({ ids: [id] })[0];
const kept = (learning: any = {}) => ({ quietSenders: () => QUIET, ...learning });

test('a quiet rule holds a would-be tell-now: nothing pushed, a held matter that says why, the rule counted as used, Undo reaches the real rule', async (t) => {
  const used: string[] = [];
  const { w, out } = await told(t, kept({ used: async (id: string) => void used.push(id) }));
  assert.deepEqual([out.told, w.told], [[], []]);
  const d = decision(w);
  assert.deepEqual([d.outcome, d.reason], ['quiet', 'Kept quiet by your rule for acme.com: A promo.']);
  assert.ok(d.checks.includes('Held for the brief: kept quiet by your rule for this sender.'));
  assert.ok(d.checks.includes('Read by the model, then kept quiet by your rule for this sender.'));
  assert.equal(d.rule?.id, 'r1', 'the rule’s own id');
  const matter = await w.store.notice.getMatter('gmail:t1');
  assert.deepEqual([matter.state, matter.pendingDelivery], ['open', 'quiet_rule']);
  assert.match(matter.summary, /^Kept quiet by your rule for acme\.com/);
  assert.deepEqual(used, ['r1']);
  // the brief lists it, as held
  const built = await w.notice.seams.build({ day: '2026-11-24', since: 0, until: w.clock.at, zone: 'UTC', stamp: w.state.stamp });
  assert.ok(JSON.stringify(built).includes('Kept quiet by your rule for acme.com'));
});

test('mail that must be told is told despite the rule, and says so: money or credentials, risk wording, a deadline, urgency today', async (t) => {
  for (const body of [
    'Your invoice is due, please pay by wire transfer.',
    'Unusual sign-in to your account: verify your login.',
    'Please confirm by 2026-11-30.',
    'This is a final notice, your account closes today.',
  ]) {
    const { w } = await told(t, kept(), { body });
    const d = decision(w);
    assert.equal(d.outcome, 'tell_now', body);
    assert.match(d.reason, /^Told you despite your quiet rule for acme\.com: /, body);
    assert.equal(w.told.length, 1, body);
  }
});

test('only a sender that passed the check is quieted: an unknown one is told', async (t) => {
  const { w } = await told(t, kept(), { headers: {} });
  assert.equal(decision(w).outcome, 'tell_now');
  assert.equal(w.told.length, 1);
});

test('another sender, a track verdict, no learning service and a failing one are not affected', async (t) => {
  assert.equal((await told(t, { quietSenders: () => [{ domain: 'other.com', address: null, ruleId: 'r2' }] })).w.told.length, 1);
  const track = await told(t, kept(), {}, 'track');
  assert.equal(decision(track.w).outcome, 'watch');
  assert.equal((await told(t, undefined)).w.told.length, 1);
  assert.equal((await told(t, { quietSenders: () => 'nope' })).w.told.length, 1);
  const failing = await told(t, {
    quietSenders: () => {
      throw new Error('boom');
    },
  });
  assert.equal(failing.w.told.length, 1);
  assert.ok(failing.w.reports.some((r) => r.includes('quiet senders')));
});

test('a rule that fails to count does not stop the pass', async (t) => {
  const { w } = await told(
    t,
    kept({
      used: async () => {
        throw new Error('disk');
      },
    }),
  );
  assert.equal(decision(w).outcome, 'quiet');
});

test('a sender a "tell me now" rule names stays loud, written as the owner may: case, an address, punctuation; a longer name or another rule does not', async (t) => {
  for (const text of ['Anything from ACME.com is urgent', 'Tell me about ana@acme.com,', 'acme.com.', 'mail from (Acme.com)']) {
    const loud = await told(t, kept({ ownerRules: () => [{ id: 'o', kind: 'tell_now', text }] }));
    assert.equal(loud.w.told.length, 1, text);
  }
  for (const [kind, text] of [
    ['tell_now', 'notacme.com is urgent'],
    ['tell_now', 'Landlord mail is urgent'],
    ['stay_quiet', 'acme.com'],
  ]) {
    const quiet = await told(t, kept({ ownerRules: () => [{ id: 'o', kind, text }] }));
    assert.equal(quiet.w.told.length, 0, text);
  }
});

test('a sender that failed the check is still shown as "may not be from", never silenced by the rule for the name it imitates', async (t) => {
  const spoof = await told(t, kept(), {
    body: 'Please pay this invoice today, wire transfer to the new account.',
    headers: { 'Authentication-Results': 'mx.google.com; dmarc=fail header.from=acme.com' },
  });
  const d = decision(spoof.w);
  assert.equal(d.outcome, 'tell_now');
  assert.match(d.reason, /may not be from/);
});

test('a later mail in the thread from another sender is judged by its own sender, not the thread’s first', async (t) => {
  const w = rig(t);
  w.state.learning = kept();
  await w.store.learnDomains(['acme.com', 'other.com']);
  await w.notice.tick();
  w.clock.at += minutes(10);
  w.world.threads.t1 = mail('t1', { date: '2026-11-24T12:05:00Z', body: 'A big sale on shoes.' });
  w.answers.push(answer('tell_now', 'A promo.'));
  await w.notice.tick();
  assert.equal(decision(w).outcome, 'quiet');
  w.clock.at += minutes(10);
  w.world.threads.t1 = mail('t1', {
    id: 'm-t1-2',
    date: '2026-11-24T12:20:00Z',
    from: 'Dan <dan@other.com>',
    headers: { 'Authentication-Results': 'mx.google.com; dmarc=pass header.from=other.com' },
    body: 'Can you confirm?',
  });
  w.answers.push(answer('tell_now', 'Dan asks.'));
  w.told.length = 0;
  await w.notice.tick();
  const latest = w.notice.views.decisions({ ids: ['gmail:t1'] }).at(-1);
  assert.equal(latest.outcome, 'tell_now');
  assert.equal(w.told.length, 1);
});

test('at a public mail service the rule is for the full address, not the domain', async (t) => {
  const rule = [{ domain: 'gmail.com', address: 'ana@gmail.com', ruleId: 'r9' }];
  const same = await told(t, { quietSenders: () => rule }, { from: 'Ana <Ana@Gmail.com>', headers: GMAIL });
  assert.equal(same.w.told.length, 0);
  assert.match(decision(same.w).reason, /^Kept quiet by your rule for ana@gmail\.com: /);
  const other = await told(t, { quietSenders: () => rule }, { from: 'Bob <bob@gmail.com>', headers: GMAIL });
  assert.equal(other.w.told.length, 1, 'another address at the same service is not silenced');
  const whole = await told(
    t,
    { quietSenders: () => [{ domain: 'gmail.com', address: null, ruleId: 'r8' }] },
    { from: 'Bob <bob@gmail.com>', headers: GMAIL },
  );
  assert.equal(whole.w.told.length, 0);
  const plain = await told(t, undefined, { from: 'Bob <bob@gmail.com>', headers: GMAIL });
  assert.equal((await plain.w.store.notice.getMatter('gmail:t1')).fromAddress, 'bob@gmail.com');
});
