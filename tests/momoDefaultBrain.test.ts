// The brain setup starts MoMo on (src/components/momo/setup/defaultBrain.ts, #2527) and what it reads from each family's traits (src/harness/family.ts): the account with the most remaining capacity (plan size times percent left, percent alone where the plan's size is unknown), a harness that keeps several accounts before one with one sign-in, and the everyday model tier per harness family.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultBrain, remaining, type BrainCandidate } from '../src/components/momo/setup/defaultBrain.ts';
import { HARNESS_TRAITS } from '../src/harness/family.ts';

const cand = (harness: string, accounts: BrainCandidate['accounts'], o: Partial<BrainCandidate> = {}): BrainCandidate => ({
  harness,
  label: harness,
  accounts,
  model: { id: `${harness}-m`, label: `${harness} model` },
  multi: true,
  ...o,
});
const acct = (id: string, left: number | null, units: number | null) => ({ id, name: id, left, units });

test('absolute remaining capacity: plan size times percent left, so Max 20× at 83% beats Pro Lite at 87%', () => {
  const claude = HARNESS_TRAITS.claude.planUnits;
  const codex = HARNESS_TRAITS.codex.planUnits;
  const brain = defaultBrain([
    cand('codex', [acct('lite', 87, codex('Pro Lite'))]),
    cand('claude', [acct('max20', 83, claude('Claude Max 20×'))]),
  ]);
  assert.deepEqual(brain, { harness: 'claude', account: 'max20', model: 'claude-m', modelLabel: 'claude model' });
  assert.equal(remaining(acct('x', 83, 20)), 1660);
  assert.equal(remaining(acct('x', 87, 5)), 435);
  // the other way round when the bigger plan is nearly spent
  assert.equal(defaultBrain([cand('codex', [acct('lite', 87, 5)]), cand('claude', [acct('max20', 10, 20)])])!.harness, 'codex');
});

test('an unknown plan size compares by percent left alone; usage not known comes after every known one', () => {
  assert.equal(remaining({ left: 62, units: null }), 62);
  assert.equal(remaining({ left: null, units: 5 }), null);
  const brain = defaultBrain([
    cand('codex', [acct('a', 40, null), acct('b', 70, null), acct('unknown', null, null)]),
    cand('claude', [acct('c', 55, null)]),
  ]);
  assert.equal(brain!.account, 'b');
  // only unknown usage: still a brain, the first
  assert.equal(defaultBrain([cand('codex', [acct('u1', null, null), acct('u2', null, null)])])!.account, 'u1');
  // a known plan with unknown usage loses to a known percent
  assert.equal(defaultBrain([cand('codex', [acct('big', null, 20), acct('small', 1, null)])])!.account, 'small');
});

test('a harness with one sign-in is the choice only when no account of a first-tier harness can be', () => {
  const basic = cand('acp:gemini', [{ id: null, name: 'Gemini CLI', left: null, units: null }], { model: null, multi: false });
  assert.deepEqual(defaultBrain([basic, cand('codex', [acct('a', 1, 1)])]), {
    harness: 'codex',
    account: 'a',
    model: 'codex-m',
    modelLabel: 'codex model',
  });
  assert.deepEqual(defaultBrain([basic]), { harness: 'acp:gemini', account: null, model: null, modelLabel: null });
  assert.equal(defaultBrain([]), null);
  assert.equal(defaultBrain([cand('codex', [])]), null);
});

test('plan sizes per family: the multiplier a plan names, else its word, else unknown', () => {
  const claude = HARNESS_TRAITS.claude.planUnits;
  assert.deepEqual(
    ['Claude Max 20×', 'Claude Max 5×', 'Claude Max', 'Claude Pro', 'Claude Team', 'Max 20x', null, 'Enterprise'].map(claude),
    [20, 5, 5, 1, 1, 20, null, null],
  );
  const codex = HARNESS_TRAITS.codex.planUnits;
  // "Pro Lite" is matched before "Pro"
  assert.deepEqual(['Plus', 'Pro Lite', 'Pro', 'Business', 'Team', 'Enterprise', 'Free', null].map(codex), [
    1,
    5,
    20,
    1,
    1,
    null,
    null,
    null,
  ]);
  assert.equal(HARNESS_TRAITS.acp.planUnits('Pro'), null);
});

test('the everyday model: Sonnet on Claude Code, the list’s default on Codex, none on a basic harness', () => {
  const claudeModels = [
    { id: 'haiku', label: 'Haiku' },
    { id: 'opus', label: 'Opus', isDefault: true },
    { id: 'sonnet', label: 'Sonnet' },
  ];
  assert.equal(HARNESS_TRAITS.claude.everydayModel(claudeModels)!.id, 'sonnet');
  // found by label when the id is a pinned version
  assert.equal(
    HARNESS_TRAITS.claude.everydayModel([
      { id: 'claude-x', label: 'Claude Sonnet X' },
      { id: 'opus', label: 'Opus', isDefault: true },
    ])!.id,
    'claude-x',
  );
  // no Sonnet listed: the list's default, else its first, else none
  assert.equal(
    HARNESS_TRAITS.claude.everydayModel([
      { id: 'haiku', label: 'Haiku' },
      { id: 'opus', label: 'Opus', isDefault: true },
    ])!.id,
    'opus',
  );
  assert.equal(HARNESS_TRAITS.claude.everydayModel([{ id: 'haiku', label: 'Haiku' }])!.id, 'haiku');
  assert.equal(HARNESS_TRAITS.claude.everydayModel([]), null);
  const codexModels = [
    { id: 'gpt-6-pro', label: 'GPT-6 Pro' },
    { id: 'gpt-6', label: 'GPT-6', isDefault: true },
  ];
  assert.equal(HARNESS_TRAITS.codex.everydayModel(codexModels)!.id, 'gpt-6');
  assert.equal(HARNESS_TRAITS.codex.everydayModel([]), null);
  assert.equal(HARNESS_TRAITS.acp.everydayModel(codexModels), null);
});
