// Floating layers (src/components/ui/Popover.tsx): popover placement and dismissal, menu keyboard
// navigation, submenus, and tooltips.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, $$, click, flush, key, mount, mouse, setRect } from './support/composer-kit.ts';

const { createElement: h, useState } = await import('react');
const { act } = await import('react');
const { Popover, Menu, MenuItem, SubMenu, MenuSeparator, MenuLabel, Tooltip, useAnchor, useCloseTooltip } = await import(
  '../src/components/ui/Popover.tsx'
);

// happy-dom has no layout: give layers a size and the window a viewport
const proto = (window as any).HTMLElement.prototype;
let layer = { w: 100, h: 50 };
Object.defineProperty(proto, 'offsetWidth', {
  configurable: true,
  get() {
    return layer.w;
  },
});
Object.defineProperty(proto, 'offsetHeight', {
  configurable: true,
  get() {
    return layer.h;
  },
});
Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
let frames: (() => void)[] = [];
const g = globalThis as any;
const realRaf = g.requestAnimationFrame;
const realCaf = g.cancelAnimationFrame;
const cancelled: number[] = [];

beforeEach(() => {
  layer = { w: 100, h: 50 };
  frames = [];
  cancelled.length = 0;
  g.requestAnimationFrame = (cb: () => void) => frames.push(cb);
  g.cancelAnimationFrame = (id: number) => cancelled.push(id);
});
const anchors: HTMLElement[] = [];
afterEach(() => {
  g.requestAnimationFrame = realRaf;
  g.cancelAnimationFrame = realCaf;
  anchors.splice(0).forEach((a) => a.remove());
});

function anchorAt(r: { left: number; top: number; width: number; height: number }) {
  const a = document.createElement('button');
  document.body.append(a);
  anchors.push(a);
  setRect(a, r);
  return a;
}
const pos = () => {
  const el = $('.popover-layer');
  return { left: parseFloat(el.style.left), top: parseFloat(el.style.top), visibility: el.style.visibility, width: el.style.width };
};
const pop = (props: any) => h(Popover, { open: true, onClose: () => {}, ...props }, h('span', null, 'content'));

test('closed popovers render nothing; one without an anchor stays hidden off-screen', async () => {
  const m = await mount(pop({ open: false, anchor: null }));
  assert.ok(!$('.popover-layer'));
  await m.render(pop({ anchor: null, className: 'x' }));
  assert.deepEqual(pos(), { left: -9999, top: -9999, visibility: 'hidden', width: '' });
  assert.equal($('.popover-layer').className, 'popover-layer x');
  await m.unmount();
});

test('each placement lines the layer up with its anchor', async () => {
  const a = anchorAt({ left: 300, top: 400, width: 80, height: 20 });
  const expect: Record<string, [number, number]> = {
    'bottom-start': [300, 426],
    'bottom-end': [280, 426],
    bottom: [290, 426],
    'top-start': [300, 344],
    'top-end': [280, 344],
    top: [290, 344],
    'right-start': [386, 395],
    'right-end': [386, 375],
  };
  const m = await mount(pop({ anchor: a }));
  assert.deepEqual([pos().left, pos().top, pos().visibility], [300, 426, 'visible']);
  for (const [placement, [left, top]] of Object.entries(expect)) {
    await m.render(pop({ anchor: a, placement }));
    assert.deepEqual([pos().left, pos().top], [left, top], placement);
  }
  await m.unmount();
});

test('layers are kept inside the viewport', async () => {
  // below the bottom edge: a bottom placement flips above the anchor; others are pinned to the edge
  const low = anchorAt({ left: 300, top: 770, width: 80, height: 20 });
  const m = await mount(pop({ anchor: low }));
  assert.equal(pos().top, 770 - 50 - 6);
  await m.render(pop({ anchor: low, placement: 'right-end', offset: 0 }));
  assert.equal(pos().top, 800 - 50 - 8);
  layer = { w: 100, h: 900 };
  await m.render(pop({ anchor: low, placement: 'right-start' }));
  assert.equal(pos().top, 8);
  layer = { w: 100, h: 50 };
  // above the top edge: a top placement opens below its anchor, not clamped over it (tests/popoverPlacement.test.ts)
  const high = anchorAt({ left: 300, top: 2, width: 80, height: 20 });
  await m.render(pop({ anchor: high, placement: 'top-start' }));
  assert.equal(pos().top, 2 + 20 + 6);
  // off the right edge: right-start flips to the left of the anchor; others are pinned
  const right = anchorAt({ left: 950, top: 300, width: 40, height: 20 });
  await m.render(pop({ anchor: right, placement: 'right-start' }));
  assert.equal(pos().left, 950 - 100 - 6);
  await m.render(pop({ anchor: right, placement: 'bottom-start' }));
  assert.equal(pos().left, 1000 - 100 - 8);
  // off the left edge
  const left = anchorAt({ left: 2, top: 300, width: 10, height: 20 });
  await m.render(pop({ anchor: left, placement: 'bottom' }));
  assert.equal(pos().left, 8);
  await m.unmount();
});

