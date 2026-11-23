// Adversarial, seeded property tests for MoMo's approval gate: no card used twice or for another chat or origin, a tainted or unprompted run never acts without a card, every effect has an audit line first, and the audit chain verifies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyChain } from '../shared/host/audit.mjs';
import {
  type ActionRequest,
  type Card,
  type CheckResult,
  ALLOWED_TTL_MS,
  canonicalJson,
  decide,
  effectiveRequest,
} from '../shared/momoCore/approvalGate.ts';
import type { Effect, GateRule } from '../shared/momoCore/gateRules.ts';
import { createTurnTaint, type ResultSource } from '../shared/momoCore/turnTaint.ts';
import { type Rng, requestKey, rng, world } from './support/momoCore/adversarialKit.ts';

const EFFECTS: readonly Effect[] = ['read', 'notes', 'write', 'send', 'delete', 'spend', 'settings'];
const TOOLS = ['gmail.send', 'calendar.create', 'bank.pay', 'notes.add', 'web.fetch'];
const SCOPES = ['dana@example.com', 'sam@example.org', 'primary'];

const rule = (id: string, behavior: GateRule['behavior'], tool = '*', effect = '*', scope = '*'): GateRule => ({
  id,
  behavior,
  tool,
  effect,
  scope,
  text: id,
});
const RULESETS: readonly (readonly GateRule[])[] = [
  [],
  [rule('allowAll', 'allow')],
  [rule('allowGmail', 'allow', 'gmail.*', 'send', '*@example.com')],
  [rule('allowAll', 'allow'), rule('denyBank', 'deny', 'bank.*')],
  [rule('allowAll', 'allow'), rule('askCalendar', 'ask', 'calendar.*')],
  [rule('denyAll', 'deny')],
  [rule('allowGmail', 'allow', 'gmail.*', 'send', '*'), rule('denyDana', 'deny', '*', '*', 'dana@*')],
];

function randomRequest(r: Rng): ActionRequest {
  const effect = r.pick(EFFECTS);
  return {
    tool: r.pick(TOOLS),
    effect,
    scope: r.pick(SCOPES),
    args: { to: r.pick(SCOPES), body: r.pick(['Hi', 'Lunch?']), n: r.int(2) },
    origin: r.pick(['chat', 'chat', 'chat', 'task', 'unprompted']),
    chatId: r.pick(['c1', 'c2', 'c3']),
    tainted: r.chance(0.35),
    summary: 'A step',
    egress: effect === 'read' ? r.pick(['none', 'network']) : undefined,
  };
}
/** The same request with exactly one thing that a card binds changed. */
function mutate(r: Rng, req: ActionRequest): ActionRequest {
  switch (r.int(6)) {
    case 0:
      return { ...req, chatId: req.chatId === 'c1' ? 'c2' : 'c1' };
    case 1:
      return { ...req, origin: req.origin === 'chat' ? 'task' : 'chat' };
    case 2:
      return { ...req, tool: `${req.tool}2` };
    case 3:
      return { ...req, scope: `${req.scope}.evil` };
    case 4:
      return { ...req, args: { ...req.args, extra: 1 } };
    default:
      return { ...req, effect: req.effect === 'write' ? 'delete' : 'write' };
  }
}

const EDGES = new Set([
  'open>deciding',
  'deciding>open',
  'deciding>allowed',
  'deciding>denied',
  'open>expired',
  'allowed>expired',
  'allowed>using',
  'using>allowed',
  'using>used',
]);

