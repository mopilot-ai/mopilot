import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
const captures = new WeakMap<HTMLElement, number>();
(window.HTMLElement.prototype as any).setPointerCapture = function (id: number) {
  captures.set(this, id);
};
(window.HTMLElement.prototype as any).hasPointerCapture = function (id: number) {
  return captures.get(this) === id;
};
(window.HTMLElement.prototype as any).releasePointerCapture = function () {
  captures.delete(this);
};
const { createElement, act, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const { SidebarResize } = await import('../src/components/sidebar/SidebarResize.tsx');
async function mount(open = true) {
  const host = document.createElement('div');
  document.body.append(host);
  const saves: number[] = [];
  let state: any;
  function Probe() {
    const [isOpen, setOpen] = useState(open);
    const [width, setWidth] = useState(288);
    const [dragging, setDragging] = useState(false);
    state = { open: isOpen, width, dragging };
    return createElement(SidebarResize, {
      open: isOpen,
      width,
      dragging,
      onWidthChange: setWidth,
      onOpenChange: setOpen,
      onDraggingChange: setDragging,
      onSaveWidth: (v: number) => saves.push(v),
    });
  }
  const root = createRoot(host as any);
  await act(() => root.render(createElement(Probe)));
  const handle = () => host.querySelector<HTMLElement>('[role="separator"]')!;
  // a move shows its width on the next animation frame (src/lib/edgeDrag.ts, #2049): a move here waits for that frame
  const pointer = async (type: string, x: number, pointerId = 1, button = 0) => {
    await act(() => handle().dispatchEvent(new window.PointerEvent(type, { bubbles: true, pointerId, button, clientX: x }) as any));
    if (type === 'pointermove') await act(() => new Promise<void>((r) => setTimeout(r, 0)));
  };
  const key = async (key: string) =>
    act(() => handle().dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key }) as any));
  return {
    handle,
    pointer,
    key,
    saves,
    state: () => state,
    close: async () => {
      await act(() => root.unmount());
      host.remove();
    },
  };
}

test('snap-to-zero keeps the same frame handle and pointer capture so the same drag can reverse', async () => {
  const m = await mount();
  try {
    const original = m.handle();
    await m.pointer('pointerdown', 288);
    await m.pointer('pointermove', 47);
    assert.equal(m.state().width, 0);
    assert.ok(m.handle().classList.contains('collapsed'));
    assert.equal(m.handle() === original, true);
    assert.equal((original as any).hasPointerCapture(1), true);
    await m.pointer('pointermove', 220);
    assert.equal(m.state().width, 220);
    await m.pointer('pointerup', 220);
    assert.deepEqual(m.state(), { open: true, width: 220, dragging: false });
    assert.deepEqual(m.saves, [220]);
    await m.pointer('lostpointercapture', 220);
    assert.deepEqual(m.saves, [220]);
  } finally {
    await m.close();
  }
});

test('after release at zero the edge remains draggable and reopens the sidebar without overwriting saved width', async () => {
  const m = await mount();
  try {
    await m.pointer('pointerdown', 288);
    await m.pointer('pointermove', 20);
    await m.pointer('pointerup', 20);
    assert.deepEqual(m.state(), { open: false, width: 0, dragging: false });
    assert.deepEqual(m.saves, []);
    assert.equal(m.handle().style.left, '0px');
    assert.equal(m.handle().getAttribute('aria-label'), 'Drag to open sidebar');
    await m.pointer('pointerdown', 0);
    await m.pointer('pointermove', 40);
    assert.equal(m.state().width, 0);
    await m.pointer('pointermove', 250);
    await m.pointer('pointerup', 250);
    assert.deepEqual(m.state(), { open: true, width: 250, dragging: false });
    assert.deepEqual(m.saves, [250]);
  } finally {
    await m.close();
  }
});