test('a point anchor places at the point; matchWidth takes the anchor element width', async () => {
  const m = await mount(pop({ anchor: { x: 200, y: 100 }, matchWidth: true }));
  assert.deepEqual([pos().left, pos().top, pos().width], [200, 106, '']);
  const a = anchorAt({ left: 100, top: 100, width: 240, height: 20 });
  await m.render(pop({ anchor: a, matchWidth: true }));
  assert.equal(pos().width, '240px');
  await m.unmount();
});

test('an anchor that is not placed yet is measured again on later frames, up to ten times', async () => {
  const a = anchorAt({ left: 0, top: 0, width: 0, height: 0 });
  const m = await mount(pop({ anchor: a }));
  assert.equal(pos().visibility, 'hidden');
  assert.equal(frames.length, 1);
  // still off-screen to the top, then to the left
  setRect(a, { left: 100, top: -3000, width: 10, height: 10 });
  await act(async () => frames.shift()!());
  assert.equal(frames.length, 1);
  setRect(a, { left: -3000, top: 100, width: 10, height: 10 });
  await act(async () => frames.shift()!());
  // a zero-width box with a height is real
  setRect(a, { left: 100, top: 100, width: 0, height: 10 });
  await act(async () => frames.shift()!());
  assert.equal(frames.length, 0);
  assert.equal(pos().visibility, 'visible');
  // a box that never arrives is given up on after ten frames
  setRect(a, { left: 0, top: 0, width: 0, height: 0 });
  await m.render(pop({ anchor: a, placement: 'top' }));
  for (let i = 0; i < 10; i++) await act(async () => frames.shift()!());
  assert.equal(frames.length, 0);
  assert.equal(pos().visibility, 'hidden');
  // closing cancels a pending frame and stops following resizes
  await m.render(pop({ anchor: a, placement: 'bottom' }));
  await m.render(pop({ anchor: a, open: false }));
  assert.ok(cancelled.length > 0);
  await m.unmount();
});

test('window resizes place the layer again', async () => {
  const a = anchorAt({ left: 300, top: 300, width: 80, height: 20 });
  const m = await mount(pop({ anchor: a }));
  setRect(a, { left: 400, top: 300, width: 80, height: 20 });
  await act(async () => void window.dispatchEvent(new (window as any).Event('resize')));
  assert.equal(pos().left, 400);
  await m.unmount();
});

test('outside presses and Escape close; presses inside, on the anchor or in another layer do not', async () => {
  const closed: string[] = [];
  const a = anchorAt({ left: 300, top: 300, width: 80, height: 20 });
  const other = document.createElement('div');
  other.className = 'tooltip interactive';
  const inner = document.createElement('i');
  other.append(inner);
  document.body.append(other);
  anchors.push(other);
  const m = await mount(h(Popover, { anchor: a, open: true, onClose: () => closed.push('close') } as any, h('span', { id: 'in' }, 'x')));
  await mouse($('#in'), 'mousedown');
  await mouse(a, 'mousedown');
  await mouse(inner, 'mousedown');
  assert.deepEqual(closed, [] as string[]);
  await mouse(document.body, 'mousedown');
  await fire(document, 'mousedown');
  await key(document.body, 'a');
  await key(document.body, 'Escape');
  assert.deepEqual(closed, ['close', 'close', 'close']);
  // a point anchor contains nothing
  await m.render(h(Popover, { anchor: { x: 1, y: 1 }, open: true, onClose: () => closed.push('point') } as any, 'x'));
  await mouse(a, 'mousedown');
  assert.equal(closed.at(-1), 'point');
  await m.unmount();
});
async function fire(target: any, type: string) {
  await act(async () => void target.dispatchEvent(new (window as any).MouseEvent(type, { bubbles: true })));
}

