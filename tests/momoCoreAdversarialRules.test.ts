// More of rakazo's approval cases through MoMo's gate, and the gate rule matcher under random and hostile input. Cases adapted from elie222/rakazo packages/core/src/runs/action-approval.test.ts, Apache License 2.0 (see shared/momoCore/NOTICE for the licence and credit); changed: rewritten for MoMo's deterministic gate and its request shape (tool, effect, scope), rule order permuted, no connector kinds, no Auto checker.
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type ActionRequest, type Card, decide } from '../shared/momoCore/approvalGate.ts';
import { type GateRule, escapeGlob, globMatches } from '../shared/momoCore/gateRules.ts';
import { createTurnTaint, taintsTurn } from '../shared/momoCore/turnTaint.ts';
import { rng, world } from './support/momoCore/adversarialKit.ts';

const rule = (id: string, behavior: GateRule['behavior'], tool = '*', effect = '*', scope = '*'): GateRule => ({
  id,
  behavior,
  tool,
  effect,
  scope,
  text: id,
});
const request = (over: Partial<ActionRequest> = {}): ActionRequest => ({
  tool: 'gmail.send',
  effect: 'send',
  scope: 'dana@example.com',
  args: { body: 'Hi' },
  origin: 'chat',
  chatId: 'c1',
  tainted: false,
  summary: 's',
  ...over,
});
const permutations = <T>(items: readonly T[]): T[][] =>
  items.length <= 1
    ? [[...items]]
    : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));

test('rakazo "block rules win over a narrower allow": a deny on the whole tool family beats an allow on one tool, in every rule order', () => {
  const rules = [
    rule('allowOne', 'allow', 'gmail.send', 'send', 'dana@example.com'),
    rule('askFamily', 'ask', 'gmail.*'),
    rule('denyFamily', 'deny', 'gmail.*'),
  ];
  for (const order of permutations(rules)) {
    const d = decide(request(), order);
    assert.deepEqual([d.verdict, d.reason, d.ruleId], ['deny', 'rule_deny', 'denyFamily'], order.map((x) => x.id).join());
  }
});

test('rakazo "require_approval beats always-allow at the same specificity": an ask rule beats an allow rule, in every order, and the ask rule is the one named', () => {
  const rules = [
    rule('allow', 'allow', 'gmail.send', 'send', 'dana@example.com'),
    rule('ask', 'ask', 'gmail.send', 'send', 'dana@example.com'),
  ];
  for (const order of permutations(rules))
    assert.deepEqual(decide(request(), order), { verdict: 'ask', reason: 'rule_ask', ruleId: 'ask' });
  // the narrower allow does not rescue a request the ask rule covers, and a rule for another scope changes nothing
  assert.equal(
    decide(request({ scope: 'sam@example.org' }), [rule('ask', 'ask', 'gmail.send', 'send', 'dana@example.com')]).verdict,
    'ask',
  );
  assert.equal(
    decide(request({ scope: 'sam@example.org' }), [
      rule('allow', 'allow', 'gmail.send', 'send', 'sam@example.org'),
      rule('ask', 'ask', 'gmail.send', 'send', 'dana@example.com'),
    ]).verdict,
    'allow',
  );
});

test('rakazo "an allow for another tool does not relax this one": allow rules for a different tool, effect or scope never allow', () => {
  const others = [
    rule('otherTool', 'allow', 'calendar.*', 'send', '*'),
    rule('otherEffect', 'allow', 'gmail.send', 'write', '*'),
    rule('otherScope', 'allow', 'gmail.send', 'send', '*@example.org'),
    rule('prefixTool', 'allow', 'gmail.sen', 'send', '*'),
    rule('longerTool', 'allow', 'gmail.send_all', 'send', '*'),
  ];
  for (const order of permutations(others.slice(0, 4))) assert.equal(decide(request(), order).verdict, 'ask');
  assert.equal(decide(request(), [others[4]]).verdict, 'ask');
});

test('rakazo "does not gate read-only or local work", "never relaxes a mutating name": the effect decides, not the tool name', () => {
  for (const tool of ['gmail.list_threads', 'gmail.get_message', 'files.load_secret_export', 'shell.read_and_delete'])
    assert.equal(decide(request({ tool, effect: 'read' }), []).verdict, 'allow', tool);
  for (const tool of ['gmail.list_threads', 'files.read_only_export', 'notes.get_all'])
    for (const effect of ['write', 'send', 'delete'] as const)
      assert.equal(decide(request({ tool, effect }), []).verdict, 'ask', `${tool} ${effect}`);
});

test('rakazo "reports the block rule even when a narrower allow also matched": the deny is named, whatever else matched, even for spend and settings', () => {
  for (const effect of ['write', 'send', 'delete', 'spend', 'settings'] as const) {
    const d = decide(request({ effect }), [
      rule('allowNarrow', 'allow', 'gmail.send', effect, 'dana@example.com'),
      rule('block', 'deny', 'gmail.*', effect),
    ]);
    assert.deepEqual([d.verdict, d.ruleId], ['deny', 'block'], effect);
  }
});

test('rakazo "connectorReadRequiresApproval": a read stays free until outside content is in the chat; then only a read that sends text out becomes a send that asks', () => {
  const read = (over: Partial<ActionRequest>) => decide(request({ effect: 'read', ...over }), [rule('allowAll', 'allow')]);
  assert.equal(read({ tainted: false, egress: 'network' }).verdict, 'allow');
  assert.equal(read({ tainted: true, egress: 'none' }).verdict, 'allow');
  assert.equal(read({ tainted: true }).verdict, 'allow');
  assert.deepEqual(read({ tainted: true, egress: 'network' }), { verdict: 'ask', reason: 'tainted' });
  // an unprompted run in a tainted chat may not send, so a network read there is refused outright
  assert.deepEqual(read({ tainted: true, egress: 'network', origin: 'unprompted' }), { verdict: 'deny', reason: 'unprompted_read_only' });
  assert.equal(read({ tainted: true, egress: 'network', origin: 'task' }).verdict, 'ask');
});

