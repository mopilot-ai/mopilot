import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admittedBasics, codexWantedAtLaunch } from '../src/harness/launch.ts';

const h = (id: string, state: string) => ({ id, state }) as any;

test('Codex starts at launch only when it is the default or has been used', () => {
  assert.equal(codexWantedAtLaunch('codex', false), true);
  assert.equal(codexWantedAtLaunch('claude', false), false);
  assert.equal(codexWantedAtLaunch('acp:dsh', false), false);
  assert.equal(codexWantedAtLaunch('claude', true), true);
});

test('only admitted basic harnesses can run a chat', () => {
  const list = [h('kimi', 'missing'), h('dsh', 'admitted')];
  assert.deepEqual(
    admittedBasics(list).map((x) => x.id),
    ['dsh'],
  );
});