async function walk(seed: number, steps: number) {
  const r = rng(seed);
  const w = world();
  const issuer = new Map<string, ActionRequest>();
  const answeredAllow = new Map<string, number>();
  const used = new Set<string>();
  const cardIds: string[] = [];
  const history: ActionRequest[] = [];
  const where = (op: string, i: number) => `seed ${seed} step ${i} ${op}`;
  for (let i = 0; i < steps; i++) {
    const op = r.int(10);
    w.state.failAudit = r.chance(0.08);
    if (op < 4 || cardIds.length === 0) {
      const req = history.length && r.chance(0.4) ? r.pick(history) : randomRequest(r);
      history.push(req);
      const rules = r.pick(RULESETS);
      const before = w.lines.length;
      const result: CheckResult = await w.gate.check(req, rules);
      const appended = w.timeline.slice(-(w.lines.length - before) || undefined).filter((s) => s.k === 'audit');
      const eff = effectiveRequest(req);
      const quiet = eff.effect === 'read' || eff.effect === 'notes';
      if (result.verdict === 'allow') {
        // an allow is on the audit log before it is returned
        assert.equal(w.lines.length - before, 1, where('allow without exactly one audit line', i));
        assert.equal((appended.at(-1) as { event: string }).event, 'action.allowed');
        if (!quiet) {
          assert.equal(result.reason, 'rule_allow', where('only a rule may allow an effect', i));
          assert.ok(!req.tainted, where('a tainted run acted without a card', i));
          assert.notEqual(req.origin, 'unprompted', where('an unprompted run acted', i));
          assert.ok(eff.effect !== 'spend' && eff.effect !== 'settings', where('spend or settings without a card', i));
        }
        assert.notEqual(decide(req, rules).verdict, 'deny', where('allowed what the rules deny', i));
      } else if (result.verdict === 'deny') {
        if (result.reason !== 'audit_unavailable' && result.reason !== 'unhashable_args')
          assert.equal(w.lines.length - before, 1, where('a refusal without its audit line', i));
        else assert.equal(w.lines.length - before, 0);
      } else {
        const card = result.card;
        assert.ok(!(req.origin === 'unprompted' && !quiet), where('an unprompted run was given a card', i));
        if (!issuer.has(card.id)) {
          issuer.set(card.id, eff);
          cardIds.push(card.id);
          const lineIdx = w.timeline.findIndex((s) => s.k === 'audit' && s.event === 'approval.requested' && s.cardId === card.id);
          const putIdx = w.timeline.findIndex((s) => s.k === 'put' && s.id === card.id);
          assert.ok(lineIdx >= 0 && lineIdx < putIdx, where('a card exists before its request line', i));
        } else {
          // the same card may be handed back only for the same action, chat, origin and taint
          assert.equal(requestKey(issuer.get(card.id) as ActionRequest), requestKey(eff), where('a card was handed to another action', i));
        }
      }
    } else if (op < 6) {
      const id = r.pick(cardIds);
      const decision = r.pick(['allow', 'allow', 'deny'] as const);
      const res = await w.gate.answer(id, decision, r.pick(['dev:a', 'dev:b']));
      if (res.won && decision === 'allow') answeredAllow.set(id, w.now());
      assert.ok(!res.won || w.cards.get(id)?.status === (decision === 'allow' ? 'allowed' : 'denied'), where('answer', i));
    } else if (op < 9) {
      const id = r.pick(cardIds);
      const base = issuer.get(id) as ActionRequest;
      const mutated = r.chance(0.5);
      let req = mutated ? mutate(r, base) : { ...base };
      if (!mutated && r.chance(0.3)) req = { ...req, tainted: !req.tainted };
      const rules = r.pick(RULESETS);
      const res = await w.gate.authorize(id, req, rules);
      if (mutated) assert.ok(!res.ok, where(`card used for another action ${requestKey(req)}`, i));
      if (res.ok) {
        assert.ok(!used.has(id), where('a card was used twice', i));
        used.add(id);
        assert.equal(requestKey(base), requestKey(effectiveRequest(req)), where('card used for another chat or action', i));
        assert.ok(answeredAllow.has(id), where('used without an allow answer', i));
        assert.ok(w.now() - (answeredAllow.get(id) as number) < ALLOWED_TTL_MS, where('used after it was void', i));
        assert.ok(!(req.tainted && !res.card.tainted), where('an approval from before the taint was used', i));
        assert.notEqual(decide(effectiveRequest(req), rules).verdict, 'deny', where('used against a deny', i));
        assert.notEqual(req.origin, 'unprompted', where('unprompted use', i));
        const consumed = w.timeline.filter((s) => s.k === 'audit' && s.event === 'approval.consumed' && s.cardId === id);
        assert.equal(consumed.length, 1, where('use without exactly one consumed line', i));
      }
    } else if (op === 9) {
      w.advance(r.pick([1000, 60_000, 4 * 60_000, 6 * 60_000, 31 * 60_000, 25 * 3_600_000]));
      if (r.chance(0.5)) await w.gate.sweep();
    }
  }
  // every state change obeys the card's life cycle, and the line comes first
  const seen = new Map<string, Step0[]>();
  type Step0 = (typeof w.timeline)[number];
  w.timeline.forEach((s, idx) => {
    if (s.k !== 'transition' || !s.applied) return;
    assert.ok(EDGES.has(`${s.from}>${s.to}`), `seed ${seed}: illegal move ${s.from}>${s.to}`);
    const lastAudit = w.timeline
      .slice(0, idx)
      .reverse()
      .find((x) => x.k === 'audit' && x.cardId === s.id) as { event: string; verdict?: string } | undefined;
    if (s.from === 'deciding' && (s.to === 'allowed' || s.to === 'denied'))
      assert.equal(lastAudit?.event, 'approval.decided', `seed ${seed}: ${s.to} before its decided line`);
    if (s.from === 'using' && s.to === 'used')
      assert.equal(lastAudit?.event, 'approval.consumed', `seed ${seed}: used before its consumed line`);
    seen.set(s.id, [...(seen.get(s.id) ?? []), s]);
  });
  // a terminal card never moves again
  for (const [id, moves] of seen) {
    const end = moves.findIndex((m) => m.k === 'transition' && ['denied', 'expired', 'used'].includes(m.to as string));
    assert.ok(end < 0 || end === moves.length - 1, `seed ${seed}: ${id} moved after it ended`);
  }
  // the chain verifies and carries metadata only
  assert.deepEqual(verifyChain(w.lines), { ok: true, brokenAt: null }, `seed ${seed}: audit chain`);
  for (const text of w.lines) assert.ok(!/Lunch\?|"body"|"args"/.test(text), `seed ${seed}: arguments in the audit log`);
  return w;
}

