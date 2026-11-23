// Menu-local shortcuts share the displayed hint, ignore text/modifier/IME input and stop when the menu closes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h } from 'react';
import { $, key, mount } from './support/composer-kit.ts';
import { MenuLetters } from '../src/components/ui/MenuLetters.tsx';

test('only unmodified letters in the owning menu activate enabled hinted items', async () => {
  let picked = 0;
  const row = (letter: string, disabled = false) =>
    h('button', { 'aria-disabled': disabled, onClick: () => picked++ }, h('span', { className: 'menu-shortcut' }, letter));
  const view = await mount(
    h(
      'div',
      { 'data-menu-keyboard': '', tabIndex: -1 },
      h(
        MenuLetters,
        null,
        row('P'),
        row('D', true),
        h('input'),
        h('textarea'),
        h('div', { contentEditable: true }),
        h('div', { 'data-menu-keyboard': '', 'data-child': true, tabIndex: -1 }),
      ),
    ),
  );
  const menu = $('[data-menu-keyboard]');
  menu.focus();
  for (const init of [{ repeat: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }, { keyCode: 229 }])
    await key(menu, 'p', init);
  for (const field of [$('input'), $('textarea'), $('[contenteditable]'), $('[data-child]')]) await key(field, 'p');
  await key(document, 'p');
  await key(menu, 'd');
  await key(menu, 'x');
  assert.equal(picked, 0);
  const blocked = (event: Event) => event.preventDefault();
  document.addEventListener('keydown', blocked, true);
  await key(menu, 'p');
  document.removeEventListener('keydown', blocked, true);
  assert.equal(picked, 0);
  await key(menu, 'p');
  await key(menu, 'P', { shiftKey: true });
  assert.equal(picked, 2);
  await view.render(h('div', null, h(MenuLetters, null, row('P'))));
  await key($('button'), 'p');
  assert.equal(picked, 2, 'a wrapper outside a menu never owns keys');
  await view.unmount();
  await key(document.body, 'p');
  assert.equal(picked, 2);
});
