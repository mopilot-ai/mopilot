// What the owner does with notices becomes learning, through the real notice intents and the real learning service: two "Not needed" taps on different matters from one sender make ONE rule that waits for Accept (never on by itself), a sender whose suggestion was turned down is not suggested again, "Make it a rule" and "Ignore" on a signal are read from the notice lane's reactions, and what is looked at is looked at once and bounded.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { breakAudit, world } from './support/host/momoCoreWorld.ts';
import { noticing, tap } from './support/host/noticingWorld.ts';

test('two taps on different matters from one sender make one rule that waits for Accept; it is never on by itself, and once accepted the sender is quiet', async (t) => {
  const n = await noticing(t);
  await tap(n, 'a1');
  assert.deepEqual(
    n.learning.view().signals.map((s: any) => s.id),
    ['notice:sender:acme.com'],
    'one tap is a signal',
  );
  assert.equal(n.rules().length, 0);
  await tap(n, 'a2');
  assert.equal(n.rules().length, 1);
  assert.deepEqual(
    [n.rules()[0].state, n.rules()[0].text, n.rules()[0].appliesTo],
    [
      'suggested',
      "Don't tell me right away about mail from acme.com.",
      'All mail from acme.com is held for the brief, except mail that must be told (money, credentials, a deadline, urgent, or a sender that did not pass).',
    ],
  );
  assert.deepEqual(n.learning.quietSenders(), [], 'nothing is quiet until the owner accepts');
  // the same tap read again from the notice lane's list is not counted a second time
  assert.deepEqual(await n.learning.consumeNotices(), { counted: 0, set_aside: 0 });
  assert.equal(n.rules().length, 1);
  await n.learning.confirm(n.rules()[0].id, 'phone:a');
  assert.deepEqual(
    n.learning.quietSenders().map((s: any) => s.domain),
    ['acme.com'],
  );
  // a third tap makes no second rule
  await tap(n, 'a3');
  assert.equal(n.rules().length, 1);
  assert.deepEqual(n.learning.quietSenders().length, 1);
});

test('a sender whose suggestion the owner turned down is not suggested again', async (t) => {
  const n = await noticing(t);
  await tap(n, 'a1');
  await tap(n, 'a2');
  await n.learning.decline(n.rules()[0].id, 'phone:a');
  n.w.clock.at += 1000;
  await tap(n, 'a3');
  n.w.clock.at += 1000;
  await n.learning.react({ pattern: 'notice:sender:acme.com', label: 'mail from acme.com', kind: 'not_needed' });
  assert.equal(n.rules().filter((r: any) => r.state === 'suggested').length, 0);
  // another sender is not affected
  await tap(n, 'b1');
  assert.equal(n.rules().length, 1);
});

test('"Make it a rule" on a signal makes the quiet rule at once, and "Ignore" drops the signal so the count starts again', async (t) => {
  const n = await noticing(t);
  await tap(n, 'a1');
  await tap(n, 'b1');
  assert.equal(n.learning.view().signals.length, 2);
  await n.intents['signal.make']({ id: 'notice:sender:acme.com' });
  await n.intents['signal.ignore']({ id: 'notice:sender:shop.example' });
  assert.deepEqual(await n.learning.consumeNotices(), { counted: 2, set_aside: 0 });
  assert.deepEqual(
    n.rules().map((r: any) => [r.appliesTo, r.state]),
    [
      [
        'All mail from acme.com is held for the brief, except mail that must be told (money, credentials, a deadline, urgent, or a sender that did not pass).',
        'on',
      ],
    ],
  );
  assert.deepEqual(
    n.learning.quietSenders().map((s: any) => s.domain),
    ['acme.com'],
  );
  assert.deepEqual(n.learning.view().signals, [], 'both signals are answered');
  // the next tap on the ignored sender starts again
  n.w.clock.at += 1000;
  await n.learning.react({ pattern: 'notice:sender:shop.example', label: 'mail from shop.example', kind: 'not_needed' });
  assert.deepEqual(
    n.learning.view().signals.map((s: any) => s.id),
    ['notice:sender:shop.example'],
  );
  // a signal that is not there, and an unknown kind, are set aside; a rule already there is not made twice
  n.reactions.push({ kind: 'signal_make', rowId: 'notice:sender:nobody.example', at: 9100 });
  n.reactions.push({ kind: 'something_else', rowId: 'w', at: 9101 });
  n.reactions.push({ nonsense: true });
  assert.deepEqual(await n.learning.consumeNotices(), { counted: 0, set_aside: 2 });
});

