// Menus and listboxes (src/components/ui/MenuList.tsx): the list or its search field keeps focus and names the active
// row with aria-activedescendant; arrows, Home/End, Enter/Space, ArrowRight/ArrowLeft; focus given back on close.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, $$, fire, key, mount, mouse } from './support/composer-kit.ts';

const { createElement: h, act, useRef } = await import('react');
const UI = await import('../src/components/ui/MenuList.tsx');
const { useListbox, useFocusWhileOpen } = UI;
// created with plain props, children passed positionally
const MenuList = UI.MenuList as any;
const MenuRow = UI.MenuRow as any;

// frames run when the test says so, as a popover is placed (and can take focus) only after its first measure
let frames: (() => void)[] = [];
const g = globalThis as any;
const realRaf = g.requestAnimationFrame;
const realCaf = g.cancelAnimationFrame;
const cancelled: number[] = [];
beforeEach(() => {
  frames = [];
  cancelled.length = 0;
  g.requestAnimationFrame = (cb: () => void) => frames.push(cb);
  g.cancelAnimationFrame = (id: number) => cancelled.push(id);
});
afterEach(() => {
  g.requestAnimationFrame = realRaf;
  g.cancelAnimationFrame = realCaf;
  (document.activeElement as HTMLElement | null)?.blur?.();
});
const runFrames = () =>
  act(async () => {
    const now = frames.splice(0);
    for (const f of now) f();
  });
const active = () => $$('[role^=menuitem], [role=option]').findIndex((r) => r.classList.contains('kbd-active'));

function trigger() {
  const b = document.createElement('button');
  b.id = 'trigger';
  document.body.append(b);
  b.focus();
  return b;
}

test('a menu list takes focus once it can, and gives it back to its button when it closes', async (t) => {
  const button = trigger();
  t.after(() => button.remove());
  const menu = (open: boolean) => (open ? h(MenuList, { label: 'Actions' }, h(MenuRow, null, 'One')) : null);
  const m = await mount(menu(true));
  const list = $('[role=menu]');
  assert.equal(list.getAttribute('aria-label'), 'Actions');
  assert.equal(list.tabIndex, -1);
  assert.equal(document.activeElement, button, 'not before it is placed');
  await runFrames();
  assert.equal(document.activeElement, list);
  await m.render(menu(false));
  assert.equal(document.activeElement, button);
  await m.unmount();
});

test('focus that cannot land yet is tried again on later frames, up to ten', async (t) => {
  const button = trigger();
  t.after(() => button.remove());
  const m = await mount(h(MenuList, null, h(MenuRow, null, 'One')));
  const list = $('[role=menu]');
  const focusNow = list.focus.bind(list);
  let attempts = 0;
  list.focus = () => {
    attempts++;
  };
  await runFrames();
  assert.equal(attempts, 1);
  assert.equal(frames.length, 1, 'tried again next frame');
  list.focus = focusNow;
  await runFrames();
  assert.equal(document.activeElement, list);
  assert.equal(frames.length, 0);
  await m.unmount();
  // a list that never takes focus stops trying
  const again = await mount(h(MenuList, null, h(MenuRow, null, 'One')));
  $('[role=menu]').focus = () => {
    attempts++;
  };
  attempts = 0;
  for (let i = 0; i < 12; i++) await runFrames();
  assert.equal(attempts, 10);
  await again.unmount();
});

test('focus moved on purpose while the menu was open stays where it went; a page without focus gets none back', async (t) => {
  const button = trigger();
  const field = document.createElement('input');
  document.body.append(field);
  t.after(() => {
    button.remove();
    field.remove();
  });
  const m = await mount(h(MenuList, null, h(MenuRow, null, 'One')));
  await runFrames();
  field.focus();
  await m.render(null);
  assert.equal(document.activeElement, field);
  // nothing had focus when it opened: closing leaves it to the page
  field.blur();
  await m.render(h(MenuList, null, h(MenuRow, null, 'One')));
  await runFrames();
  await m.render(null);
  assert.equal(document.activeElement, document.body);
  // closed before its first frame: the frame finds nothing to focus
  button.focus();
  await m.render(h(MenuList, null, h(MenuRow, null, 'One')));
  const stale = frames.splice(0);
  await m.render(null);
  for (const f of stale) f();
  assert.equal(document.activeElement, button);
  await m.unmount();
});

