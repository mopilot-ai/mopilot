// Registry-unknown development harnesses keep a usable install fallback without assuming static vendor facts.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { render, click, byText } from './support/pages-kit.ts';

const { createElement: h } = await import('react');
mock.module('../src/session/open.ts', { namedExports: { openLink: () => assert.fail('no invented vendor link') } });
const { InstallGuidance } = await import('../src/components/harness/InstallGuidance.tsx');

test('missing development harnesses without registry entries still offer manual executable selection', async () => {
  for (const id of ['claude-acp', 'codex-acp']) {
    let located = 0;
    const item: any = { kind: `acp:${id}`, label: id, vendor: '', tier: 'basic', state: 'missing', version: null };
    const v = await render(h(InstallGuidance, { item, commands: false, onSetLocation: () => located++ }));
    assert.match(v.host.textContent!, /Install instructions aren't available/);
    assert.match(v.host.textContent!, new RegExp(id));
    assert.equal(v.host.querySelectorAll('button').length, 1);
    await click(byText(v.host, 'Set location…'));
    assert.equal(located, 1);
    await v.unmount();
  }
});
