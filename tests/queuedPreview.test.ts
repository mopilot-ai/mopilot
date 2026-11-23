// Queued preview focus waits for placement and respects retired owners and newer focus choices.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { QueuedPreview } from '../src/components/composer/QueuedPreview';
import { browserPopoverFocus } from './support/popover-focus.ts';

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement;
const originalFrame = globalThis.requestAnimationFrame;
const originalCancel = globalThis.cancelAnimationFrame;

async function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      h(
        'div',
        { className: 'queue-tray', 'data-queue-chat': 'chat' },
        h(QueuedPreview, { threadId: 'chat', label: 'Read the whole message', leaving: false, children: 'Read the whole message' }),
      ),
    ),
  );
  const trigger = host.querySelector<HTMLButtonElement>('.queue-text')!;
  trigger.getBoundingClientRect = () => new window.DOMRect(24, 200, 180, 30);
  trigger.focus();
  return trigger;
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  globalThis.requestAnimationFrame = originalFrame;
  globalThis.cancelAnimationFrame = originalCancel;
});

test('initial preview focus waits until Popover has made the layer visible', async (t) => {
  browserPopoverFocus(t);
  const trigger = await mount();
  await act(async () => trigger.click());
  assert.equal((document.querySelector('.popover-layer') as HTMLElement).style.visibility, 'visible');
  await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  assert.equal(document.activeElement, document.querySelector('.queue-preview-body'));
});

test('a cancelled placement frame cannot focus a retired preview or steal a replacement control', async () => {
  const trigger = await mount();
  const frames = new Map<number, FrameRequestCallback>();
  const cancelled: number[] = [];
  globalThis.requestAnimationFrame = (callback) => {
    const id = frames.size + 1;
    frames.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => {
    cancelled.push(id);
  };
  await act(async () => trigger.click());
  const oldFrames = [...frames];
  assert.equal(oldFrames.length, 1);
  await act(async () => root!.unmount());
  root = null;
  const replacement = document.createElement('input');
  document.body.append(replacement);
  try {
    replacement.focus();
    // A callback already queued before cancellation must still reject its retired ownership.
    for (const [id, callback] of oldFrames) {
      assert.ok(cancelled.includes(id));
      callback(0);
    }
    assert.equal(document.activeElement, replacement);
    assert.equal(document.querySelector('.queue-preview'), null);
  } finally {
    replacement.remove();
  }
});

test('a placement frame preserves newer focus while its preview remains mounted', async () => {
  const trigger = await mount();
  const frames: FrameRequestCallback[] = [];
  globalThis.requestAnimationFrame = (callback) => frames.push(callback);
  globalThis.cancelAnimationFrame = () => {};
  await act(async () => trigger.click());
  assert.equal(frames.length, 1);
  const replacement = document.createElement('input');
  document.body.append(replacement);
  try {
    replacement.focus();
    frames[0](0);
    assert.ok(document.querySelector('.queue-preview'));
    assert.equal(document.activeElement, replacement);
  } finally {
    replacement.remove();
  }
});
