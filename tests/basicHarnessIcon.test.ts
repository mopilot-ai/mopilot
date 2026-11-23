// A basic harness's mark (src/components/harnessPicker/badges.tsx BasicHarnessIcon): its vendor's logo from
// src/components/harnessPicker/logos.ts, in the text colour, named for screen readers; else its initial on a tile.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { render } from './support/pages-kit.ts';
import { stubStore } from './support/stubs.ts';
import { ACP_CATALOG } from '../shared/harnessCatalog.mjs';

const { createElement: h } = await import('react');
const { harnessesByTier, harnessInfo } = await import('../src/harness/registry.ts');
stubStore({ useStore: () => null, navigate: () => {}, chatFamily: () => null, chatBasicHarness: () => null });
mock.module('../src/session/harness/acp.ts', {
  namedExports: {
    basicLabel: (id: string) => harnessInfo(`acp:${id}`)?.label ?? id,
    BASIC_HOVER: (l: string) => l,
  },
});
// what the module needs besides the mark, which loads the terminal and its stylesheet
mock.module('../src/components/harness/parts.tsx', { namedExports: { PARTS: {} } });
mock.module('../src/components/accounts/meters.tsx', { namedExports: { LimitMeters: () => null } });
const { BasicHarnessIcon } = await import('../src/components/harnessPicker/badges.tsx');
const { BASIC_LOGOS } = await import('../src/components/harnessPicker/logos.ts');

test('every basic harness has a named mark; enabled or verified entries require a vendor logo', async () => {
  const basics = harnessesByTier('basic');
  const ids = basics.map((b) => b.kind.slice('acp:'.length));
  assert.ok(
    Object.keys(BASIC_LOGOS).every((id) => ids.includes(id)),
    'logos have no orphaned harness identities',
  );
  for (const b of basics) {
    const id = b.kind.slice('acp:'.length),
      paths = BASIC_LOGOS[id];
    if (ACP_CATALOG[id].enabled || b.versions.tested.length) assert.ok(paths, `${id}: a shipped or verified harness needs its logo`);
    if (paths) assert.ok(paths.length > 0 && paths.every((d) => d.startsWith('M')));
    const v = await render(h(BasicHarnessIcon, { id }));
    const mark = v.host.querySelector('[role="img"]')!;
    assert.equal(mark.getAttribute('aria-label'), b.label);
    if (!paths) assert.equal(mark.textContent, b.label.charAt(0).toUpperCase());
    await v.unmount();
  }
});

test('every basic harness, shipped or not, has its vendor mark rather than its initial', () => {
  const unmarked = harnessesByTier('basic')
    .map((b) => b.kind.slice('acp:'.length))
    .filter((id) => !BASIC_LOGOS[id] && !ACP_CATALOG[id].developer);
  assert.deepEqual(unmarked, []);
});

test('a logo is an SVG in the text colour, at the size asked, named by its label', async () => {
  const v = await render(h(BasicHarnessIcon, { id: 'kimi', size: 18 }));
  const svg = v.host.querySelector('svg')!;
  assert.equal(svg.getAttribute('class'), 'harness-icon logo');
  assert.equal(svg.getAttribute('role'), 'img');
  assert.equal(svg.getAttribute('aria-label'), 'Kimi Code');
  assert.equal(svg.getAttribute('width'), '18');
  assert.equal(svg.getAttribute('fill'), 'currentColor');
  assert.equal(svg.querySelectorAll('path').length, BASIC_LOGOS.kimi.length);
  await v.unmount();
  const d = await render(h(BasicHarnessIcon, { id: 'gemini' }));
  assert.equal(d.host.querySelector('svg')!.getAttribute('width'), '16', 'the default size');
  await d.unmount();
});

test('a harness without a logo keeps its initial on a tile', async () => {
  const v = await render(h(BasicHarnessIcon, { id: 'newagent', size: 20 }));
  assert.equal(v.host.querySelector('svg'), null);
  const tile = v.host.querySelector('.harness-icon.basic') as HTMLElement;
  assert.equal(tile.textContent, 'N');
  assert.equal(tile.getAttribute('aria-label'), 'newagent');
  await v.unmount();
});