test('a tap on the notice lane that does not teach (no domain) makes no signal; at most fifty reactions are looked at in a pass; a missing, throwing or off-home notice lane gives nothing', async (t) => {
  const n = await noticing(t);
  // the sender is on the decision (#5564 reads it there) and on the matter (this branch's intents read it there): a name that is no domain on both
  n.decisions.find((d: any) => d.changeId === 'gmail:a1').fromDomain = 'localhost';
  n.matters.a1.fromDomain = 'localhost';
  await tap(n, 'a1');
  assert.deepEqual(n.learning.view().signals, []);
  for (let i = 0; i < 60; i++) n.reactions.push({ kind: 'signal_ignore', rowId: `notice:sender:s${i}.example.com`, at: 3000 + i });
  const first = await n.learning.consumeNotices();
  assert.equal(first.counted + first.set_aside, 50);
  const second = await n.learning.consumeNotices();
  assert.equal(second.counted + second.set_aside, 10, 'the rest');
  assert.deepEqual(n.learning.quietSenders(), []);
  const bare = await world(t);
  assert.deepEqual(await bare.learning.consumeNotices(), { counted: 0, set_aside: 0 });
  bare.home.provide('notice', {
    reactions: () => {
      throw new Error('closed');
    },
  });
  assert.deepEqual(await bare.learning.consumeNotices(), { counted: 0, set_aside: 0 });
  bare.home.provide('notice', { reactions: () => 'nope' });
  assert.deepEqual(await bare.learning.consumeNotices(), { counted: 0, set_aside: 0 });
  const away = await world(t);
  away.home.stamp = () => null;
  assert.deepEqual(await away.learning.consumeNotices(), { counted: 0, set_aside: 0 });
  assert.deepEqual(away.learning.quietSenders(), []);
});

test('a signal choice that cannot be recorded in the audit log is set aside and the rest are remembered only in part; a lease lost midway gives nothing; what is remembered is bounded', async (t) => {
  const n = await noticing(t);
  await tap(n, 'a1');
  const fix = breakAudit(n.w as any);
  n.reactions.push({ kind: 'signal_make', rowId: 'notice:sender:acme.com', at: 9000 });
  assert.deepEqual(await n.learning.consumeNotices(), { counted: 0, set_aside: 0 });
  assert.equal(n.rules().length, 0, 'no rule without its audit line');
  fix();
  assert.deepEqual(
    await n.learning.consumeNotices(),
    { counted: 1, set_aside: 0 },
    'the choice was not forgotten: with the line written, it is made',
  );
  assert.equal(n.rules().length, 1);
  for (let i = 0; i < 560; i++) n.reactions.push({ kind: 'signal_ignore', rowId: `notice:sender:q${i}.example.com`, at: 20_000 + i });
  for (let pass = 0; pass < 13; pass++) await n.learning.consumeNotices();
  const kept = Object.keys(n.w.home.data.sealed('learning.json', (v: any) => v).read().noticed);
  assert.ok(kept.length <= 500, `remembers ${kept.length}`);
  const real = n.w.home.stamp.bind(n.w.home);
  let calls = 0;
  n.w.home.stamp = () => (++calls <= 1 ? real() : null);
  n.reactions.push({ kind: 'signal_ignore', rowId: 'notice:sender:late.example.com', at: 40_000 });
  assert.deepEqual(await n.learning.consumeNotices(), { counted: 0, set_aside: 0 });
  n.w.home.stamp = real;
});

