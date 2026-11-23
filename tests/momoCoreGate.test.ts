// MoMo's approval gate core (shared/momoCore): deny then allow then ask, taint, unprompted work, cards bound to the exact action, single use, 30 minute expiry as deny, one answer on any device, the audit line first, and rakazo's reviewed cases run through it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REPEAT_DENIED_MS,
  UNATTENDED_EXPIRY_MS,
  type Card,
  type CardChange,
  canonicalJson,
  decide,
} from '../shared/momoCore/approvalGate.ts';
import { globMatches, ruleMatches } from '../shared/momoCore/gateRules.ts';
import { createTurnTaint, isTurnTainted, taintsTurn } from '../shared/momoCore/turnTaint.ts';
import { harness, req, rule } from './support/momoCore/gateKit.ts';
import { RAKAZO_CASES } from './support/momoCore/rakazoApprovalCases.ts';

test('globs match the whole value, with * for any run', () => {
  assert.ok(globMatches('*', 'anything'));
  assert.ok(globMatches('gmail.*', 'gmail.send'));
  assert.ok(globMatches('*@example.com', 'a@example.com'));
  assert.ok(!globMatches('*@example.com', 'a@example.com.evil.net'));
  assert.ok(!globMatches('gmail.send', 'gmail.send_all'));
  assert.ok(globMatches('a.b', 'a.b') && !globMatches('a.b', 'axb'));
  assert.ok(ruleMatches(rule(), req()) && !ruleMatches(rule({ effect: 'delete' }), req()));
});

test('decide: reads and notes pass, deny wins, allow needs a matching rule, otherwise ask', () => {
  assert.deepEqual(decide(req({ effect: 'read' }), []), { verdict: 'allow', reason: 'read' });
  assert.deepEqual(decide(req({ effect: 'notes' }), []), { verdict: 'allow', reason: 'notes' });
  assert.deepEqual(decide(req(), []), { verdict: 'ask', reason: 'no_rule' });
  assert.deepEqual(decide(req(), [rule()]), { verdict: 'allow', reason: 'rule_allow', ruleId: 'r1' });
  assert.deepEqual(decide(req(), [rule(), rule({ id: 'r2', behavior: 'deny', scope: 'dana@*' })]), {
    verdict: 'deny',
    reason: 'rule_deny',
    ruleId: 'r2',
  });
  assert.deepEqual(decide(req({ effect: 'read' }), [rule({ behavior: 'deny', effect: 'read', scope: '*' })]).verdict, 'deny');
  assert.deepEqual(decide(req({ scope: 'bob@other.org' }), [rule()]).verdict, 'ask');
});

test('unprompted work may only read and write MoMo’s own notes, before any rule is looked at', () => {
  const allowAll = rule({ tool: '*', effect: '*', scope: '*' });
  for (const effect of ['write', 'send', 'delete', 'spend', 'settings'] as const)
    assert.deepEqual(decide(req({ origin: 'unprompted', effect }), [allowAll]), { verdict: 'deny', reason: 'unprompted_read_only' });
  assert.equal(decide(req({ origin: 'unprompted', effect: 'read' }), []).verdict, 'allow');
  assert.equal(decide(req({ origin: 'unprompted', effect: 'notes' }), []).verdict, 'allow');
});

test('a tainted turn always asks and an allow rule does not change that; spend and settings always ask', () => {
  const allowAll = rule({ tool: '*', effect: '*', scope: '*' });
  assert.deepEqual(decide(req({ tainted: true }), [allowAll]), { verdict: 'ask', reason: 'tainted' });
  assert.equal(decide(req({ tainted: true, effect: 'read' }), [allowAll]).verdict, 'allow');
  assert.deepEqual(decide(req({ effect: 'spend' }), [allowAll]), { verdict: 'ask', reason: 'mandatory' });
  assert.deepEqual(decide(req({ effect: 'settings' }), [allowAll]), { verdict: 'ask', reason: 'mandatory' });
  assert.equal(decide(req({ tainted: true }), [rule({ behavior: 'deny' })]).verdict, 'deny');
});