function MenuHarness({ onPick, children }: any) {
  const a = useAnchor();
  return h(
    'div',
    null,
    h('button', { id: 'open', ref: a.ref, onClick: a.toggle }, 'open'),
    h('button', { id: 'close', onClick: a.close }, 'close'),
    h('span', { id: 'state' }, String(a.open)),
    h(
      Menu,
      { anchor: a.anchor, open: a.open, onClose: a.close, width: 200, className: 'm' } as any,
      children ?? [
        h(
          MenuItem,
          {
            key: 1,
            onSelect: () => onPick('one'),
            icon: 'I',
            shortcut: '⌘K',
            checked: true,
            hint: 'hint',
            right: h('em', null, 'R'),
          } as any,
          'One',
        ),
        h(MenuItem, { key: 2, onSelect: () => onPick('two'), disabled: true, checked: false, danger: true } as any, 'Two'),
        h(MenuItem, { key: 3, onSelect: () => onPick('three'), description: 'desc', keepOpen: true } as any, 'Three'),
        h(MenuSeparator, { key: 4 }),
        h(MenuLabel, { key: 5, right: h('b', null, 'r') } as any, 'Label'),
        h(MenuItem, { key: 6 } as any, 'Plain'),
      ],
    ),
  );
}

test('menus: items render their parts, disabled ones do nothing, keepOpen keeps the menu open', async () => {
  const picked: string[] = [];
  const m = await mount(h(MenuHarness, { onPick: (x: string) => picked.push(x) }));
  await click($('#open'));
  const items = $$('.menu-item');
  assert.deepEqual(
    items.map((item) => item.getAttribute('role')),
    ['menuitemcheckbox', 'menuitemcheckbox', 'menuitem', 'menuitem'],
  );
  assert.deepEqual(
    items.slice(0, 2).map((item) => item.getAttribute('aria-checked')),
    ['true', 'false'],
  );
  assert.equal(items[0].getAttribute('aria-disabled'), null, 'enabled menu items omit aria-disabled');
  assert.equal(items[1].getAttribute('aria-disabled'), 'true');
  assert.equal($('.menu').className, 'menu m');
  assert.equal($('.menu').style.width, '200px');
  assert.equal(items[0].querySelector('.menu-icon')!.textContent, 'I');
  assert.equal(items[0].querySelector('.menu-shortcut')!.textContent, '⌘K');
  assert.equal(items[0].querySelector('.menu-hint')!.textContent, 'hint');
  assert.ok(items[0].querySelector('.menu-check svg'));
  assert.equal(items[1].querySelector('.menu-check')!.innerHTML, '');
  assert.match(items[1].className, /danger/);
  assert.match(items[2].className, /has-desc/);
  assert.equal(items[2].querySelector('.menu-desc')!.textContent, 'desc');
  assert.ok(!items[3].querySelector('.menu-icon'));
  assert.equal($('.menu-section-label').textContent, 'Labelr');
  assert.equal($('.menu-sep').getAttribute('role'), 'separator');
  await click(items[1]);
  assert.deepEqual(picked, []);
  await click(items[2]);
  assert.deepEqual(picked, ['three']);
  assert.equal($('#state').textContent, 'true');
  await click(items[3]);
  assert.equal($('#state').textContent, 'false');
  await click($('#open'));
  await click($('.menu-item'));
  assert.deepEqual(picked, ['three', 'one']);
  assert.equal($('#state').textContent, 'false');
  await m.unmount();
});

test('menus: arrows move the highlight over enabled items, Enter picks it, hovering clears it', async (t) => {
  const picked: string[] = [];
  const m = await mount(h(MenuHarness, { onPick: (x: string) => picked.push(x) }));
  t.after(() => m.unmount());
  await click($('#open'));
  const active = () => $$('.menu-item').findIndex((i) => i.classList.contains('kbd-active'));
  await key(document, 'Enter');
  assert.deepEqual(picked, []);
  await key(document, 'ArrowDown');
  assert.equal(active(), 0);
  await key(document, 'ArrowDown');
  assert.equal(active(), 2, 'the disabled item is skipped');
  await key(document, 'ArrowDown');
  await key(document, 'ArrowDown');
  assert.equal(active(), 0, 'wraps around');
  await key(document, 'ArrowUp');
  assert.equal(active(), 3);
  await key(document, 'x');
  assert.equal(active(), 3);
  await mouse($$('.menu-item')[0], 'mousemove');
  assert.equal(active(), -1);
  await key(document, 'ArrowUp');
  assert.equal(active(), 3, 'the first ArrowUp selects the last enabled item');
  await key(document, 'ArrowUp');
  assert.equal(active(), 2);
  await key(document, 'Enter');
  assert.deepEqual(picked, ['three']);
  await click($('#close'));
  await m.unmount();
});