test('rakazo "toolResultTaintsRun": what the run read taints it, MoMo’s own state does not, and a new kind of source counts as outside', () => {
  const OWN_STATE = ['ask_user', 'remember', 'recall_memory', 'skill_create', 'skill_read', 'skill_update', 'skill_delete', 'write_file'];
  const OUTSIDE = [
    'web_fetch',
    'web_search',
    'browser_snapshot',
    'computer_observe',
    'shell',
    'read_file',
    'run_subagent',
    'gmail_list_messages',
    'some_future_tool',
  ];
  // the host classifies each tool result as owner_state, outside or unknown; here a tool nobody classified is unknown
  const sourceOf = (tool: string) =>
    OWN_STATE.includes(tool) ? 'owner_state' : OUTSIDE.slice(0, 4).includes(tool) ? 'outside' : 'unknown';
  for (const tool of OWN_STATE) {
    const t = createTurnTaint();
    t.toolResult(sourceOf(tool) as 'owner_state');
    assert.equal(t.tainted(), false, tool);
  }
  for (const tool of OUTSIDE) {
    const t = createTurnTaint();
    t.toolResult(sourceOf(tool) as 'outside');
    assert.equal(t.tainted(), true, tool);
  }
  assert.equal(taintsTurn('owner_state'), false);
  // one outside result after many clean ones taints; the owner talking after it does not clear it
  const t = createTurnTaint();
  for (const _tool of OWN_STATE) t.toolResult('owner_state');
  t.toolResult('unknown');
  t.ownerMessage();
  assert.equal(t.tainted(), true);
});

test('rakazo "requires human confirmation to approve an agent connection": a settings change always asks, past any allow, and a deny still wins', () => {
  const allowAll = rule('allowAll', 'allow');
  assert.deepEqual(decide(request({ tool: 'agents.respond_connection', effect: 'settings', scope: 'agent-7' }), [allowAll]), {
    verdict: 'ask',
    reason: 'mandatory',
  });
  assert.equal(
    decide(request({ tool: 'agents.respond_connection', effect: 'settings', scope: 'agent-7' }), [allowAll, rule('no', 'deny', 'agents.*')])
      .verdict,
    'deny',
  );
});

test('globs: a rule built from any literal text matches exactly that text, and never anything else', () => {
  const r = rng(77);
  const ALPHABET = [...'aAb*\\.?+[](){}^$| @\n-_/é'];
  for (let i = 0; i < 2000; i++) {
    const literal = Array.from({ length: r.int(10) }, () => r.pick(ALPHABET)).join('');
    const pattern = escapeGlob(literal);
    assert.ok(globMatches(pattern, literal), JSON.stringify(literal));
    const other = r.chance(0.5) ? literal + r.pick(ALPHABET) : r.pick(ALPHABET) + literal;
    assert.equal(globMatches(pattern, other), false, `${JSON.stringify(literal)} matched ${JSON.stringify(other)}`);
    const star = `${escapeGlob(literal)}*`;
    assert.ok(globMatches(star, other.startsWith(literal) ? other : literal));
  }
});

test('globs: a domain suffix rule does not match a lookalike domain, an embedded newline, or a trailing part', () => {
  for (const scope of ['dana@example.com.evil.net', 'dana@example.comx', 'dana@evilexample.org', 'dana@example.co', 'dana@exampleXcom']) {
    assert.equal(globMatches('*@example.com', scope), false, scope);
  }
  assert.ok(globMatches('*@example.com', 'dana@example.com'));
});

test('F7 minimal repro: a rule with many wildcards is answered quickly even for a long, non-matching scope', () => {
  const code = `
    import { globMatches } from ${JSON.stringify(new URL('../shared/momoCore/gateRules.ts', import.meta.url).href)};
    globMatches('*a'.repeat(12) + '*b', 'a'.repeat(80));
  `;
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', code], { timeout: 1500, killSignal: 'SIGKILL' });
  assert.ok(!out.error, `the match did not finish in 1.5 s (${out.error?.message})`);
});

test('F8 minimal repro: an unattended repeat of a denied action is refused even when only the arguments differ', async () => {
  const w = world();
  const first = (await w.gate.check(request({ origin: 'task', args: { body: 'Hi Dana' } }), [])) as { card: Card };
  await w.gate.answer(first.card.id, 'deny', 'dev:a');
  w.advance(60_000);
  const again = await w.gate.check(request({ origin: 'task', args: { body: 'Hi Dana!' } }), []);
  assert.deepEqual([again.verdict, again.reason], ['deny', 'repeats_denied']);
});

test('F9 minimal repro: a deny rule for an address also covers the same address in another letter case', () => {
  const rules = [rule('allowMail', 'allow', 'gmail.*', 'send', '*'), rule('noDana', 'deny', 'gmail.*', 'send', 'dana@example.com')];
  assert.equal(decide(request({ scope: 'dana@example.com' }), rules).verdict, 'deny');
  assert.notEqual(decide(request({ scope: 'Dana@Example.COM' }), rules).verdict, 'allow');
});

test('F10 minimal repro: an owner rule that says "ask" for a read tool makes a card', () => {
  const askRead = rule('askBank', 'ask', 'bank.statement', 'read', '*');
  assert.equal(decide(request({ tool: 'bank.statement', effect: 'read', scope: 'checking' }), [askRead]).verdict, 'ask');
});