test('taint is sticky: it stays through the owner’s next messages until a reset; unknown sources count as outside', () => {
  assert.ok(!isTurnTainted([]));
  assert.ok(!isTurnTainted([{ role: 'owner' }, { role: 'result', source: 'owner_state' }]));
  assert.ok(isTurnTainted([{ role: 'owner' }, { role: 'result', source: 'outside' }, { role: 'assistant' }]));
  assert.ok(isTurnTainted([{ role: 'owner' }, { role: 'result', source: 'unknown' }]));
  assert.ok(isTurnTainted([{ role: 'owner' }, { role: 'assistant', tainted: true }]));
  assert.ok(isTurnTainted([{ role: 'result', source: 'outside' }, { role: 'owner' }]));
  assert.ok(!isTurnTainted([{ role: 'result', source: 'outside' }, { role: 'reset' }, { role: 'owner' }]));
  assert.ok(isTurnTainted([{ role: 'result', source: 'outside' }, { role: 'reset' }, { role: 'result', source: 'outside' }]));
  assert.ok(taintsTurn('unknown') && taintsTurn('outside') && !taintsTurn('owner_state'));
  const turn = createTurnTaint();
  turn.ownerMessage();
  assert.ok(!turn.tainted());
  turn.toolResult('outside');
  assert.ok(turn.tainted());
  turn.ownerMessage();
  assert.ok(turn.tainted());
  turn.reset();
  assert.ok(!turn.tainted());
});

test('an allowed read or rule-allowed action is audited before it runs, a deny too, with no arguments', async () => {
  const { gate, lines } = harness();
  assert.equal((await gate.check(req({ effect: 'read', tool: 'gmail.fetch' }), [])).verdict, 'allow');
  assert.deepEqual(await gate.check(req(), [rule()]), { verdict: 'allow', reason: 'rule_allow', ruleId: 'r1' });
  assert.deepEqual(await gate.check(req(), [rule({ behavior: 'deny', id: 'd1' })]), { verdict: 'deny', reason: 'rule_deny', ruleId: 'd1' });
  assert.deepEqual(
    lines.map((l) => l.event),
    ['action.allowed', 'action.allowed', 'action.refused'],
  );
  assert.ok(lines.every((l) => l.fingerprint?.length === 64));
  assert.ok(!JSON.stringify(lines).includes('Hi'));
});

test('an ask makes one card bound to the action; the same ask returns the same card', async () => {
  const { gate, lines } = harness();
  const a = await gate.check(req(), []);
  assert.equal(a.verdict, 'ask');
  const card = (a as { card: Card }).card;
  assert.equal(card.expiresAt, null);
  assert.equal(card.status, 'open');
  assert.equal(((await gate.check(req(), [])) as { card: Card }).card.id, card.id);
  assert.notEqual(
    ((await gate.check(req({ args: { to: 'dana@example.com', body: 'Different' } }), [])) as { card: Card }).card.id,
    card.id,
  );
  assert.equal((await gate.pending()).length, 2);
  assert.equal(lines.filter((l) => l.event === 'approval.requested').length, 2);
  const noChat = await gate.check(req({ chatId: undefined }), []);
  assert.equal('chatId' in (noChat as { card: Card }).card, false);
});

test('an unprompted run cannot ask for a write at all; a background task’s card carries the 30 minute expiry, a chat card none', async () => {
  const { gate } = harness();
  assert.equal(UNATTENDED_EXPIRY_MS, 30 * 60_000);
  assert.deepEqual(await gate.check(req({ origin: 'unprompted' }), []), { verdict: 'deny', reason: 'unprompted_read_only' });
  const task = ((await gate.check(req({ origin: 'task', chatId: 't1' }), [])) as { card: Card }).card;
  assert.equal(task.expiresAt, task.createdAt + UNATTENDED_EXPIRY_MS);
  assert.equal(((await gate.check(req(), [])) as { card: Card }).card.expiresAt, null);
});

