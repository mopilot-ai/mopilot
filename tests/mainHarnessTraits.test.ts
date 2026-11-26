// What each harness family does differently in main (electron/harness/family.cjs): every family answers every trait,
// and shared session code reads them by a segment kind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MAIN_TRAITS, traitsOf, agentTraitsOf } = require('../electron/harness/family.cjs');

test('every family answers every trait with a boolean', () => {
  assert.deepEqual(Object.keys(MAIN_TRAITS).sort(), ['acp', 'claude', 'codex']);
  const keys = Object.keys(MAIN_TRAITS.codex).sort();
  for (const traits of Object.values(MAIN_TRAITS) as Record<string, unknown>[]) {
    assert.deepEqual(Object.keys(traits).sort(), keys);
    for (const v of Object.values(traits)) assert.equal(typeof v, 'boolean');
  }
});

test("a segment kind reads its family's traits; a kind this build doesn't know is an error", () => {
  assert.equal(traitsOf('codex'), MAIN_TRAITS.codex);
  assert.equal(traitsOf('claude'), MAIN_TRAITS.claude);
  assert.equal(traitsOf('acp:kimi'), MAIN_TRAITS.acp);
  // Codex and Claude Code take a message into a running turn; ACP has no way into a running prompt
  assert.deepEqual(
    ['codex', 'claude', 'acp:kimi'].map((k) => traitsOf(k).steers),
    [true, true, false],
  );
  assert.deepEqual(
    ['codex', 'claude', 'acp:kimi'].map((k) => traitsOf(k).nativePlanApproval),
    [false, true, false],
    'only the adapter with a root native plan-permission protocol emits that proof; every family has the shared plan button',
  );
  // MoPilot holds Claude Code's goal and its sessions ran Claude in Chrome; Codex keeps its own goal natively
  assert.deepEqual(
    ['codex', 'claude', 'acp:kimi'].map((k) => [traitsOf(k).nativeGoal, traitsOf(k).holdsGoal, traitsOf(k).nativeChrome]),
    [
      [true, false, false],
      [false, true, true],
      [false, false, false],
    ],
  );
  assert.throws(() => traitsOf('gemini'), /Unknown harness kind/);
});

test("the agent a kind runs: a machine's Claude Code or Codex chat, drawn here as ACP, is that agent's; an unknown kind has none", () => {
  for (const [kind, family] of [
    ['codex', 'codex'],
    ['claude', 'claude'],
    ['acp:host-claude', 'claude'],
    ['acp:host-codex', 'codex'],
    ['acp:host-claude:thread', 'claude'],
    ['acp:kimi', 'acp'],
  ] as const)
    assert.equal(agentTraitsOf(kind), MAIN_TRAITS[family], kind);
  for (const kind of [undefined, null, '', 'gemini', 42]) assert.equal(agentTraitsOf(kind), null, String(kind));
});