test('a button that went away while its menu was open gets nothing back; a row takes an object ref too', async () => {
  const button = trigger();
  const rowRef = { current: null as HTMLButtonElement | null };
  const m = await mount(h(MenuList, null, h(MenuRow, { ref: rowRef }, 'One')));
  assert.equal(rowRef.current, $('[role=menuitem]'));
  await runFrames();
  button.remove();
  await m.render(null);
  assert.equal(document.activeElement, document.body);
  assert.equal(rowRef.current, null);
  await m.unmount();
});

test('a list that stops wanting focus while shown (the pointer took over its submenu) gives it back', async (t) => {
  const button = trigger();
  t.after(() => button.remove());
  const m = await mount(h(MenuList, { autoFocus: true }, h(MenuRow, null, 'One')));
  await runFrames();
  assert.equal(document.activeElement, $('[role=menu]'));
  await m.render(h(MenuList, { autoFocus: false }, h(MenuRow, null, 'One')));
  assert.equal(document.activeElement, button);
  await m.unmount();
});

test('a list that already holds focus (its own field) keeps it; one shown without focus takes none', async () => {
  const m = await mount(h(MenuList, null, h('input', { id: 'own', autoFocus: true }), h(MenuRow, null, 'One')));
  assert.equal(document.activeElement, $('#own'));
  await runFrames();
  assert.equal(document.activeElement, $('#own'));
  await m.render(h(MenuList, { autoFocus: false }, h(MenuRow, null, 'One')));
  await runFrames();
  assert.notEqual(document.activeElement, $('[role=menu]'));
  assert.equal(frames.length, 0);
  await m.unmount();
});

test('arrows move over enabled rows and wrap, Home/End jump, Enter and Space pick; the list names its active row', async () => {
  const picked: string[] = [];
  const m = await mount(
    h(
      MenuList,
      null,
      h(MenuRow, { onClick: () => picked.push('a') }, 'A'),
      h(MenuRow, { disabled: true, onClick: () => picked.push('b') }, 'B'),
      h(MenuRow, { role: 'menuitemcheckbox', 'aria-checked': true, onClick: () => picked.push('c') }, 'C'),
    ),
  );
  await runFrames();
  const list = $('[role=menu]');
  const rows = $$('[role^=menuitem]');
  await key(list, 'Enter');
  assert.deepEqual(picked, [], 'no active row: nothing to pick');
  await key(list, 'ArrowDown');
  assert.equal(active(), 0);
  assert.equal(list.getAttribute('aria-activedescendant'), rows[0].id);
  await key(list, 'ArrowDown');
  assert.equal(active(), 2, 'the disabled row is skipped');
  await key(list, 'ArrowDown');
  assert.equal(active(), 0, 'wraps');
  await key(list, 'End');
  assert.equal(active(), 2);
  await key(list, 'Home');
  assert.equal(active(), 0);
  await key(list, ' ');
  await key(list, 'Enter');
  await key(list, 'Enter', { isComposing: true });
  await key(list, 'Enter', { repeat: true });
  await key(list, 'x');
  assert.deepEqual(picked, ['a', 'a']);
  // a key someone else handled is theirs
  const handled = new (window as any).KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
  handled.preventDefault();
  await fire(list, handled);
  assert.equal(active(), 0);
  await act(async () => rows[1].click());
  assert.deepEqual(picked, ['a', 'a'], 'a disabled row does nothing');
  assert.equal(rows[1].getAttribute('aria-disabled'), 'true');
  // a row sliding under a still pointer (mouseover, no move) keeps the keyboard's highlight; the pointer moving takes over
  await mouse(rows[2], 'mouseover');
  assert.notEqual(active(), -1);
  await mouse(rows[2], 'mousemove');
  assert.equal(active(), -1);
  assert.equal(list.hasAttribute('aria-activedescendant'), false);
  await m.unmount();
});