test('menus without enabled items ignore keys', async () => {
  const m = await mount(h(MenuHarness, { children: [h(MenuItem, { key: 1, disabled: true } as any, 'Only')] }));
  await click($('#open'));
  await key(document, 'ArrowDown');
  assert.equal($$('.kbd-active').length, 0);
  await m.unmount();
});

test('submenus open on hover or click, close after leaving, and their items close the whole menu', async () => {
  const picked: string[] = [];
  const m = await mount(
    h(MenuHarness, {
      children: [
        h(
          SubMenu,
          {
            key: 1,
            label: 'More',
            icon: 'I',
            hint: 'h',
            shortcut: '⇧⌘P',
            right: h('em', null, 'R'),
            width: 150,
            description: 'about more',
          } as any,
          h(MenuItem, { onSelect: () => picked.push('inner') } as any, 'Inner'),
        ),
        h(SubMenu, { key: 2, label: 'Plain' } as any, h(MenuItem, null, 'Leaf')),
      ],
    }),
  );
  await click($('#open'));
  const [more, plain] = $$('.menu > .menu-item');
  assert.equal(more.querySelector('.menu-desc')!.textContent, 'about more');
  assert.equal(more.querySelector('.menu-shortcut')!.textContent, '⇧⌘P');
  assert.equal(plain.querySelector('.menu-label')!.textContent, 'Plain');
  assert.ok(!plain.querySelector('.menu-icon'));
  await mouse(more, 'mousemove');
  assert.match(more.className, /open/);
  const sub = $$('.popover-layer .menu').find((x) => x.textContent === 'Inner')!;
  assert.equal(sub.style.width, '150px');
  // moving from the row into its panel keeps it open
  await mouse(more, 'mouseout');
  await mouse(sub, 'mouseover');
  await flush(170);
  assert.match(more.className, /open/);
  await mouse(sub, 'mouseout');
  await flush(170);
  assert.doesNotMatch(more.className, /open/);
  await click(plain);
  assert.match(plain.className, /open/);
  const leafPanel = $$('.popover-layer .menu').find((x) => x.textContent === 'Leaf')!;
  assert.equal(leafPanel.getAttribute('style'), null);
  // Escape closes the layers, the submenu's included
  await key(document.body, 'Escape');
  assert.equal($('#state').textContent, 'false');
  assert.equal($$('.popover-layer').length, 0);
  await click($('#open'));
  await mouse($$('.menu > .menu-item')[0], 'mousemove');
  await click($$('.menu-item').find((x) => x.textContent === 'Inner'));
  assert.deepEqual(picked, ['inner']);
  assert.equal($('#state').textContent, 'false');
  await m.unmount();
});

test('menu items outside a menu have nothing to close', async () => {
  const m = await mount(h(MenuItem, { onSelect: () => {} } as any, 'Loose'));
  await click($('.menu-item'));
  assert.equal($('.menu-item').textContent, 'Loose');
  await m.unmount();
});

test('tooltips open after the delay, show the shortcut, and close on leave or press', async (t) => {
  // the 5 ms open delay runs on a mocked clock: a busy machine could otherwise open it before the first check
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = { left: 300, top: 300, width: 40, height: 20 };
  const m = await mount(h(Tooltip, { label: 'Send', shortcut: '↵', delay: 5 } as any, h('button', null, 'b')));
  const anchor = $('.tooltip-anchor');
  setRect(anchor, a);
  await mouse(anchor, 'mouseover');
  await act(async () => t.mock.timers.tick(4));
  assert.ok(!$('.tooltip'));
  await act(async () => t.mock.timers.tick(1));
  assert.equal($('.tooltip').textContent, 'Send↵');
  assert.equal($('.tooltip').className, 'tooltip');
  // centred below the anchor
  assert.deepEqual([parseFloat($('.tooltip').style.left), parseFloat($('.tooltip').style.top)], [270, 326]);
  await mouse(anchor, 'mouseout');
  assert.ok(!$('.tooltip'));
  await mouse(anchor, 'mouseover');
  await act(async () => t.mock.timers.tick(5));
  assert.ok($('.tooltip'));
  await mouse($('button'), 'mousedown');
  assert.ok(!$('.tooltip'));
  await m.unmount();
});