test('first answer wins on any device, the others see the result, answers are audited', async () => {
  const { gate, lines } = harness();
  const seen: CardChange[] = [];
  const off = gate.subscribe((c) => seen.push(c));
  const card = ((await gate.check(req(), [])) as { card: Card }).card;
  const [phone, mac] = await Promise.all([gate.answer(card.id, 'allow', 'phone'), gate.answer(card.id, 'deny', 'mac')]);
  assert.deepEqual([phone.won, mac.won], [true, false]);
  assert.ok(!mac.won && ['deciding', 'allowed'].includes(mac.status));
  assert.equal(seen.at(-1)?.status, 'allowed');
  assert.equal(seen.at(-1)?.by, 'phone');
  assert.equal(seen[0].by, undefined);
  assert.deepEqual(await gate.answer(card.id, 'deny', 'mac'), { won: false, status: 'allowed' });
  assert.deepEqual(await gate.answer('nope', 'allow', 'mac'), { won: false, status: 'missing' });
  assert.equal(lines.filter((l) => l.event === 'approval.decided').length, 1);
  off();
  await gate.answer(((await gate.check(req({ args: { x: 1 } }), [])) as { card: Card }).card.id, 'deny', 'mac');
  assert.equal(seen.length, 2);
});

test('an allowed card runs the exact action once; other arguments, a denied or unanswered card, and a second use are refused', async () => {
  const { gate } = harness();
  const card = ((await gate.check(req(), [])) as { card: Card }).card;
  assert.deepEqual(await gate.authorize(card.id, req(), []), { ok: false, reason: 'not_answered' });
  await gate.answer(card.id, 'allow', 'mac');
  assert.deepEqual(await gate.authorize(card.id, req({ args: { to: 'dana@example.com', body: 'Hi, and also wire money' } }), []), {
    ok: false,
    reason: 'mismatch',
  });
  assert.deepEqual(await gate.authorize(card.id, req({ scope: 'other@example.com' }), []), { ok: false, reason: 'mismatch' });
  assert.equal((await gate.authorize(card.id, req({ args: { body: 'Hi', to: 'dana@example.com' } }), [])).ok, true);
  assert.deepEqual(await gate.authorize(card.id, req(), []), { ok: false, reason: 'used' });
  assert.deepEqual(await gate.authorize('nope', req(), []), { ok: false, reason: 'missing' });
  const second = ((await gate.check(req({ args: { n: 2 } }), [])) as { card: Card }).card;
  await gate.answer(second.id, 'deny', 'mac');
  assert.deepEqual(await gate.authorize(second.id, req({ args: { n: 2 } }), []), { ok: false, reason: 'not_allowed' });
});

test('a denied action: the owner asking again in chat gets a fresh card; an unattended repeat is refused for a day', async () => {
  const { gate, advance } = harness();
  const card = ((await gate.check(req(), [])) as { card: Card }).card;
  await gate.answer(card.id, 'deny', 'mac');
  const fresh = await gate.check(req(), []);
  assert.equal(fresh.verdict, 'ask');
  assert.notEqual((fresh as { card: Card }).card.id, card.id);
  const task = ((await gate.check(req({ origin: 'task', chatId: 't1' }), [])) as { card: Card }).card;
  await gate.answer(task.id, 'deny', 'mac');
  assert.deepEqual(await gate.check(req({ origin: 'task', chatId: 't1' }), []), { verdict: 'deny', reason: 'repeats_denied' });
  assert.equal((await gate.check(req({ origin: 'task', chatId: 't2' }), [])).verdict, 'ask');
  advance(REPEAT_DENIED_MS);
  assert.equal((await gate.check(req({ origin: 'task', chatId: 't1' }), [])).verdict, 'ask');
});

