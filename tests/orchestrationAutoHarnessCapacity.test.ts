// electron/session/orchestration/autoHarness.cjs by what each harness has left (shared/remainingCapacity.mjs): harness
// "auto" passes over one nearly at its usage limit, keeps the parent's while it has meaningful usage left, picks the one
// with the most left among the others (the fixed order among equals and for unknown usage), and says when the one it
// picked bills per use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { orchestration } from './support/orchestration-harness.ts';
import { SESSION_BACKGROUND as BACKGROUND } from './support/orchestration-harness.ts';

const require = createRequire(import.meta.url);
const { quotaOf } = require('../electron/session/orchestration/autoHarness.cjs');

const REFS: Record<string, any> = {
  codex: { kind: 'codex', id: 'x', key: 'x' },
  claude: { kind: 'claude', id: 'c', key: 'claude:c' },
  'acp:kimi': { kind: 'acp:kimi', id: 'k', key: 'acp:kimi:k' },
};

/** A parent on `own`, with these harnesses known (all usable, none lacking anything). */
function routed(own: string, kinds = ['codex', 'claude', 'acp:kimi']) {
  const h = orchestration({ usable: async () => true });
  h.refs.set('top', REFS[own]);
  h.orch.o.kinds = () => kinds;
  h.orch.o.lacks = () => false;
  h.userTurn();
  return h;
}

/** A parent on `own` whose harnesses have this much left (shared/remainingCapacity.mjs's shape); absent: not known. */
function withCapacity(
  own: string,
  caps: Record<string, { fraction?: number | null; units?: number | null; payPerUse?: string | null; limited?: boolean } | null>,
) {
  const h = routed(own);
  h.orch.o.quota = (kind: string) => {
    const c = caps[kind];
    if (c === undefined || c === null) return null;
    return { limited: c.limited ?? false, payPerUse: c.payPerUse ?? null, fraction: c.fraction ?? null, units: c.units ?? null };
  };
  return h;
}
const auto = { background: BACKGROUND, title: 'P', prompt: 'p', use_worktree: false, harness: 'auto' };

test('auto passes over a parent’s harness that is nearly at its usage limit for the one with the most left', async () => {
  const h = withCapacity('codex', { codex: { fraction: 0.05, units: 1 }, claude: { fraction: 0.4, units: 2 }, 'acp:kimi': null });
  const r = await h.orch.start('top', auto);
  assert.equal(r.harness, 'claude');
  assert.deepEqual(r.harness_choice.considered, [
    { harness: 'codex', why: 'nearly at its usage limit (5% left)' },
    { harness: 'acp:kimi', why: 'can do it, but how much usage it has left is not known' },
    { harness: 'claude' },
  ]);
  assert.equal(
    r.harness_choice.reason,
    "this chat's harness, codex: nearly at its usage limit (5% left); acp:kimi: can do it, but how much usage it has left is not known; claude can do it and has usage left (40% left)",
  );
});

test('auto keeps the parent’s harness while it has meaningful usage left, even when another has more', async () => {
  const h = withCapacity('claude', { claude: { fraction: 0.2, units: 0.2 }, codex: { fraction: 0.9, units: 18 } });
  const r = await h.orch.start('top', auto);
  assert.equal(r.harness, 'claude');
  assert.equal(r.harness_choice.reason, "this chat's harness, claude, can do it and has usage left (20% left)");
  // not known at all: still the parent's
  const unknown = withCapacity('claude', { codex: { fraction: 0.9, units: 18 } });
  assert.equal((await unknown.orch.start('top', auto)).harness, 'claude');
});

test('auto picks, among the others, the one with the most left in plan units, not the fixed order', async () => {
  // codex (first in order) has the higher percent but the smaller plan; claude's Max holds more
  const h = withCapacity('acp:kimi', {
    'acp:kimi': { limited: true },
    codex: { fraction: 0.6, units: 0.6 },
    claude: { fraction: 0.5, units: 2.5 },
  });
  const r = await h.orch.start('top', auto);
  assert.equal(r.harness, 'claude');
  assert.deepEqual(r.harness_choice.considered, [
    { harness: 'acp:kimi', why: 'at its usage limit' },
    { harness: 'codex', why: 'can do it, but has less usage left (60% left)' },
    { harness: 'claude' },
  ]);
  assert.match(r.harness_choice.reason, /; claude can do it and has usage left \(50% left\)$/);
});