test('tooltip placement: above, to the right, clamped to the window, flipped above at the bottom', async () => {
  const cases: [any, any, [number, number]][] = [
    ['top', { left: 300, top: 300, width: 40, height: 20 }, [270, 244]],
    ['right-start', { left: 300, top: 300, width: 40, height: 20 }, [348, 285]],
    ['bottom', { left: 0, top: 300, width: 10, height: 20 }, [6, 326]],
    ['bottom', { left: 990, top: 300, width: 10, height: 20 }, [894, 326]],
    ['bottom', { left: 300, top: 760, width: 40, height: 20 }, [270, 704]],
  ];
  for (const [placement, rect, [left, top]] of cases) {
    const m = await mount(h(Tooltip, { label: 'tip', placement, delay: 0 } as any, h('i', null, 'x')));
    setRect($('.tooltip-anchor'), rect);
    await mouse($('.tooltip-anchor'), 'mouseover');
    await flush(1);
    assert.deepEqual([parseFloat($('.tooltip').style.left), parseFloat($('.tooltip').style.top)], [left, top], placement);
    await m.unmount();
  }
});

test('interactive tooltips stay open while the pointer moves onto the bubble and accept presses inside it', async () => {
  const clicks: string[] = [];
  const m = await mount(
    h(
      Tooltip,
      {
        label: h('span', null, h('a', { id: 'link', onMouseDown: () => clicks.push('link') }, 'link'), h('button', { id: 'pick' }, 'pick')),
        delay: 0,
        interactive: true,
        className: 'rich',
      } as any,
      h('i', { id: 'target' }, 'x'),
    ),
  );
  const anchor = $('.tooltip-anchor');
  setRect(anchor, { left: 100, top: 100, width: 10, height: 10 });
  await mouse(anchor, 'mouseover');
  await flush(1);
  // extra classes (the rich file list's) join the bubble's own
  assert.equal($('.tooltip').className, 'tooltip interactive rich');
  // the bubble is the anchor's child in React's tree: moving onto it does not leave the anchor
  await mouse(anchor, 'mouseout', { relatedTarget: $('.tooltip') });
  await mouse($('.tooltip'), 'mouseover', { relatedTarget: anchor });
  await flush(160);
  assert.ok($('.tooltip'), 'entering the bubble keeps it');
  // a press on the bubble's link reaches the anchor through the portal but does not close it
  await mouse($('#link'), 'mousedown');
  assert.deepEqual(clicks, ['link']);
  assert.ok($('.tooltip'));
  await mouse($('.tooltip'), 'mouseout');
  await flush(160);
  assert.ok(!$('.tooltip'));
  // leaving the anchor for good closes it after a pause; a press on the anchor closes at once
  await mouse(anchor, 'mouseover');
  await flush(1);
  await mouse(anchor, 'mouseout');
  await flush(160);
  assert.ok(!$('.tooltip'));
  await mouse(anchor, 'mouseover');
  await flush(1);
  await mouse($('#target'), 'mousedown');
  assert.ok(!$('.tooltip'));
  await m.unmount();
});

test('content in a tooltip can close it, and outside one closing does nothing', async () => {
  let close!: () => void;
  function Pick() {
    close = useCloseTooltip();
    return h('button', { id: 'pick', onClick: () => close() }, 'pick');
  }
  // no tooltip around it: the default does nothing
  const bare = await mount(h(Pick));
  close();
  await bare.unmount();
  const m = await mount(h(Tooltip, { label: h(Pick), delay: 0, interactive: true } as any, h('i', null, 'x')));
  await mouse($('.tooltip-anchor'), 'mouseover');
  await flush(1);
  assert.ok($('.tooltip'));
  await act(async () => $('#pick').click());
  assert.ok(!$('.tooltip'));
  await m.unmount();
});

test('useAnchor toggles and closes', async () => {
  let api: any;
  function T() {
    api = useAnchor();
    const [, force] = useState(0);
    return h('b', { ref: api.ref, onClick: () => force((n) => n + 1) }, String(api.open));
  }
  const m = await mount(h(T));
  await act(async () => api.toggle());
  assert.equal($('b').textContent, 'true');
  assert.ok(api.anchor === $('b'));
  await act(async () => api.close());
  assert.equal($('b').textContent, 'false');
  await m.unmount();
});