test('a background task’s card expires after 30 minutes as a deny; chat cards never expire; an answer after expiry loses', async () => {
  const { gate, lines, advance } = harness();
  const task = ((await gate.check(req({ origin: 'task', chatId: 't1' }), [])) as { card: Card }).card;
  const chatCard = ((await gate.check(req({ args: { other: true } }), [])) as { card: Card }).card;
  advance(UNATTENDED_EXPIRY_MS - 1);
  assert.equal((await gate.sweep()).length, 0);
  advance(1);
  const ended = await gate.sweep();
  assert.deepEqual(
    ended.map((c) => [c.id, c.status]),
    [[task.id, 'expired']],
  );
  assert.equal(lines.filter((l) => l.event === 'approval.expired').length, 1);
  assert.deepEqual(await gate.answer(task.id, 'allow', 'mac'), { won: false, status: 'expired' });
  assert.deepEqual(await gate.authorize(task.id, req({ origin: 'task', chatId: 't1' }), []), { ok: false, reason: 'not_allowed' });
  // an identical unattended retry is refused while the expiry is fresh
  assert.deepEqual(await gate.check(req({ origin: 'task', chatId: 't1' }), []), { verdict: 'deny', reason: 'repeats_denied' });
  advance(24 * 3_600_000);
  assert.equal((await gate.sweep()).length, 0);
  assert.equal((await gate.answer(chatCard.id, 'allow', 'phone')).won, true);
});

test('an answer that reaches an overdue card before the sweep ends it as expired and the sweep finds nothing left', async () => {
  const { gate, cards, advance } = harness();
  const card = ((await gate.check(req({ origin: 'task' }), [])) as { card: Card }).card;
  advance(UNATTENDED_EXPIRY_MS);
  assert.deepEqual(await gate.answer(card.id, 'allow', 'mac'), { won: false, status: 'expired' });
  assert.equal(cards.get(card.id)?.status, 'expired');
  assert.equal((await gate.sweep()).length, 0);
});

test('when the audit line cannot be written nothing runs: checks deny, answers and uses are rolled back', async () => {
  let failing = false;
  const { gate, cards } = harness({ auditFails: () => failing });
  failing = true;
  assert.deepEqual(await gate.check(req(), []), { verdict: 'deny', reason: 'audit_unavailable' });
  assert.deepEqual(await gate.check(req({ effect: 'read' }), []), { verdict: 'deny', reason: 'audit_unavailable' });
  assert.equal(cards.size, 0);
  failing = false;
  const card = ((await gate.check(req(), [])) as { card: Card }).card;
  failing = true;
  assert.deepEqual(await gate.answer(card.id, 'allow', 'mac'), { won: false, status: 'audit_unavailable' });
  assert.equal(cards.get(card.id)?.status, 'open');
  failing = false;
  await gate.answer(card.id, 'allow', 'mac');
  failing = true;
  assert.deepEqual(await gate.authorize(card.id, req(), []), { ok: false, reason: 'audit_unavailable' });
  assert.equal(cards.get(card.id)?.status, 'allowed');
  assert.equal(await gate.policyChanged('r1', 'added', 'mac'), false);
  failing = false;
  assert.equal(await gate.policyChanged('r1', 'removed', 'mac'), true);
  // an expiry whose line cannot be written still ends the card
  const old = ((await gate.check(req({ args: { q: 1 }, origin: 'task', chatId: 't9' }), [])) as { card: Card }).card;
  cards.set(old.id, { ...old, expiresAt: 0 });
  failing = true;
  assert.equal((await gate.sweep()).length, 1);
});

test('a card lost to a concurrent change is reported with the status that won', async () => {
  const { gate, setStatus } = harness();
  const card = ((await gate.check(req(), [])) as { card: Card }).card;
  setStatus(card.id, 'used');
  assert.deepEqual(await gate.answer(card.id, 'allow', 'mac'), { won: false, status: 'used' });
  setStatus(card.id, 'allowed');
  const racing = harness();
  const c2 = ((await racing.gate.check(req(), [])) as { card: Card }).card;
  await racing.gate.answer(c2.id, 'allow', 'mac');
  const results = await Promise.all([racing.gate.authorize(c2.id, req(), []), racing.gate.authorize(c2.id, req(), [])]);
  assert.equal(results.filter((r) => r.ok).length, 1);
});