test('the learning service looks at the notice reactions when the home starts and every minute, says when it cannot, and survives it without a report function', async (t) => {
  const reports: string[] = [];
  const n = await noticing(t, { report: (m: string) => reports.push(m) });
  mock.timers.enable({ apis: ['setInterval'] });
  t.after(() => mock.timers.reset());
  await n.w.home.lifecycle('pause');
  await tap(n, 'a1');
  n.reactions.push({ kind: 'signal_make', rowId: 'notice:sender:acme.com', at: 9000 });
  await n.w.home.lifecycle('start');
  for (const end = Date.now() + 3000; !n.rules().length && Date.now() < end; ) await new Promise((r) => setTimeout(r, 10));
  assert.equal(n.rules().length, 1, 'looked at when the home started');
  n.reactions.push(
    Object.defineProperty({}, 'kind', {
      get: () => {
        throw new Error('boom');
      },
    }),
  );
  mock.timers.tick(60_000);
  for (const end = Date.now() + 3000; !reports.some((m) => /could not look at the notice reactions/.test(m)) && Date.now() < end; )
    await new Promise((r) => setTimeout(r, 10));
  assert.ok(reports.some((m) => /could not look at the notice reactions/.test(m)));
  const quiet = await noticing(t);
  quiet.reactions.push(
    Object.defineProperty({}, 'kind', {
      get: () => {
        throw new Error('boom');
      },
    }),
  );
  await quiet.w.home.lifecycle('pause');
  await quiet.w.home.lifecycle('start');
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(quiet.w.home.stamp());
});

test('a tap counts only if it carried the decision the owner saw, on mail whose sender check passed, with a key for the sender: a spoofed sender and a blind tap teach nothing', async (t) => {
  const n = await noticing(t);
  // a sender that failed the check: the tap dismisses the notice and teaches nothing
  n.decisions[0].senderStatus = 'fail';
  await tap(n, 'a1');
  assert.deepEqual(n.learning.view().signals, []);
  // a tap that did not carry the decision it saw
  n.w.clock.at += 10;
  await n.intents['row.notNeeded']({ rowId: 'gmail:a2' });
  assert.deepEqual(await n.learning.consumeNotices(), { counted: 0, set_aside: 1 });
  // and two honest taps on two matters from the one sender that passes still make exactly one suggested rule
  await tap(n, 'a3');
  n.reactions.push({
    kind: 'not_needed',
    rowId: 'gmail:z',
    matterKey: 'z',
    fromDomain: 'acme.com',
    decisionId: 'gmail:z@1',
    senderStatus: 'pass',
    decidedBy: null,
    outcome: null,
    at: 5,
  });
  n.reactions.push({
    kind: 'not_needed',
    rowId: 'gmail:y',
    matterKey: 'y',
    fromDomain: 'acme.com',
    decisionId: 'gmail:y@1',
    senderStatus: 'unknown',
    decidedBy: null,
    outcome: null,
    at: 6,
  });
  n.reactions.push({
    kind: 'not_needed',
    rowId: 'gmail:x',
    matterKey: 'x',
    fromDomain: 'acme.com',
    decisionId: null,
    senderStatus: 'pass',
    decidedBy: null,
    outcome: null,
    at: 7,
  });
  const out = await n.learning.consumeNotices();
  assert.deepEqual(out, { counted: 1, set_aside: 2 });
  assert.deepEqual(
    n.rules().map((r: any) => [r.appliesTo, r.state]),
    [
      [
        'All mail from acme.com is held for the brief, except mail that must be told (money, credentials, a deadline, urgent, or a sender that did not pass).',
        'suggested',
      ],
    ],
  );
});

