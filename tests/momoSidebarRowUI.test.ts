// MoMo's sidebar row and its dot (src/components/momo/MomoSidebarRow.tsx, momoColors.ts, #2607): nothing for an account MoMo isn't allowed for; for an invited one the row says the name the user gave MoMo, with its donut in the color they picked, and opens MoMo; the five colors are the five prefs hold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h } from 'react';
import { render, click } from './support/shell-chrome-kit.ts';
import { mockSource, stubStore } from './support/stubs.ts';

let allowed = true;
let prefs: any = { persona: { name: 'Pip', color: 'blue' } };
let route: any = { name: 'home' };
const navigated: any[] = [];
stubStore({ useStore: (sel: any) => sel({ route }), navigate: (r: any) => navigated.push(r) });
mockSource('src/lib/momo.ts', { useMomoAllowed: () => allowed });
mockSource('src/session/momoPrefs.ts', { useMomoPrefs: () => prefs });
const { MomoSidebarRow, MomoDot } = await import('../src/components/momo/MomoSidebarRow.tsx');
const { MOMO_COLOR_OPTIONS, momoColorCss } = await import('../src/components/momo/momoColors.ts');
const { MOMO_COLORS } = await import('../shared/momoPrefs.mjs');

test('the row names MoMo as the user did, with its dot in their color, and opens MoMo; selected while MoMo is open', async () => {
  const { host, unmount } = await render(h(MomoSidebarRow));
  const row = host.querySelector('button')!;
  assert.equal(row.querySelector('.side-row-label')!.textContent, 'Pip');
  assert.equal(row.querySelector<HTMLElement>('.momo-dot')!.style.borderColor, 'var(--momo-blue)');
  assert.equal(row.getAttribute('aria-current'), null);
  await click(row);
  assert.deepEqual(navigated, [{ name: 'momo' }]);
  await unmount();
  // open already: marked, and a click goes nowhere
  route = { name: 'momo' };
  navigated.length = 0;
  const here = await render(h(MomoSidebarRow));
  assert.equal(here.host.querySelector('button')!.getAttribute('aria-current'), 'page');
  await click(here.host.querySelector('button'));
  assert.deepEqual(navigated, []);
  await here.unmount();
  route = { name: 'home' };
});

test('an account MoMo is off for has no row', async () => {
  allowed = false;
  const { host, unmount } = await render(h(MomoSidebarRow));
  assert.equal(host.innerHTML, '');
  await unmount();
  allowed = true;
});

test('the dot is drawn in the saved color, or the one setup is trying; its size sets its ring', async () => {
  const saved = await render(h(MomoDot, { size: 20 }));
  const dot = saved.host.querySelector<HTMLElement>('.momo-dot')!;
  assert.equal(dot.style.borderColor, 'var(--momo-blue)');
  assert.equal(dot.style.width, '20px');
  assert.equal(dot.style.borderWidth, '6px');
  await saved.unmount();
  const trying = await render(h(MomoDot, { color: 'violet' }));
  assert.equal(trying.host.querySelector<HTMLElement>('.momo-dot')!.style.borderColor, 'var(--purple)');
  await trying.unmount();
});

test('the colors setup offers are the ones prefs hold, each with its own look', () => {
  assert.deepEqual(
    MOMO_COLOR_OPTIONS.map((c) => c.id),
    [...MOMO_COLORS],
  );
  assert.equal(new Set(MOMO_COLOR_OPTIONS.map((c) => c.css)).size, MOMO_COLORS.length);
  for (const c of MOMO_COLOR_OPTIONS) assert.equal(momoColorCss(c.id), c.css);
});
