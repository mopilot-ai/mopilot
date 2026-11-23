// The shared path menu (src/components/ui/FileMenu.tsx): the one Reveal in Finder every file surface reaches.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { mount, click, byText, popoverStubs, iconStubs } from './support/harness-ui-kit.ts';
import { mockSource } from './support/stubs.ts';

const calls: unknown[][] = [];
mockSource('src/session/open.ts', { revealPath: (p: string) => calls.push(['reveal', p]) });
mockSource('src/session/clipboard.ts', { copyText: (text: string, done: unknown) => calls.push(['copy', text, done]) });
mockSource('src/components/ui/icons.tsx', iconStubs());
mockSource('src/components/ui/Popover.tsx', popoverStubs);
const { createElement: h, act } = await import('react');
const { useFileMenu, FileMenuButton } = await import('../src/components/ui/FileMenu.tsx');
const { MenuItem } = await import('../src/components/ui/Popover.tsx');

beforeEach(() => {
  calls.length = 0;
});

/** A surface with no room for a menu button: the path's own element carries `target`. */
function Target({ path, parentClick }: { path: string; parentClick?: () => void }) {
  const m = useFileMenu(path);
  return h('div', { className: 'row', onContextMenu: parentClick }, h('a', { className: 'path', href: path, ...m.target }, path), m.menu);
}

const item = (host: ParentNode, label: string) => byText(host, '[role=menuitem]', label);
const menu = (host: ParentNode) => host.querySelector('[role=menu]');
async function fire(el: Element, type: string, init: Record<string, unknown> = {}) {
  const Ctor = type === 'contextmenu' ? (window as any).MouseEvent : (window as any).KeyboardEvent;
  const event = new Ctor(type, { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    el.dispatchEvent(event);
  });
  return { prevented: event.defaultPrevented };
}

test('the button names itself for assistive software and reports whether its menu is open', async () => {
  const v = await mount(h(FileMenuButton, { path: '/repo/src/a.ts' }));
  try {
    const trigger = v.host.querySelector('button')!;
    assert.equal(trigger.getAttribute('aria-label'), 'File actions');
    assert.equal(trigger.getAttribute('title'), 'File actions');
    assert.equal(trigger.getAttribute('aria-haspopup'), 'menu');
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(menu(v.host), null);
    await click(trigger);
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    assert.equal(menu(v.host)!.getAttribute('data-placement'), 'bottom-end');
    await click(trigger);
    assert.equal(menu(v.host), null);
  } finally {
    await v.unmount();
  }
});

test('the button menu copies and reveals the path it was given', async () => {
  const v = await mount(h(FileMenuButton, { path: '/repo/src/a.ts' }));
  try {
    await click(v.host.querySelector('button'));
    await click(item(v.host, 'Reveal in Finder'));
    assert.equal(menu(v.host), null, 'picking an item closes the menu');
    await click(v.host.querySelector('button'));
    await click(item(v.host, 'Copy path'));
    assert.deepEqual(calls, [
      ['reveal', '/repo/src/a.ts'],
      ['copy', '/repo/src/a.ts', 'Copied path'],
    ]);
  } finally {
    await v.unmount();
  }
});

test('a surface that displays a shorter path copies that and still reveals the absolute file', async () => {
  const v = await mount(h(FileMenuButton, { path: '/repo/src/a.ts', copy: 'src/a.ts' }));
  try {
    await click(v.host.querySelector('button'));
    await click(item(v.host, 'Copy path'));
    await click(v.host.querySelector('button'));
    await click(item(v.host, 'Reveal in Finder'));
    assert.deepEqual(calls, [
      ['copy', 'src/a.ts', 'Copied path'],
      ['reveal', '/repo/src/a.ts'],
    ]);
  } finally {
    await v.unmount();
  }
});

test('a right-click on the path opens the menu at the pointer, and only the innermost one', async () => {
  const v = await mount(h(Target, { path: '/repo/src/a.ts', parentClick: () => calls.push(['row']) }));
  try {
    const link = v.host.querySelector('.path')!;
    const { prevented } = await fire(link, 'contextmenu', { clientX: 40, clientY: 80 });
    assert.equal(prevented, true, 'the browser menu is replaced, not added to');
    assert.equal(link.getAttribute('aria-haspopup'), 'menu');
    assert.equal(menu(v.host)!.getAttribute('data-placement'), 'bottom-start');
    await click(item(v.host, 'Reveal in Finder'));
    assert.deepEqual(calls, [['reveal', '/repo/src/a.ts']], 'the row around it never saw the click, so its own menu stays shut');
  } finally {
    await v.unmount();
  }
});

test('Shift-F10 and the Context Menu key open the same menu; the element keeps every other key', async () => {
  const v = await mount(h(Target, { path: '/repo/src/a.ts' }));
  try {
    const link = v.host.querySelector('.path')!;
    for (const init of [
      { key: 'Enter' },
      { key: 'F10' },
      { key: 'F10', shiftKey: true, ctrlKey: true },
      { key: 'ContextMenu', altKey: true },
    ]) {
      const { prevented } = await fire(link, 'keydown', init);
      const opened = !!menu(v.host);
      assert.equal(opened, init.key === 'ContextMenu' || (init.key === 'F10' && !!init.shiftKey), `${init.key} opened ${opened}`);
      assert.equal(prevented, opened, 'only a key the menu takes is prevented');
      if (opened) await click(item(v.host, 'Reveal in Finder'));
    }
    assert.deepEqual(calls, [
      ['reveal', '/repo/src/a.ts'],
      ['reveal', '/repo/src/a.ts'],
    ]);
  } finally {
    await v.unmount();
  }
});

test('a surface adds its own items below the shared ones, and its button re-anchors after a right-click', async () => {
  function WithExtra() {
    const m = useFileMenu('/repo/src/a.ts', {
      extra: h(MenuItem, { danger: true, onSelect: () => void calls.push(['discard']), children: 'Discard changes' }),
    });
    return h('span', null, h('button', { ...m.trigger }, 'actions'), h('b', { ...m.target }, 'path'), m.menu);
  }
  const v = await mount(h(WithExtra));
  try {
    await fire(v.host.querySelector('b')!, 'contextmenu', { clientX: 5, clientY: 6 });
    assert.deepEqual(
      [...v.host.querySelectorAll('[role=menuitem]')].map((n) => n.textContent),
      ['Copy path', 'Reveal in Finder', 'Discard changes'],
    );
    await click(item(v.host, 'Discard changes'));
    assert.deepEqual(calls, [['discard']]);
    await click(v.host.querySelector('button'));
    assert.equal(menu(v.host)!.getAttribute('data-placement'), 'bottom-end', 'the button anchors its own menu again');
  } finally {
    await v.unmount();
  }
});