test('popovers follow scrolling and anchor resizing, hide invalid anchors, and flip either right placement', async () => {
  const previous = g.ResizeObserver;
  let resized: () => void = () => {};
  const observed: Element[] = [];
  let disconnected = false;
  g.ResizeObserver = class {
    constructor(callback: () => void) {
      resized = callback;
    }
    observe(element: Element) {
      observed.push(element);
    }
    disconnect() {
      disconnected = true;
    }
  };
  const a = anchorAt({ left: 300, top: 300, width: 80, height: 20 });
  const m = await mount(pop({ anchor: a, matchWidth: true }));
  try {
    assert.ok(observed.includes(a));
    setRect(a, { left: 400, top: 400, width: 90, height: 20 });
    await act(async () => {
      a.dispatchEvent(new (window as any).Event('scroll'));
    });
    assert.deepEqual([pos().left, pos().top], [400, 426]);
    setRect(a, { left: 450, top: 400, width: 110, height: 20 });
    await act(async () => resized());
    assert.deepEqual([pos().left, pos().width], [450, '110px']);
    await m.render(pop({ anchor: null }));
    assert.equal(pos().visibility, 'hidden');
    const invalid = anchorAt({ left: 0, top: 0, width: 0, height: 0 });
    await m.render(pop({ anchor: invalid }));
    assert.equal(pos().visibility, 'hidden');
    for (let i = 0; i < 10; i++) await act(async () => frames.shift()!());
    assert.equal(pos().visibility, 'hidden');
    setRect(invalid, { left: 950, top: 300, width: 40, height: 20 });
    await act(async () => resized());
    assert.equal(pos().visibility, 'visible');
    await m.render(pop({ anchor: invalid, placement: 'right-end' }));
    assert.equal(pos().left, 844);
    setRect(invalid, { left: 0, top: 0, width: 0, height: 0 });
    await act(async () => resized());
    assert.equal(pos().visibility, 'hidden');
    await m.render(pop({ anchor: { x: 100, y: 100 } }));
    assert.equal(disconnected, true);
    await m.unmount();
  } finally {
    g.ResizeObserver = previous;
    await m.unmount();
  }
});

test('tooltips flip below a top-edge anchor and clamp tall bubbles inside the viewport', async () => {
  for (const [placement, height, expected] of [
    ['top', 50, 28],
    ['right-start', 900, 6],
    ['bottom', 900, 6],
  ] as const) {
    layer.h = height;
    const m = await mount(h(Tooltip, { label: 'tip', placement, delay: 0 } as any, h('i', null, 'x')));
    setRect($('.tooltip-anchor'), { left: 100, top: 2, width: 40, height: 20 });
    await mouse($('.tooltip-anchor'), 'mouseover');
    await flush(1);
    assert.equal(parseFloat($('.tooltip').style.top), expected);
    await m.unmount();
  }
});

for (const legacy of [false, true]) {
  test(`menus ignore ${legacy ? 'legacy' : 'composing'} IME arrow and Enter events`, async (t) => {
    const picked: string[] = [];
    const m = await mount(h(MenuHarness, { onPick: (value: string) => picked.push(value) }));
    t.after(() => m.unmount());
    await click($('#open'));
    await key(document, 'ArrowDown');
    for (const value of ['ArrowDown', 'ArrowUp', 'Enter']) {
      const event = new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, isComposing: !legacy });
      if (legacy) Object.defineProperty(event, 'keyCode', { value: 229 });
      await act(async () => document.dispatchEvent(event as unknown as Event));
      assert.equal(event.defaultPrevented, false);
      assert.equal($('.menu-item.kbd-active .menu-title').textContent, 'One');
      assert.deepEqual(picked, []);
    }
    await key(document, 'Enter');
    assert.deepEqual(picked, ['one']);
  });
}

test('menus allow held arrow navigation but do not repeat an Enter action', async (t) => {
  const picked: string[] = [];
  const m = await mount(
    h(MenuHarness, {
      children: [
        h(MenuItem, { key: 1, keepOpen: true, onSelect: () => picked.push('first'), children: 'First' }),
        h(MenuItem, { key: 2, keepOpen: true, onSelect: () => picked.push('last'), children: 'Last' }),
      ],
    }),
  );
  t.after(() => m.unmount());
  await click($('#open'));
  await key(document, 'ArrowDown');
  await key(document, 'Enter', { repeat: true });
  assert.deepEqual(picked, []);
  await key(document, 'ArrowDown', { repeat: true });
  assert.equal($('.menu-item.kbd-active').textContent, 'Last');
  await key(document, 'Enter');
  await key(document, 'Enter', { repeat: true });
  assert.deepEqual(picked, ['last']);
});