test('Space types in a field inside the list, and ArrowRight/ArrowLeft open and leave a submenu', async () => {
  const opened: number[] = [];
  let backs = 0;
  const picked: string[] = [];
  const m = await mount(
    h(
      MenuList,
      { onBack: () => backs++ },
      h('input', { id: 'field' }),
      h(MenuRow, { onClick: () => picked.push('plain') }, 'Plain'),
      h(MenuRow, { 'aria-haspopup': 'menu', onClick: (e: any) => opened.push(e.detail) }, 'More'),
    ),
  );
  await runFrames();
  const list = $('[role=menu]');
  await key(list, 'ArrowDown');
  await key($('#field'), ' ');
  assert.deepEqual(picked, [], 'Space in a field is typing');
  await key(list, 'ArrowRight');
  assert.deepEqual(opened, [], 'a row without a submenu does not open');
  await key(list, 'ArrowDown');
  await key(list, 'ArrowRight');
  assert.deepEqual(opened, [0], "the keyboard's click (detail 0)");
  await key(list, 'ArrowLeft');
  assert.equal(backs, 1);
  await m.render(h(MenuList, null, h(MenuRow, null, 'Only')));
  await key($('[role=menu]'), 'ArrowLeft');
  assert.equal(backs, 1, 'no menu to go back to');
  await m.render(h(MenuList, null, h('span', null, 'no rows')));
  await key($('[role=menu]'), 'ArrowDown');
  assert.equal($$('.kbd-active').length, 0);
  await m.unmount();
});

test('keys on anything focused outside every menu (a link beside the list, another text field) are its own', async (t) => {
  const picked: string[] = [];
  const link = document.createElement('a');
  link.href = 'https://example.test/';
  const field = document.createElement('input');
  document.body.append(link, field);
  t.after(() => {
    link.remove();
    field.remove();
  });
  const m = await mount(h(MenuList, { autoFocus: false }, h(MenuRow, { onClick: () => picked.push('row') }, 'Row')));
  await key(document, 'ArrowDown');
  assert.equal(active(), 0);
  link.focus();
  await key(link, 'Enter');
  await key(link, ' ');
  await key(link, 'End');
  assert.deepEqual(picked, [], "the link's Enter opens the link, not the menu's row");
  field.focus();
  await key(field, 'ArrowUp');
  await key(field, 'Enter');
  assert.deepEqual(picked, [], "the field's Enter is the field's");
  assert.equal(active(), 0);
  // focus back on the page: the menu has the keys again
  field.blur();
  await key(document, 'Enter');
  assert.deepEqual(picked, ['row']);
  await m.unmount();
});

test('keys go to the list holding focus, else to the newest list', async () => {
  const m = await mount(
    h(
      'div',
      null,
      h(MenuList, { autoFocus: false }, h(MenuRow, null, 'First list')),
      h(MenuList, { autoFocus: false }, h(MenuRow, null, 'Second list')),
    ),
  );
  const [first, second] = $$('[role=menu]');
  await key(document, 'ArrowDown');
  assert.equal($('.kbd-active')!.textContent, 'Second list', 'no list has focus: the newest');
  first.focus();
  await key(first, 'ArrowDown');
  assert.equal($('.kbd-active', first)!.textContent, 'First list');
  assert.equal($$('.kbd-active', second).length, 1, 'the other list is left alone');
  await m.unmount();
});

