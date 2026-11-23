// Real tool-grid controls resize adjacent panes, keep resource children stable and retire stale drags.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { pointerEvent } from './support/pointerCapture.ts';
import { createElement as h, act, useEffect } from 'react';
import { render } from './support/shell-panels-kit.ts';
import { ToolPaneGrid, toolCell } from '../src/components/panels/ToolPaneGrid.tsx';
import {
  toolLayout,
  rememberToolLayout,
  projectToolLayout,
  splitToolLayout,
  resetToolLayouts,
  useToolLayout,
} from '../src/lib/toolPaneLayout.ts';
const tabs: any[] = [
  { id: 'a', kind: 'files' },
  { id: 'b', kind: 'terminal', title: 'Shell' },
  { id: 'c', kind: 'browser' },
];
const pair = () => splitToolLayout(projectToolLayout(toolLayout('a'), ['a', 'b', 'c'], 'a'), 'b', 'columns');
let mounts = 0,
  exits = 0;
function Resource() {
  useEffect(() => {
    mounts++;
    return () => {
      exits++;
    };
  }, []);
  return h('textarea', { defaultValue: 'kept editor' });
}
function Grid({ scope = 'a' }: { scope?: string }) {
  const layout = useToolLayout(scope);
  return h(
    ToolPaneGrid,
    { scope, layout, tabs, select: (active: string) => rememberToolLayout(scope, { ...toolLayout(scope), active }) },
    h(Resource),
  );
}
beforeEach(() => {
  resetToolLayouts();
  mounts = 0;
  exits = 0;
  rememberToolLayout('a', pair());
});
const click = async (host: HTMLElement, name: string) => act(() => (host.querySelector(`[aria-label="${name}"]`) as HTMLElement).click());
const key = async (host: HTMLElement, value: string) => {
  const e = new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true });
  await act(() => host.querySelector('[role="separator"]')!.dispatchEvent(e));
  return e;
};

test('rows, columns, focused headers and one-pane mode keep a single resource owner', async () => {
  const v = await render(h(Grid));
  assert.equal(v.host.querySelector('.tool-pane-grid')!.getAttribute('data-axis'), 'columns');
  assert.deepEqual(toolCell(toolLayout('a'), 1), { gridColumn: 3, gridRow: 2 });
  assert.deepEqual(toolCell(toolLayout('a'), 1, true), { gridColumn: 3, gridRow: 1 });
  await click(v.host, 'Arrange tools in rows');
  assert.equal(v.host.querySelector('[role="separator"]')!.getAttribute('aria-orientation'), 'horizontal');
  assert.deepEqual(toolCell(toolLayout('a'), 1), { gridColumn: 1, gridRow: 5 });
  await click(v.host, 'Arrange tools in columns');
  await act(() => (v.host.querySelector('.tool-tile-label') as HTMLElement).click());
  assert.equal(toolLayout('a').active, 'a');
  await click(v.host, 'Return to one tool pane');
  assert.deepEqual(toolLayout('a').ids, ['a']);
  assert.equal(v.host.querySelector('.tool-tile-head'), null);
  assert.deepEqual(toolCell(toolLayout('a'), 0), { gridColumn: 1, gridRow: 1 });
  assert.equal((v.host.querySelector('textarea') as HTMLTextAreaElement).value, 'kept editor');
  assert.equal(mounts, 1);
  assert.equal(exits, 0);
  await v.unmount();
  assert.equal(exits, 1);
});

test('removing a tile keeps the other tab selected without closing a resource', async () => {
  const v = await render(h(Grid));
  await click(v.host, 'Remove Shell from split');
  assert.deepEqual(toolLayout('a').ids, ['a']);
  assert.equal(toolLayout('a').active, 'a');
  assert.equal(exits, 0);
  await v.unmount();
});

test('keyboard dividers support both axes, bounded ends, reset, and leave unrelated keys alone', async () => {
  const v = await render(h(Grid));
  assert.equal((await key(v.host, 'ArrowRight')).defaultPrevented, true);
  assert.equal(v.host.querySelector('[role="separator"]')!.getAttribute('aria-valuenow'), '55');
  await key(v.host, 'ArrowLeft');
  assert.equal(v.host.querySelector('[role="separator"]')!.getAttribute('aria-valuenow'), '50');
  await key(v.host, 'Home');
  assert.equal(v.host.querySelector('[role="separator"]')!.getAttribute('aria-valuenow'), '10');
  await key(v.host, 'End');
  assert.equal(v.host.querySelector('[role="separator"]')!.getAttribute('aria-valuenow'), '90');
  await key(v.host, 'Enter');
  assert.equal(v.host.querySelector('[role="separator"]')!.getAttribute('aria-valuenow'), '50');
  assert.equal((await key(v.host, 'x')).defaultPrevented, false);
  await click(v.host, 'Arrange tools in rows');
  await key(v.host, 'ArrowDown');
  assert.equal(v.host.querySelector('[role="separator"]')!.getAttribute('aria-valuenow'), '55');
  await key(v.host, 'ArrowUp');
  assert.equal(v.host.querySelector('[role="separator"]')!.getAttribute('aria-valuenow'), '50');
  await act(() => v.host.querySelector('[role="separator"]')!.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true })));
  assert.equal(v.host.querySelector('[role="separator"]')!.getAttribute('aria-valuenow'), '50');
  await v.unmount();
});

