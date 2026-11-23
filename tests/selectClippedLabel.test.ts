// A Settings select with a long label (src/components/pages/settings/Controls.tsx Select, a folder outside home) keeps its
// width and ellipsizes the label, which reads whole on hover; menu items cut short by the menu's width do the same
// (src/lib/clippedTitle.ts, src/components/ui/MenuList.tsx MenuRow under every MenuItem).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import postcss from 'postcss';
import { appCss } from './support/app-css.ts';
import { cssRules } from './support/css-rules.ts';
import { $, $$, click, fire, mount, mouse } from './support/composer-kit.ts';

const { createElement: h } = await import('react');
const { Select, Row } = await import('../src/components/pages/settings/Controls.tsx');
const { MenuItem, Menu } = await import('../src/components/ui/Popover.tsx');
const { titleIfClipped } = await import('../src/lib/clippedTitle.ts');

const LONG = '2.1.302 · Installed manually · /private/tmp/very/long/folder/outside/home/bin/claude';
const css = postcss.parse(appCss());
const { decls } = cssRules(css);

/** Gives `el` a box `client` wide holding content `scroll` wide (happy-dom has no layout). */
function setOverflow(el: Element, scroll: number, client: number) {
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: scroll });
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: client });
}

let unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const u of unmounts) await u();
  unmounts = [];
  document.body.innerHTML = '';
});
async function show(el: any) {
  const m: any = await mount(el);
  if (m?.unmount) unmounts.push(m.unmount);
  return m;
}

test('the select button is capped and only its label shrinks, ellipsized on one line', () => {
  assert.equal(decls('.select-btn')['max-width'], '280px');
  // icons and the chevron keep their size
  assert.equal(decls('.select-btn > *').flex, 'none');
  const label = decls('.select-btn > .select-label');
  assert.equal(label.flex, '0 1 auto');
  assert.equal(label['min-width'], '0');
  assert.equal(label.overflow, 'hidden');
  assert.equal(label['text-overflow'], 'ellipsis');
  assert.equal(label['white-space'], 'nowrap');
  // the row keeps its text column shrinkable beside the control
  assert.equal(decls('.settings-row-text')['min-width'], '0');
});

test('titleIfClipped titles the host with the full text only while it overflows', () => {
  const host = document.createElement('button');
  host.innerHTML = '<span class="lbl">a long label</span>';
  const lbl = host.querySelector('.lbl')!;
  setOverflow(lbl, 300, 120);
  titleIfClipped(host, '.lbl');
  assert.equal(host.title, 'a long label');
  // it fits again (a wider window): the stale tooltip goes
  setOverflow(lbl, 120, 120);
  titleIfClipped(host, '.lbl');
  assert.equal(host.hasAttribute('title'), false);
  // nothing to measure: no tooltip
  host.title = 'stale';
  titleIfClipped(host, '.missing');
  assert.equal(host.hasAttribute('title'), false);
});

test('a Select in a Row shows the long label ellipsized and titles it on hover and focus', async () => {
  const picked: string[] = [];
  await show(
    h(
      Row,
      { title: 'Version', desc: 'Which CLI chats run' },
      h(Select, {
        value: 'b',
        options: [
          { value: 'a', label: 'Native installer' },
          { value: 'b', label: LONG },
        ],
        onChange: (v: string) => picked.push(v),
      }),
    ),
  );
  const btn = $('.settings-row-control .select-btn');
  const label = $('.select-label', btn);
  assert.equal(label.textContent, LONG);
  setOverflow(label, 600, 240);
  await mouse(btn, 'pointerover');
  assert.equal(btn.title, LONG);
  setOverflow(label, 240, 240);
  await fire(btn, new (window as any).FocusEvent('focusin', { bubbles: true }));
  assert.equal(btn.hasAttribute('title'), false, 'a label that fits gets no tooltip');
  // the menu still lists every option and picks one
  await click(btn);
  const items = $$('.menu-item');
  assert.deepEqual(
    items.map((i) => $('.menu-title', i).textContent),
    ['Native installer', LONG],
  );
  await click(items[0]);
  assert.deepEqual(picked, ['a']);
});

test('a menu item without a title of its own titles its cut-off text; one with a title keeps it', async () => {
  const anchor = document.createElement('button');
  document.body.append(anchor);
  await show(
    h(Menu, {
      anchor,
      open: true,
      onClose: () => {},
      children: [
        h(MenuItem, { key: 'plain', onSelect: () => {}, children: LONG }),
        h(MenuItem, { key: 'titled', onSelect: () => {}, title: '/usr/local/bin/claude', children: 'Homebrew' }),
      ],
    }),
  );
  const [plain, titled] = $$('.menu-item');
  setOverflow($('.menu-title', plain), 500, 160);
  await mouse(plain, 'pointerover');
  assert.equal(plain.title, LONG);
  setOverflow($('.menu-title', titled), 500, 160);
  await mouse(titled, 'pointerover');
  assert.equal(titled.title, '/usr/local/bin/claude');
});

test("every menu row (MenuRow) titles its cut-off text and still runs the caller's own pointer handler", async () => {
  const { MenuRow } = await import('../src/components/ui/MenuList.tsx');
  const entered: string[] = [];
  await show(
    h(MenuRow, {
      onPointerEnter: () => entered.push('row'),
      children: h('span', { className: 'menu-title' }, 'feature/a-very-long-branch-name-that-the-menu-cuts'),
    }),
  );
  const row = $('.menu-item');
  setOverflow($('.menu-title', row), 400, 160);
  await mouse(row, 'pointerover');
  assert.equal(row.title, 'feature/a-very-long-branch-name-that-the-menu-cuts');
  assert.deepEqual(entered, ['row']);
});