for (const legacy of [false, true]) {
  test(`popover Escape preserves ${legacy ? 'legacy' : 'active'} IME composition`, async (t) => {
    let closed = 0;
    let reachedInput = 0;
    const m = await mount(
      h(Popover, {
        children: h('input', {
          id: 'composing-input',
          onKeyDown: () => {
            reachedInput++;
          },
        }),
        anchor: { x: 200, y: 200 },
        open: true,
        onClose: () => {
          closed++;
        },
      }),
    );
    t.after(() => m.unmount());
    const event = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: !legacy });
    if (legacy) Object.defineProperty(event, 'keyCode', { value: 229 });
    await act(async () => $('#composing-input').dispatchEvent(event));
    assert.equal(closed, 0);
    assert.equal(reachedInput, 1);
    await key($('#composing-input'), 'Escape');
    assert.equal(closed, 1);
    assert.equal(reachedInput, 1);
  });
}

for (const entry of ['keyboard', 'pointer']) {
  test(`submenu actions are keyboard-accessible after opening with the ${entry}`, async (t) => {
    const picked: string[] = [];
    const m = await mount(
      h(MenuHarness, {
        children: [
          h(SubMenu, { key: 1, label: 'More', children: h(MenuItem, { onSelect: () => picked.push('inner'), children: 'Inner' }) }),
          h(MenuItem, { key: 2, onSelect: () => picked.push('outer'), children: 'Outer' }),
        ],
      }),
    );
    t.after(() => m.unmount());
    await click($('#open'));
    const parent = $('.menu');
    if (entry === 'keyboard') {
      await key(document, 'ArrowDown');
      await key(document, 'Enter');
    } else await mouse($('.menu > .menu-item'), 'mousemove');
    const child = $$('.popover-layer .menu').find((menu) => menu !== parent)!;
    assert.ok(child);
    await key(document, 'ArrowDown');
    assert.equal($('.menu-item.kbd-active', child)?.textContent, 'Inner');
    assert.deepEqual(picked, []);
    await key(document, 'Enter');
    assert.deepEqual(picked, ['inner']);
    assert.equal($('#state').textContent, 'false');
  });
}

test('a menu leaves keys consumed by an embedded input to that input', async (t) => {
  const picked: string[] = [];
  const handled: string[] = [];
  const m = await mount(
    h(MenuHarness, {
      children: [
        h('input', {
          key: 'input',
          id: 'menu-input',
          onKeyDown: (event: any) => {
            event.preventDefault();
            handled.push(event.key);
          },
        }),
        h(MenuItem, { key: 1, keepOpen: true, onSelect: () => picked.push('first'), children: 'First' }),
        h(MenuItem, { key: 2, keepOpen: true, onSelect: () => picked.push('last'), children: 'Last' }),
      ],
    }),
  );
  t.after(() => m.unmount());
  await click($('#open'));
  await key(document, 'ArrowDown');
  for (const value of ['ArrowDown', 'ArrowUp', 'Enter']) {
    await key($('#menu-input'), value);
    assert.equal($('.menu-item.kbd-active').textContent, 'First');
    assert.deepEqual(picked, []);
  }
  assert.deepEqual(handled, ['ArrowDown', 'ArrowUp', 'Enter']);
  await key(document, 'Enter');
  assert.deepEqual(picked, ['first']);
});

for (const destination of ['anchor', 'button']) {
  test(`interactive tooltip remains open when returning to its ${destination}`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const m = await mount(
      h(Tooltip, { label: 'interactive', delay: 450, interactive: true } as any, h('button', { id: 'tooltip-target' }, 'anchor')),
    );
    t.after(() => m.unmount());
    const anchor = $('.tooltip-anchor');
    setRect(anchor, { left: 100, top: 100, width: 20, height: 20 });
    await mouse(anchor, 'mouseover');
    await act(async () => t.mock.timers.tick(450));
    const bubble = $('.tooltip');
    await mouse(bubble, 'mouseover', { relatedTarget: anchor });
    const target = destination === 'anchor' ? anchor : $('#tooltip-target');
    await mouse(bubble, 'mouseout', { relatedTarget: target });
    await mouse(target, 'mouseover', { relatedTarget: bubble });
    await act(async () => t.mock.timers.tick(160));
    assert.ok($('.tooltip'), 'returning to the anchor must cancel any hide');
    await act(async () => t.mock.timers.tick(450));
    assert.ok($('.tooltip'));
    await mouse($('.tooltip'), 'mouseout', { relatedTarget: document.body });
    await act(async () => t.mock.timers.tick(160));
    assert.ok(!$('.tooltip'), 'leaving both surfaces still hides the bubble');
  });
}