test('random sequences of checks, answers, uses and clock jumps: a card is used once, only for its own action, chat and origin, and every step is audited first', async () => {
  let cardsMade = 0;
  let uses = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const w = await walk(seed, 140);
    cardsMade += w.cards.size;
    uses += [...w.cards.values()].filter((c) => c.status === 'used').length;
  }
  // the walks must reach the interesting states, or they prove nothing
  assert.ok(cardsMade > 300, `cards made: ${cardsMade}`);
  assert.ok(uses > 20, `cards used: ${uses}`);
});

test('the audit log never carries arguments, only the keyed digest of them', async () => {
  const w = world();
  const secretBody = 'transfer-code-7781-zebra';
  const req: ActionRequest = {
    tool: 'gmail.send',
    effect: 'send',
    scope: 'dana@example.com',
    args: { body: secretBody },
    origin: 'chat',
    chatId: 'c1',
    tainted: false,
    summary: 'Send a mail to Dana',
  };
  const res = await w.gate.check(req, []);
  assert.equal(res.verdict, 'ask');
  await w.gate.answer((res as { card: Card }).card.id, 'allow', 'dev:a');
  await w.gate.authorize((res as { card: Card }).card.id, req, []);
  assert.ok(w.lines.length >= 3);
  assert.ok(w.lines.every((l) => !l.includes(secretBody)));
  assert.deepEqual(verifyChain(w.lines), { ok: true, brokenAt: null });
  // a changed line breaks the chain
  const tampered = [...w.lines];
  tampered[1] = tampered[1].replace('approval.decided', 'approval.consumed');
  assert.equal(verifyChain(tampered).ok, false);
  assert.equal(verifyChain(w.lines.slice(0, 1).concat(w.lines.slice(2))).ok, false);
});