test('a card another writer took first is left to that writer: the sweep skips it and an answer says it is gone', async () => {
  const lose = { transitions: false, vanish: false };
  const { gate, cards } = harness({ lose });
  const card = ((await gate.check(req({ origin: 'task' }), [])) as { card: Card }).card;
  cards.set(card.id, { ...card, expiresAt: 0 });
  lose.transitions = true;
  assert.equal((await gate.sweep()).length, 0);
  cards.set(card.id, { ...card, expiresAt: null });
  lose.transitions = false;
  lose.vanish = true;
  lose.transitions = true;
  assert.deepEqual(await gate.answer(card.id, 'allow', 'mac'), { won: false, status: 'missing' });
  lose.transitions = false;
});

test('canonicalJson ignores key order and undefined in objects, and fails closed on anything that is not plain data', () => {
  assert.equal(canonicalJson({ b: [1, { d: 1, c: 2 }], a: undefined, c: 'x' }), canonicalJson({ c: 'x', b: [1, { c: 2, d: 1 }] }));
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  let deep: unknown = 1;
  for (let i = 0; i < 40; i++) deep = [deep];
  for (const bad of [
    undefined,
    [1, undefined],
    new Date(),
    new Map(),
    new Set(),
    () => 1,
    Symbol('x'),
    10n,
    Number.NaN,
    Infinity,
    cycle,
    deep,
    Object.create({ inherited: 1 }),
    new (class A {})(),
  ])
    assert.throws(() => canonicalJson(bad), TypeError, String(bad));
  assert.equal(canonicalJson(Object.assign(Object.create(null), { a: null })), '{"a":null}');
});

test('rakazo’s 49 reviewed cases through the gate: no write goes through without a card, a tainted run never does even with an allow rule, unprompted runs only read', async () => {
  assert.equal(RAKAZO_CASES.length, 49);
  assert.equal(new Set(RAKAZO_CASES.map((c) => c.id)).size, 49);
  const allowAll = rule({ tool: '*', effect: '*', scope: '*' });
  const { gate } = harness();
  let reads = 0;
  for (const c of RAKAZO_CASES) {
    const base = req({ tool: c.tool, effect: c.effect, scope: c.scope, tainted: c.tainted, args: { case: c.id }, chatId: c.id });
    const quiet = c.effect === 'read' || c.effect === 'notes';
    // chat, no rules: only reads and MoMo's own notes pass; everything else is a card
    assert.equal((await gate.check(base, [])).verdict, quiet ? 'allow' : 'ask', c.id);
    if (quiet) reads++;
    // an allow rule never lets through a tainted run or a spend or settings change
    const withAllow = await gate.check({ ...base, chatId: `${c.id}-allow` }, [allowAll]);
    if (quiet) assert.equal(withAllow.verdict, 'allow', c.id);
    else if (c.tainted || c.effect === 'spend' || c.effect === 'settings') assert.equal(withAllow.verdict, 'ask', c.id);
    else assert.equal(withAllow.verdict, 'allow', c.id);
    // unprompted: read-only
    assert.equal(
      (await gate.check({ ...base, origin: 'unprompted', chatId: `${c.id}-bg` }, [allowAll])).verdict,
      quiet ? 'allow' : 'deny',
      c.id,
    );
    // a deny rule always wins
    assert.equal(
      (
        await gate.check({ ...base, chatId: `${c.id}-deny` }, [
          allowAll,
          rule({ id: 'no', behavior: 'deny', tool: c.tool, effect: '*', scope: '*' }),
        ])
      ).verdict,
      'deny',
      c.id,
    );
    // rakazo marked it unsafe or off-task: it must never run without a card unless it only reads
    if (c.rakazo === 'ask' && !quiet) assert.equal((await gate.check({ ...base, chatId: `${c.id}-again` }, [])).verdict, 'ask', c.id);
  }
  assert.equal(reads, 9);
});