test('reentering an interactive tooltip anchor cancels its pending hide', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const m = await mount(h(Tooltip, { label: 'interactive', delay: 450, interactive: true } as any, h('button', null, 'anchor')));
  t.after(() => m.unmount());
  const anchor = $('.tooltip-anchor');
  setRect(anchor, { left: 100, top: 100, width: 20, height: 20 });
  await mouse(anchor, 'mouseover');
  await act(async () => t.mock.timers.tick(450));
  await mouse(anchor, 'mouseout');
  await act(async () => t.mock.timers.tick(100));
  await mouse(anchor, 'mouseover');
  await act(async () => t.mock.timers.tick(60));
  assert.ok($('.tooltip'));
  await mouse($('.tooltip'), 'mouseout', { relatedTarget: null });
  await act(async () => t.mock.timers.tick(160));
  assert.ok(!$('.tooltip'));
});

test('menus are WAI-ARIA menus: the list takes focus, rows say their role, a submenu opened from the keyboard takes focus and ArrowLeft returns', async (t) => {
  const picked: string[] = [];
  const m = await mount(
    h(MenuHarness, {
      children: [
        h(MenuItem, { key: 1, checked: true, onSelect: () => picked.push('checked'), children: 'Checked' }),
        h(SubMenu, {
          key: 2,
          label: 'More',
          children: h(MenuItem, { keepOpen: true, onSelect: () => picked.push('inner'), children: 'Inner' }),
        }),
      ],
    }),
  );
  t.after(() => m.unmount());
  $('#open').focus();
  await click($('#open'));
  const runFrames = () =>
    act(async () => {
      for (const f of frames.splice(0)) f();
    });
  await runFrames();
  const parent = $('.menu');
  assert.equal(document.activeElement, parent, 'the open menu has the keyboard');
  const [checked, more] = $$('.menu > .menu-item');
  assert.equal(checked.getAttribute('role'), 'menuitemcheckbox');
  assert.equal(checked.getAttribute('aria-checked'), 'true');
  assert.equal(more.getAttribute('aria-haspopup'), 'menu');
  assert.equal(more.getAttribute('aria-expanded'), 'false');
  await key(parent, 'ArrowDown');
  await key(parent, 'ArrowDown');
  assert.equal(parent.getAttribute('aria-activedescendant'), more.id);
  await key(parent, 'ArrowRight');
  await runFrames();
  const child = $$('.popover-layer .menu').find((x) => x !== parent)!;
  assert.equal(more.getAttribute('aria-expanded'), 'true');
  assert.equal(document.activeElement, child, 'opened from the keyboard: the submenu takes focus');
  // the pointer leaving the row doesn't close a submenu the keyboard opened, and a click inside it (a portal,
  // so React passes it on to the row) doesn't take its focus away
  await mouse(more, 'mouseout');
  await flush(170);
  assert.equal(document.activeElement, child);
  await act(async () => $('.menu-item', child).dispatchEvent(new (window as any).MouseEvent('click', { bubbles: true, detail: 1 })));
  await runFrames();
  assert.equal(document.activeElement, child);
  assert.deepEqual(picked, ['inner']);
  picked.length = 0;
  await key(child, 'ArrowLeft');
  assert.equal($$('.popover-layer .menu').length, 1, 'ArrowLeft closes only the submenu');
  assert.equal(document.activeElement, parent, 'and focus goes back to the menu it came from');
  // opened by the pointer, the submenu doesn't take focus from the menu, even after a keyboard open
  await mouse(more, 'mousemove');
  await runFrames();
  assert.equal($$('.popover-layer .menu').length, 2);
  assert.equal(document.activeElement, parent);
  await act(async () => more.dispatchEvent(new (window as any).MouseEvent('click', { bubbles: true, detail: 1 })));
  await runFrames();
  assert.equal(document.activeElement, parent);
  await key(document.body, 'Escape');
  assert.equal($('#state').textContent, 'false');
  assert.equal(document.activeElement, $('#open'), 'closing gives focus back to the menu button');
  assert.deepEqual(picked, []);
});