test('auto ranks a harness whose usage is not known after every known one, and keeps the order among equals', async () => {
  // claude's usage is not known, kimi's is: kimi first, and claude is said to be passed over for it
  const known = withCapacity('codex', { codex: { limited: true }, claude: null, 'acp:kimi': { fraction: 0.3, units: 0.3 } });
  const r = await known.orch.start('top', auto);
  assert.equal(r.harness, 'acp:kimi');
  assert.deepEqual(r.harness_choice.considered[1], { harness: 'claude', why: 'can do it, but how much usage it has left is not known' });
  // as much left, or neither known: the fixed order, and the later one is never weighed or listed
  for (const caps of [
    { codex: { limited: true }, claude: { fraction: 0.5, units: 1 }, 'acp:kimi': { fraction: 0.5, units: 1 } },
    { codex: { limited: true }, claude: null, 'acp:kimi': null },
  ]) {
    const tie = await withCapacity('codex', caps).orch.start('top', auto);
    assert.equal(tie.harness, 'claude');
    assert.deepEqual(
      tie.harness_choice.considered.map((c: any) => c.harness),
      ['codex', 'claude'],
    );
  }
});

test('auto says when the harness it picked bills per use, and ranks pay per use after known plan usage', async () => {
  // the parent's own on an API key: kept, and the reason says it is billed per use
  const own = await withCapacity('claude', { claude: { payPerUse: 'apiKey' } }).orch.start('top', auto);
  assert.equal(own.harness, 'claude');
  assert.equal(own.harness_choice.reason, "this chat's harness, claude, can do it and runs on an API key (billed per use)");
  // another on MoPilot credits, picked when no plan usage is known elsewhere
  const credits = await withCapacity('acp:kimi', {
    'acp:kimi': { limited: true },
    codex: { payPerUse: 'credits' },
    claude: null,
  }).orch.start('top', auto);
  assert.equal(credits.harness, 'codex');
  assert.match(credits.harness_choice.reason, /; codex can do it and runs on MoPilot credits \(billed per use\)$/);
  // a plan with usage left goes before a key; the key is still allowed, only later
  const plan = await withCapacity('acp:kimi', {
    'acp:kimi': { limited: true },
    codex: { payPerUse: 'apiKey' },
    claude: { fraction: 0.5, units: 0.5 },
  }).orch.start('top', auto);
  assert.equal(plan.harness, 'claude');
  assert.deepEqual(plan.harness_choice.considered[1], { harness: 'codex', why: 'can do it, but runs on an API key (billed per use)' });
  const other = await withCapacity('acp:kimi', {
    'acp:kimi': { limited: true },
    codex: { payPerUse: 'somethingNew' },
    claude: { limited: true },
  }).orch.start('top', auto);
  assert.match(other.harness_choice.reason, /codex can do it and runs on pay-per-use billing \(billed per use\)$/);
});

test('a nearly spent harness takes the piece only when no other can, the one with the most left, saying so', async () => {
  const h = withCapacity('codex', {
    codex: { fraction: 0.02, units: 0.02 },
    claude: { fraction: 0.08, units: 0.4 },
    'acp:kimi': { limited: true },
  });
  const r = await h.orch.start('top', auto);
  assert.equal(r.harness, 'claude');
  assert.equal(
    r.harness_choice.reason,
    "this chat's harness, codex: nearly at its usage limit (2% left); acp:kimi: at its usage limit; claude can do it but is nearly at its usage limit (8% left), and no other harness can",
  );
  // the parent's own, when it is the only one: named as this chat's
  const alone = withCapacity('codex', { codex: { fraction: 0.04, units: 0.04 }, claude: { limited: true }, 'acp:kimi': { limited: true } });
  const own = await alone.orch.start('top', auto);
  assert.equal(own.harness, 'codex');
  assert.match(
    own.harness_choice.reason,
    /this chat's harness, codex, can do it but is nearly at its usage limit \(4% left\), and no other harness can$/,
  );
});

test('auto with the registry’s instances: a Codex pool at 5% is passed over for Claude Code with usage left', async () => {
  const instances: Record<string, any[]> = {
    codex: [{ account: 'a', status: 'ok', limited: false, billing: 'subscription', left: 5, units: 20 }],
    claude: [{ account: 'b', status: 'ok', limited: false, billing: 'subscription', left: 70, units: 1 }],
  };
  const h = routed('codex', ['codex', 'claude']);
  h.orch.o.quota = (kind: string) => quotaOf(instances[kind], kind);
  const r = await h.orch.start('top', auto);
  assert.equal(r.harness, 'claude');
  assert.match(
    r.harness_choice.reason,
    /^this chat's harness, codex: nearly at its usage limit \(5% left\); claude can do it and has usage left \(70% left\)$/,
  );
});
