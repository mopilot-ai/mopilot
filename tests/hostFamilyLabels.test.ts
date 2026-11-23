// A chat that runs Claude Code or Codex on a machine has an ACP-kind id (shared/host/chatIds.mjs): wherever the app names or draws its agent it must be that agent, never "host-claude".
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { render } from './support/pages-kit.ts';
import { stubStore } from './support/stubs.ts';
import { hostFamilyOfHarness } from '../shared/host/chatIds.mjs';

const { createElement: h } = await import('react');
stubStore({ useStore: () => null, navigate: () => {}, chatFamily: () => null, chatBasicHarness: () => null });
mock.module('../src/session/harness/acp.ts', { namedExports: { basicLabel: (id: string) => id, BASIC_HOVER: (l: string) => l } });
mock.module('../src/components/harness/parts.tsx', {
  namedExports: {
    PARTS: {
      claude: { Icon: () => h('i', { id: 'claude-mark' }) },
      codex: { Icon: () => h('i', { id: 'codex-mark' }) },
    },
  },
});
mock.module('../src/components/accounts/meters.tsx', { namedExports: { LimitMeters: () => null } });
const { BasicHarnessIcon } = await import('../src/components/harnessPicker/badges.tsx');
const { harnessLabelOf } = await import('../src/harness/registry.ts');

test('the harness names of a Host chat stand for Claude Code and Codex, and any other name for nothing', () => {
  assert.equal(hostFamilyOfHarness('host-claude'), 'claude');
  assert.equal(hostFamilyOfHarness('host-codex'), 'codex');
  for (const other of ['kimi', 'claude', 'toString', '']) assert.equal(hostFamilyOfHarness(other), null, other);
});

test('the label of a chat on a machine is its agent’s; a basic agent’s chat keeps its own', () => {
  assert.equal(harnessLabelOf('acp:host-claude:u1'), 'Claude Code');
  assert.equal(harnessLabelOf('acp:host-codex:u1'), 'Codex');
  assert.equal(harnessLabelOf('acp:kimi:u1'), 'Kimi Code');
});

test('the mark of a chat on a machine is its agent’s, not an initial on a tile', async () => {
  for (const [id, mark] of [
    ['host-claude', 'claude-mark'],
    ['host-codex', 'codex-mark'],
  ]) {
    const v = await render(h(BasicHarnessIcon, { id }));
    assert.ok(v.host.querySelector(`#${mark}`), id);
    assert.equal(v.host.querySelector('.harness-icon.basic'), null);
    await v.unmount();
  }
});