test('what was looked at is not looked at again however many reactions have gone by: 600 taps, the store trimming its oldest, an Undo, and nothing re-suggested, written or counted twice', async (t) => {
  const n = await noticing(t);
  await tap(n, 'a1');
  await tap(n, 'a2');
  assert.equal(n.rules().length, 1);
  await n.learning.undo(n.rules()[0].id, 'phone:a');
  const trimmed = n.reactions;
  // the notice lane keeps 500 and drops the oldest, with no age limit
  const push = (r: any) => {
    trimmed.push(r);
    if (trimmed.length > 500) trimmed.splice(0, trimmed.length - 500);
  };
  for (let pass = 0; pass < 12; pass++) {
    for (let i = 0; i < 50; i++) {
      const k = pass * 50 + i;
      push({
        kind: 'not_needed',
        rowId: `gmail:q${k}`,
        matterKey: `q${k}`,
        fromDomain: `s${k}.example.com`,
        fromAddress: null,
        decisionId: `gmail:q${k}@1`,
        senderStatus: 'pass',
        decidedBy: null,
        outcome: null,
        at: 100_000 + k,
      });
    }
    await n.learning.consumeNotices();
  }
  assert.equal(n.learning.view().signals.length, 600, 'each tap on its own sender made a signal, once');
  assert.equal(n.rules().filter((r: any) => r.state === 'suggested').length, 0);
  const before = JSON.stringify(n.w.home.data.sealed('learning.json', (v: any) => v).read());
  assert.deepEqual(await n.learning.consumeNotices(), { counted: 0, set_aside: 0 });
  assert.equal(JSON.stringify(n.w.home.data.sealed('learning.json', (v: any) => v).read()), before, 'nothing new, nothing written');
  // the undone rule's two old taps do not suggest it again; two new taps on that sender make the rule again
  assert.equal(n.rules().filter((r: any) => r.state === 'suggested').length, 0);
  n.w.clock.at += 1000;
  await tap(n, 'a3');
  n.reactions.push({
    kind: 'not_needed',
    rowId: 'gmail:a4',
    matterKey: 'a4',
    fromDomain: 'acme.com',
    fromAddress: null,
    decisionId: 'gmail:a4@1',
    senderStatus: 'pass',
    decidedBy: null,
    outcome: null,
    at: n.w.clock.at + 5000,
  });
  await n.learning.consumeNotices();
  assert.equal(n.rules().filter((r: any) => r.state === 'suggested').length, 1);
});

test('a home move between the first tap and the second: the new home counts the second only, and the rule is made once', async (t) => {
  const { host, A, B } = await import('./support/host/momoMoveWorld.ts');
  const { default: learningService } = await import('../host/src/momoServices/learning.mjs' as string);
  const { default: gateService } = await import('../host/src/momoServices/gate.mjs' as string);
  const { moveHome } = await import('../shared/momoMove.mjs' as string);
  const a = await host(t, A);
  const b = await host(t, B);
  const reactions: any[] = [];
  const tapped = (id: string, at: number) => ({
    kind: 'not_needed',
    rowId: `gmail:${id}`,
    matterKey: id,
    fromDomain: 'acme.com',
    fromAddress: null,
    decisionId: `gmail:${id}@1`,
    senderStatus: 'pass',
    decidedBy: null,
    outcome: null,
    at,
    store: 's1',
    seq: at,
  });
  for (const h of [a, b]) {
    const deps = { home: h.home, now: () => Date.now() };
    gateService(deps);
    learningService(deps);
    // the notice lane's store travels with the home: both homes see the same reactions
    h.home.provide('notice', { reactions: () => reactions });
  }
  await a.home.start(A);
  reactions.push(tapped('m1', 1));
  await a.home.service('learning').consumeNotices();
  assert.equal(a.home.service('learning').view().signals.length, 1);
  const moved = await moveHome({ moveId: 'move-0001', from: a.side, to: b.side, target: B, fromName: A.name });
  assert.equal(moved.ok, true);
  const learning = b.home.service('learning');
  assert.equal(learning.view().signals.length, 1, 'the first tap came with the home');
  assert.deepEqual(await learning.consumeNotices(), { counted: 0, set_aside: 0 }, 'it is not counted again');
  reactions.push(tapped('m2', 2));
  assert.deepEqual(await learning.consumeNotices(), { counted: 1, set_aside: 0 });
  assert.deepEqual(
    learning.view().rules.map((r: any) => r.state),
    ['suggested'],
  );
});