test('a tainted or unprompted request never acts without a card, for every effect and rule set', () => {
  const r = rng(7);
  let tainted = 0;
  for (let i = 0; i < 4000; i++) {
    const req = randomRequest(r);
    const rules = r.pick(RULESETS);
    const eff = effectiveRequest(req);
    const verdict = decide(req, rules);
    const quiet = eff.effect === 'read' || eff.effect === 'notes';
    if (verdict.verdict === 'allow' && !quiet) {
      assert.ok(!req.tainted && req.origin !== 'unprompted', canonicalJson(req));
      assert.equal(verdict.reason, 'rule_allow');
    }
    // a read that sends model-chosen text out counts as a send once the chat is tainted
    if (req.tainted && req.effect === 'read' && req.egress === 'network')
      assert.notEqual(verdict.verdict === 'allow', true, canonicalJson(req));
    if (req.tainted && !quiet) tainted++;
    if (req.origin === 'unprompted' && !quiet) assert.equal(verdict.verdict, 'deny');
    if (eff.effect === 'spend' || eff.effect === 'settings') assert.notEqual(verdict.verdict, 'allow');
    if (rules.some((x) => x.id === 'denyAll')) assert.equal(verdict.verdict, 'deny');
  }
  assert.ok(tainted > 500);
});

test('taint follows a plain oracle over random event sequences: sticky until a reset, unknown sources count as outside', () => {
  for (let seed = 0; seed < 300; seed++) {
    const taint = createTurnTaint();
    let expected = false;
    const rr = rng(seed + 1000);
    for (let i = 0; i < 20; i++) {
      const e = rr.int(5);
      if (e === 0) taint.ownerMessage();
      else if (e === 1) taint.toolResult('owner_state');
      else if (e === 2) {
        const source = rr.pick(['outside', 'unknown', 'weird-source'] as const) as ResultSource;
        taint.toolResult(source);
        expected = true;
      } else if (e === 3) {
        taint.reset();
        expected = false;
      } else taint.toolResult('owner_state');
      assert.equal(taint.tainted(), expected, `seed ${seed} step ${i}`);
    }
  }
});

test('two chats asking for the same action get two cards, and answering one never frees the other', async () => {
  const w = world();
  const base: ActionRequest = {
    tool: 'gmail.send',
    effect: 'send',
    scope: 'dana@example.com',
    args: { body: 'Hi' },
    origin: 'chat',
    chatId: 'c1',
    tainted: false,
    summary: 's',
  };
  const a = (await w.gate.check(base, [])) as { card: Card };
  const b = (await w.gate.check({ ...base, chatId: 'c2' }, [])) as { card: Card };
  const t = (await w.gate.check({ ...base, origin: 'task' }, [])) as { card: Card };
  assert.equal(new Set([a.card.id, b.card.id, t.card.id]).size, 3);
  await w.gate.answer(a.card.id, 'allow', 'dev:a');
  for (const other of [
    { ...base, chatId: 'c2' },
    { ...base, origin: 'task' as const },
  ]) {
    assert.deepEqual(await w.gate.authorize(a.card.id, other, []), { ok: false, reason: 'mismatch' });
  }
  assert.deepEqual(await w.gate.authorize(b.card.id, base, []), { ok: false, reason: 'not_answered' });
  assert.equal((await w.gate.authorize(a.card.id, base, [])).ok, true);
  assert.deepEqual(await w.gate.authorize(a.card.id, base, []), { ok: false, reason: 'used' });
});

test('many devices answering and many runs using the same card at once: one answer wins and one use runs', async () => {
  const w = world();
  const req: ActionRequest = {
    tool: 'calendar.create',
    effect: 'write',
    scope: 'primary',
    args: { when: 'Tue 10:00' },
    origin: 'chat',
    chatId: 'c1',
    tainted: false,
    summary: 's',
  };
  const { card } = (await w.gate.check(req, [])) as { card: Card };
  const answers = await Promise.all(['a', 'b', 'c', 'd'].map((d, i) => w.gate.answer(card.id, i % 2 ? 'deny' : 'allow', `dev:${d}`)));
  assert.equal(answers.filter((x) => x.won).length, 1);
  const winner = answers.find((x) => x.won) as { card: Card };
  if (winner.card.status === 'allowed') {
    const uses = await Promise.all([1, 2, 3, 4, 5].map(() => w.gate.authorize(card.id, req, [])));
    assert.equal(uses.filter((x) => x.ok).length, 1);
  }
  assert.deepEqual(verifyChain(w.lines), { ok: true, brokenAt: null });
});