test('rows are buttons that keep focus where it is; a bare row has only its own look', async () => {
  const m = await mount(h(MenuList, null, h(MenuRow, { className: 'x' }, 'Row'), h(MenuRow, { bare: true, className: 'mini' }, 'Bare')));
  const [row, bare] = $$('button');
  assert.equal((row as HTMLButtonElement).type, 'button');
  assert.equal(row.tabIndex, -1);
  assert.equal(row.className, 'menu-item x');
  assert.equal(bare.className, 'mini');
  assert.equal(row.getAttribute('role'), 'menuitem');
  const down = new (window as any).MouseEvent('mousedown', { bubbles: true, cancelable: true });
  await fire(row, down);
  assert.equal(down.defaultPrevented, true);
  await m.unmount();
  // outside a list, hovering a row has no highlight to clear
  const loose = await mount(h(MenuRow, null, 'Loose'));
  await mouse($('button'), 'mousemove');
  await loose.unmount();
});

function Box({ items, onPick }: { items: string[]; onPick: (s: string) => void }) {
  const box = useListbox(items.length, (i) => onPick(items[i]));
  return h(
    'div',
    null,
    h('input', { id: 'q', ...box.field }),
    h(
      'div',
      { id: box.listId, role: 'listbox' },
      items.map((it, i) => h(MenuRow, { key: it, ...box.option(i), className: i === box.index ? 'kbd-active' : '' }, it)),
    ),
    h('button', { id: 'jump', onClick: () => box.setIndex(5) }, 'jump'),
  );
}

test('a list filtered by its search field: arrows stop at the ends, Enter picks, an input method keeps its Enter', async () => {
  const picked: string[] = [];
  const m = await mount(h(Box as any, { items: ['a', 'b', 'c'], onPick: (s: string) => picked.push(s) }));
  const q = $('#q');
  const options = $$('[role=option]');
  assert.equal(q.getAttribute('role'), 'combobox');
  assert.equal(q.getAttribute('aria-controls'), $('[role=listbox]').id);
  assert.equal(q.getAttribute('aria-activedescendant'), options[0].id);
  assert.equal(options[0].getAttribute('aria-selected'), 'true');
  await key(q, 'ArrowUp');
  assert.equal(active(), 0);
  await key(q, 'ArrowDown');
  await key(q, 'ArrowDown');
  await key(q, 'ArrowDown');
  assert.equal(active(), 2);
  assert.equal(q.getAttribute('aria-activedescendant'), options[2].id);
  await key(q, 'Enter', { isComposing: true });
  await key(q, ' ');
  assert.equal(picked.length, 0);
  await key(q, 'Enter');
  assert.deepEqual(picked, ['c']);
  await mouse(options[1], 'mousemove');
  assert.equal(active(), 1);
  // an index past the list (it just got shorter) shows the last option active, and Enter picks that one
  await act(async () => $('#jump').click());
  assert.equal(q.getAttribute('aria-activedescendant'), options[2].id);
  assert.equal(active(), 2);
  await key(q, 'Enter');
  assert.deepEqual(picked, ['c', 'c']);
  await key(q, 'ArrowUp');
  assert.equal(active(), 1, 'and the arrows move from there');
  await m.render(h(Box as any, { items: [], onPick: (s: string) => picked.push(s) }));
  await key(q, 'Enter');
  await key(q, 'ArrowDown');
  assert.deepEqual(picked, ['c', 'c'], 'nothing listed: keys do nothing');
  await m.unmount();
});

function Panel({ open }: { open: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusWhileOpen(ref, open);
  return open ? h('div', { ref, tabIndex: -1, id: 'panel' }, 'panel') : null;
}

test('useFocusWhileOpen: a panel that is not a menu takes focus while shown, too', async (t) => {
  const button = trigger();
  t.after(() => button.remove());
  const m = await mount(h(Panel, { open: true }));
  await runFrames();
  assert.equal(document.activeElement, $('#panel'));
  await m.render(h(Panel, { open: false }));
  assert.equal(document.activeElement, button);
  await m.unmount();
});
