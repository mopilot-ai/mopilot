// Pane tab geometry, selection, portal isolation and observer retirement through the real shared list component.
import { test, mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { act, createElement as h, StrictMode } from 'react';
import { createPortal } from 'react-dom';
import { render } from './support/shell-chrome-kit.ts';
import { PaneTabList } from '../src/components/titleBar/PaneTabList.tsx';

function observers(t: TestContext) {
  const resize: { targets: Set<Element>; notify(): void }[] = [];
  const mutation: { notify(records: MutationRecord[]): void; disconnected: boolean }[] = [];
  const old = [globalThis.ResizeObserver, globalThis.MutationObserver] as const;
  globalThis.ResizeObserver = class {
    targets = new Set<Element>();
    notify: () => void;
    constructor(callback: ResizeObserverCallback) {
      this.notify = () => callback([], this as unknown as ResizeObserver);
      resize.push(this);
    }
    observe(target: Element) {
      this.targets.add(target);
    }
    unobserve(target: Element) {
      this.targets.delete(target);
    }
    disconnect() {
      this.targets.clear();
    }
  } as unknown as typeof ResizeObserver;
  globalThis.MutationObserver = class {
    disconnected = false;
    notify: (records: MutationRecord[]) => void;
    constructor(callback: MutationCallback) {
      this.notify = (records) => callback(records, this as unknown as MutationObserver);
      mutation.push(this);
    }
    observe() {}
    disconnect() {
      this.disconnected = true;
    }
  } as unknown as typeof MutationObserver;
  t.after(() => {
    [globalThis.ResizeObserver, globalThis.MutationObserver] = old;
  });
  return { resize, mutation };
}

function change(type: MutationRecordType, target: Node, added: Node[] = [], removed: Node[] = []): MutationRecord {
  return {
    type,
    target,
    addedNodes: added as unknown as NodeList,
    removedNodes: removed as unknown as NodeList,
    attributeName: type === 'attributes' ? 'aria-current' : null,
    attributeNamespace: null,
    nextSibling: null,
    previousSibling: null,
    oldValue: null,
  };
}

test('geometry follows the current direct tab, including new and closing tabs, and ignores unrelated DOM changes', async (t) => {
  const world = observers(t);
  const reveals: Element[] = [];
  const spy = mock.method(HTMLElement.prototype, 'scrollIntoView', function (this: HTMLElement) {
    reveals.push(this);
  });
  t.after(() => spy.mock.restore());
  const { host, unmount } = await render(
    h(
      PaneTabList,
      null,
      h('div', { className: 'tb-tab', 'aria-current': 'true', key: 'first' }, h('span', null, 'First')),
      h('div', { className: 'tb-tab', key: 'second' }, 'Second'),
      h('span', { key: 'other' }, 'Not a tab'),
    ),
  );
  const list = host.querySelector('.tb-tab-list')!;
  const [first, second] = [...list.querySelectorAll('.tb-tab')];
  const ro = world.resize[0];
  const mo = world.mutation[0];
  try {
    assert.deepEqual([...ro.targets], [list, first, second]);
    assert.deepEqual(reveals, [first]);
    first.removeAttribute('aria-current');
    second.setAttribute('aria-current', 'true');
    reveals.length = 0;
    mo.notify([change('attributes', second)]);
    assert.deepEqual(reveals, [second]);
    const label = first.querySelector('span')!;
    const text = document.createTextNode('Longer first label');
    reveals.length = 0;
    mo.notify([change('attributes', label), change('childList', label, [text]), change('childList', list, [text])]);
    assert.deepEqual(reveals, [], 'only selection or tab membership triggers a mutation reveal');
    ro.notify();
    assert.deepEqual(reveals, [second], 'a later size change reveals the current tab, not the old selection');
    const third = document.createElement('div');
    third.className = 'tb-tab';
    third.textContent = 'Third';
    list.append(third);
    mo.notify([change('childList', list, [third])]);
    assert.ok(ro.targets.has(third));
    first.classList.add('tab-leaving');
    reveals.length = 0;
    ro.notify();
    assert.deepEqual(reveals, [second], 'size notifications continue during a close transition');
    first.remove();
    mo.notify([change('childList', list, [], [first])]);
    assert.equal(ro.targets.has(first), false);
    assert.deepEqual([...ro.targets], [list, second, third]);
    second.removeAttribute('aria-current');
    reveals.length = 0;
    mo.notify([change('attributes', second)]);
    ro.notify();
    assert.deepEqual(reveals, [], 'an empty selection is safe');
  } finally {
    await unmount();
  }
  assert.equal(ro.targets.size, 0);
  assert.equal(mo.disconnected, true);
  reveals.length = 0;
  ro.notify();
  mo.notify([change('childList', list, [first])]);
  assert.deepEqual(reveals, [], 'late callbacks cannot publish after the list retires');
});

test('a real React portal menu cannot move the strip when its entrance animation finishes', async (t) => {
  const world = observers(t);
  const reveals: Element[] = [];
  const spy = mock.method(HTMLElement.prototype, 'scrollIntoView', function (this: HTMLElement) {
    reveals.push(this);
  });
  t.after(() => spy.mock.restore());
  const { host, unmount } = await render(
    h(
      PaneTabList,
      null,
      h('div', { className: 'tb-tab', 'aria-current': 'true', key: 'active' }, 'Active'),
      createPortal(h('div', { role: 'menu' }, 'Portal menu'), document.body, 'menu'),
    ),
  );
  try {
    const list = host.querySelector('.tb-tab-list')!;
    const menu = document.querySelector('[role="menu"]')!;
    assert.equal(list.contains(menu), false);
    assert.equal(world.resize[0].targets.has(menu), false);
    reveals.length = 0;
    await act(async () => {
      menu.dispatchEvent(new Event('animationend', { bubbles: true }));
      menu.dispatchEvent(new Event('transitionend', { bubbles: true }));
    });
    assert.deepEqual(reveals, []);
  } finally {
    await unmount();
  }
});

test('an inactive tab rename editor owns visibility until focus leaves the field', async (t) => {
  const world = observers(t);
  const reveals: Element[] = [];
  const spy = mock.method(HTMLElement.prototype, 'scrollIntoView', function (this: HTMLElement) {
    reveals.push(this);
  });
  t.after(() => spy.mock.restore());
  const tabs = (editing: boolean) =>
    h(
      PaneTabList,
      null,
      h(
        'div',
        { className: 'tb-tab', key: 'inactive' },
        editing ? h('input', { className: 'tb-tab-rename', autoFocus: true }) : 'Inactive',
      ),
      h('div', { className: 'tb-tab', 'aria-current': 'true', key: 'active' }, 'Active'),
    );
  const { host, rerender, unmount } = await render(tabs(false));
  try {
    const [inactive, active] = [...host.querySelectorAll('.tb-tab')];
    await rerender(tabs(true));
    const input = inactive.querySelector('input')!;
    assert.equal(document.activeElement, input);
    reveals.length = 0;
    world.resize[0].notify();
    assert.deepEqual(reveals, [inactive], 'resizing the inactive editor must not hide the focused field');
    input.blur();
    reveals.length = 0;
    world.resize[0].notify();
    assert.deepEqual(reveals, [active], 'selection owns subsequent geometry after editing ends');
  } finally {
    await unmount();
  }
});

test('Strict Mode retires old observer callbacks before the replacement effect owns the same list', async (t) => {
  const world = observers(t);
  const reveals: Element[] = [];
  const spy = mock.method(HTMLElement.prototype, 'scrollIntoView', function (this: HTMLElement) {
    reveals.push(this);
  });
  t.after(() => spy.mock.restore());
  const { host, unmount } = await render(
    h(StrictMode, null, h(PaneTabList, null, h('div', { className: 'tb-tab', 'aria-current': 'true' }, 'Active'))),
  );
  try {
    const active = host.querySelector('.tb-tab')!;
    assert.equal(world.resize.length, 2);
    reveals.length = 0;
    world.resize[0].notify();
    world.mutation[0].notify([change('attributes', active)]);
    assert.deepEqual(reveals, []);
    world.resize[1].notify();
    assert.deepEqual(reveals, [active]);
  } finally {
    await unmount();
  }
});
