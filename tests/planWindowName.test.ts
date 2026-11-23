// How the composer names a plan window (src/harness/usageWindows.ts planWindowName): the weekly window's name is the harness's own, never a literal in a component.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planWindowName } from '../src/harness/usageWindows.ts';
import type { HarnessId } from '../src/harness/types.ts';

test('Claude names its weekly window "All models"; Codex keeps the plain label', () => {
  assert.equal(planWindowName('claude', 'Weekly'), 'Weekly · All models');
  assert.equal(planWindowName('codex', 'Weekly'), 'Weekly');
});

test('a harness with no name of its own for the weekly window (an ACP one) shows the plain label', () => {
  assert.equal(planWindowName('some-acp-agent' as HarnessId, 'Weekly'), 'Weekly');
});

test('the 5-hour window and a per-model weekly window read the same for every harness', () => {
  for (const h of ['claude', 'codex', 'some-acp-agent'] as HarnessId[]) {
    assert.equal(planWindowName(h, '5h'), '5-hour limit');
    assert.equal(planWindowName(h, 'Weekly Sonnet'), 'Weekly · Sonnet');
    assert.equal(planWindowName(h, 'Limit'), 'Limit');
  }
});
