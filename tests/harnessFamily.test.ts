// src/harness/family.ts: the families shared code dispatches on, and each family's traits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HARNESS_TRAITS,
  TEMPORARY_BASIC_HARNESS,
  VOICE_HARNESS,
  harnessFamily,
  harnessKindFrom,
  nativeFamily,
  otherFirstTier,
  pendingBasic,
} from '../src/harness/family.ts';
import { noteOwner } from '../src/harness/ownership.ts';

test('basic controls follow the pending destination, including cancellation and cross-family switches', () => {
  for (const current of [null, 'kimi']) {
    assert.equal(pendingBasic(null, current), current);
    assert.equal(pendingBasic(undefined, current), current);
    assert.equal(pendingBasic('acp:opencode', current), 'opencode');
    for (const target of ['codex', 'claude'] as const) assert.equal(pendingBasic(target, current), null);
  }
});

test('a native session is ACP when it is a basic-tier one, otherwise its first-tier record', () => {
  assert.equal(harnessFamily('codex', 'thread'), 'codex');
  assert.equal(harnessFamily('claude', 'claude:s'), 'claude');
  // a basic-tier session recorded with the Codex owner (asHarness) is still ACP
  assert.equal(harnessFamily('codex', 'acp:kimi:1'), 'acp');
  assert.equal(harnessFamily('claude', null), 'claude');
  assert.equal(harnessFamily('acp:kimi', null), 'acp');
  noteOwner('claude:fam', 'claude');
  assert.equal(nativeFamily('claude:fam'), 'claude');
  assert.equal(nativeFamily('codex-thread'), 'codex');
  assert.equal(nativeFamily('acp:qwen:2'), 'acp');
});

test('every family answers every trait, and the first-tier picks come from the traits', () => {
  const keys = Object.keys(HARNESS_TRAITS.codex).sort();
  for (const f of ['codex', 'claude', 'acp'] as const) assert.deepEqual(Object.keys(HARNESS_TRAITS[f]).sort(), keys);
  assert.equal(otherFirstTier('codex'), 'claude');
  assert.equal(otherFirstTier('claude'), 'codex');
  assert.equal(VOICE_HARNESS, 'codex');
  assert.equal(TEMPORARY_BASIC_HARNESS, 'claude');
  // only Codex uploads feedback; every harness's ratings go somewhere (Codex's upload, or usage data)
  assert.deepEqual(
    (['codex', 'claude', 'acp'] as const).map((f) => [HARNESS_TRAITS[f].feedbackUpload, HARNESS_TRAITS[f].rating]),
    [
      [true, 'upload'],
      [false, 'usage'],
      [false, 'usage'],
    ],
  );
  assert.equal(HARNESS_TRAITS.acp.skills, 'commands');
});

test("a kind is the first-tier pick, else the basic harness, else null: never 'acp:null' (#2862)", () => {
  assert.equal(harnessKindFrom('codex', 'kimi'), 'codex');
  assert.equal(harnessKindFrom(null, 'kimi'), 'acp:kimi');
  assert.equal(harnessKindFrom(null, null), null);
  assert.equal(harnessKindFrom(null, ''), null);
});