let edge: Element;
const release = () => act(() => edge.dispatchEvent(pointerEvent('pointerup')));
async function move(x: number, y = 0) {
  await act(async () => {
    edge.dispatchEvent(pointerEvent('pointermove', { clientX: x, clientY: y }));
    await new Promise((r) => setTimeout(r, 5));
  });
}
async function start(host: HTMLElement, x = 0, y = 0) {
  const grid = host.querySelector('.tool-pane-grid') as HTMLElement;
  grid.getBoundingClientRect = () => ({ width: 606, height: 406 }) as DOMRect;
  edge = host.querySelector('[role="separator"]')!;
  await act(() => edge.dispatchEvent(pointerEvent('pointerdown', { clientX: x, clientY: y })));
}

test('pointer resizing paints frames without remounting children and commits once on release, on either axis', async () => {
  const v = await render(h(Grid));
  await start(v.host);
  await move(120);
  assert.equal(toolLayout('a').weights[0], 0.5, 'only DOM paints until release');
  await release();
  assert.ok(Math.abs(toolLayout('a').weights[0] - 0.7) < 1e-12);
  await click(v.host, 'Arrange tools in rows');
  await start(v.host, 0, 100);
  await move(0, 20);
  await release();
  assert.ok(toolLayout('a').weights[0] < 0.7);
  assert.equal(mounts, 1);
  await v.unmount();
});

test('navigation, another layout edit and unmount cancel a drag before a stale release can write weights', async () => {
  rememberToolLayout('b', pair());
  const v = await render(h(Grid));
  await start(v.host);
  await move(150);
  await act(() => v.root.render(h(Grid, { scope: 'b' })));
  await release();
  assert.deepEqual(toolLayout('a').weights, [0.5, 0.5]);
  assert.deepEqual(toolLayout('b').weights, [0.5, 0.5]);
  await start(v.host);
  await move(180);
  await click(v.host, 'Arrange tools in rows');
  await release();
  assert.deepEqual(toolLayout('b').weights, [0.5, 0.5]);
  await start(v.host);
  await move(0, 80);
  await v.unmount();
  edge.dispatchEvent(pointerEvent('pointerup'));
  assert.deepEqual(toolLayout('b').weights, [0.5, 0.5]);
});

test('a second divider press retires the first drag before the next movement commits', async () => {
  const v = await render(h(Grid));
  await start(v.host);
  await move(120);
  await start(v.host, 120);
  await move(180);
  await release();
  assert.ok(Math.abs(toolLayout('a').weights[0] - 0.6) < 1e-12, 'only the second drag owns the release');
  assert.equal(mounts, 1);
  await v.unmount();
});

test('row dragging follows the pointer after subtracting unequal wrapped header tracks', async () => {
  const v = await render(h(Grid));
  await click(v.host, 'Arrange tools in rows');
  const headers = [...v.host.querySelectorAll('.tool-tile-head')];
  for (const [i, el] of headers.entries()) el.getBoundingClientRect = () => ({ height: i === 0 ? 55 : 25 }) as DOMRect;
  await start(v.host, 0, 100);
  await move(0, 180);
  await release();
  // 406px grid - 6px divider - 80px headers = 320px bodies. An80px move transfers one quarter of the pair.
  assert.deepEqual(toolLayout('a').weights, [0.75, 0.25]);
  await v.unmount();
});

test('input-method composing keys cannot resize or reset a tool divider', async () => {
  const v = await render(h(Grid));
  const before = toolLayout('a');
  for (const init of [
    { key: 'Enter', isComposing: true },
    { key: 'ArrowRight', isComposing: true },
    { key: 'Enter', keyCode: 229 },
  ]) {
    const e = new window.KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
    await act(() => v.host.querySelector('[role="separator"]')!.dispatchEvent(e));
    assert.equal(e.defaultPrevented, false);
    assert.equal(toolLayout('a'), before);
  }
  await v.unmount();
});

test('a press leaves the focus alone, only the main button drags, and a click without a move changes nothing', async () => {
  const v = await render(h(Grid));
  const divider = v.host.querySelector('[role="separator"]')!;
  const down = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  await act(() => divider.dispatchEvent(down));
  assert.equal(down.defaultPrevented, true);
  await act(() => divider.dispatchEvent(pointerEvent('pointerdown', { button: 2 })));
  assert.equal((divider as HTMLElement).hasPointerCapture(1), false);
  await start(v.host);
  await release();
  assert.deepEqual(toolLayout('a').weights, [0.5, 0.5]);
  await v.unmount();
});
