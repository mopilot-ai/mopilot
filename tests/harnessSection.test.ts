import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { mount } from './support/harness-ui-kit.ts';

const { createElement: h } = await import('react');
mock.module('../src/components/harness/codex/Page.tsx', {
  namedExports: { CodexPage: ({ tab }: any) => h('div', { id: 'codex' }, tab ?? 'none') },
});
mock.module('../src/components/harness/claude/Page.tsx', {
  namedExports: { ClaudePage: ({ tab }: any) => h('div', { id: 'claude' }, tab ?? 'none') },
});
mock.module('../src/components/harness/codex/parts.tsx', { namedExports: { codexParts: { signInLabel: 'codex' } } });
mock.module('../src/components/harness/claude/parts.tsx', { namedExports: { claudeParts: { signInLabel: 'claude' } } });
const { HarnessSection, hasOwnHeader } = await import('../src/components/harness/Section.tsx');
const { PARTS } = await import('../src/components/harness/parts.tsx');

test('the harness section renders the page of the named harness with its tab, and nothing otherwise', async () => {
  const r = await mount(h(HarnessSection, { section: 'codex', tab: 'models' }));
  assert.equal(r.host.querySelector('#codex')?.textContent, 'models');
  await r.render(h(HarnessSection, { section: 'claude' }));
  assert.equal(r.host.querySelector('#claude')?.textContent, 'none');
  await r.render(h(HarnessSection, { section: 'codex' }));
  assert.equal(r.host.querySelector('#codex')?.textContent, 'none');
  await r.render(h(HarnessSection, { section: 'claude', tab: 'advanced' }));
  assert.equal(r.host.querySelector('#claude')?.textContent, 'advanced');
  await r.render(h(HarnessSection, { section: 'general' }));
  assert.equal(r.host.innerHTML, '');
  await r.unmount();
});

test('PARTS looks each harness up by id', () => {
  assert.equal(PARTS.codex.signInLabel, 'codex');
  assert.equal(PARTS.claude.signInLabel, 'claude');
});

test("a harness's own page gives its title; other sections keep the Settings title", () => {
  assert.equal(hasOwnHeader('codex'), true);
  assert.equal(hasOwnHeader('claude'), true);
  assert.equal(hasOwnHeader('harnesses'), false);
  assert.equal(hasOwnHeader('accounts'), false);
});