test('cancel restores the initial width and ignores unrelated pointers and non-primary buttons', async () => {
  const m = await mount();
  try {
    await m.pointer('pointermove', 0);
    await m.pointer('pointerup', 0);
    await m.pointer('pointerdown', 288, 1, 1);
    assert.equal(m.state().dragging, false);
    await m.pointer('pointerdown', 288);
    await m.pointer('pointermove', 80, 2);
    await m.pointer('pointerup', 80, 2);
    assert.equal(m.state().width, 288);
    await m.pointer('pointermove', 80);
    assert.equal(m.handle().getAttribute('aria-valuetext'), 'Release to hide sidebar');
    await m.pointer('pointercancel', 80);
    await m.pointer('lostpointercapture', 80);
    assert.deepEqual(m.state(), { open: true, width: 288, dragging: false });
    assert.deepEqual(m.saves, []);
    await m.pointer('pointerdown', 288);
    await m.pointer('pointermove', 330);
    await m.pointer('lostpointercapture', 330);
    assert.deepEqual(m.saves, [330]);
  } finally {
    await m.close();
  }
});

test('cancel from an initially hidden sidebar retains its hidden state and saved width', async () => {
  const m = await mount(false);
  try {
    assert.equal(m.handle().style.left, '0px');
    await m.pointer('pointerdown', 0);
    await m.pointer('pointermove', 220);
    assert.deepEqual(m.state(), { open: false, width: 220, dragging: true });
    await m.pointer('pointercancel', 220);
    assert.deepEqual(m.state(), { open: false, width: 0, dragging: false });
    assert.deepEqual(m.saves, []);
  } finally {
    await m.close();
  }
});

test('the collapsed edge opens with ArrowRight and keyboard resize commits usable expanded widths', async () => {
  const m = await mount(false);
  try {
    await m.key('Escape');
    assert.deepEqual(m.saves, []);
    await m.key('ArrowRight');
    assert.deepEqual(m.state(), { open: true, width: 200, dragging: false });
    await m.key('Home');
    assert.equal(m.state().open, false);
    await m.key('End');
    assert.equal(m.state().open, true);
    assert.ok(m.state().width >= 200);
  } finally {
    await m.close();
  }
});

test('moves between frames set the width once, at the last position; a release drops a frame still waiting (#2049)', async () => {
  const m = await mount();
  const changes: number[] = [];
  try {
    await m.pointer('pointerdown', 288);
    const before = m.state().width;
    // dispatched without waiting for a frame, as a mouse fires several times between two repaints
    for (const x of [300, 320, 340])
      m.handle().dispatchEvent(new window.PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: x }) as any);
    assert.equal(m.state().width, before, 'nothing rendered between frames');
    await act(() => new Promise<void>((r) => setTimeout(r, 0)));
    changes.push(m.state().width);
    assert.deepEqual(changes, [340]);
    m.handle().dispatchEvent(new window.PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: 360 }) as any);
    await m.pointer('pointerup', 360);
    await act(() => new Promise<void>((r) => setTimeout(r, 0)));
    assert.deepEqual(m.state(), { open: true, width: 360, dragging: false }, 'the release commits the last position once');
    assert.deepEqual(m.saves, [360]);
  } finally {
    await m.close();
  }
});

test('a handle named for what it resizes says so in its words (MoMo’s rail, #4926)', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  const draw = (open: boolean, width: number) =>
    act(() =>
      root.render(
        createElement(SidebarResize, {
          name: 'MoMo sidebar',
          open,
          width,
          dragging: false,
          onWidthChange: () => {},
          onOpenChange: () => {},
          onDraggingChange: () => {},
          onSaveWidth: () => {},
        }),
      ),
    );
  const sep = () => host.querySelector('[role="separator"]')!;
  await draw(true, 220);
  assert.equal(sep().getAttribute('aria-label'), 'Resize MoMo sidebar');
  await draw(true, 50);
  assert.equal(sep().getAttribute('aria-valuetext'), 'Release to hide MoMo sidebar');
  await draw(false, 0);
  assert.equal(sep().getAttribute('aria-label'), 'Drag to open MoMo sidebar');
  assert.equal(sep().getAttribute('aria-valuetext'), 'MoMo sidebar hidden; drag right to open');
  await act(() => root.unmount());
  host.remove();
});
