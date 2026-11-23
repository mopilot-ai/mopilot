// Image previews (src/components/ui/ImageLightbox.tsx): a thumbnail opens a lightbox; Escape, Close or the backdrop close it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';

const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ZoomableImage, ImageLightbox } = await import('../src/components/ui/ImageLightbox.tsx');
const { installNative } = await import('../src/lib/native.ts');
const { FileImagePreview } = await import('../src/components/panels/FileImagePreview.tsx');

test('a thumbnail opens the preview and each way of closing it works', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(() => root.render(createElement(ZoomableImage, { src: 'a.png', className: 'shot', title: 't' })));
  const img = host.querySelector('img')!;
  assert.equal(img.className, 'zoomable-image shot');
  assert.equal(img.getAttribute('alt'), '');
  assert.equal(img.getAttribute('aria-label'), 'Open image');
  assert.equal(img.getAttribute('title'), 't');
  const box = () => document.querySelector('.lightbox');
  await act(() => img.click());
  assert.equal((box()!.querySelector('.lightbox-image') as HTMLImageElement).getAttribute('src'), 'a.png');
  // other keys do nothing; Escape closes and stops there
  await act(() => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a' })));
  assert.ok(box());
  let reachedBubble = false;
  const bubble = () => {
    reachedBubble = true;
  };
  window.addEventListener('keydown', bubble);
  await act(() => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })));
  window.removeEventListener('keydown', bubble);
  assert.equal(box() === null, true);
  assert.equal(reachedBubble, false);
  // Close button
  await act(() => img.click());
  await act(() => (box()!.querySelector('.lightbox-close') as HTMLElement).click());
  assert.equal(box() === null, true);
  // a press on the picture keeps it; on the backdrop closes it
  await act(() => img.click());
  await act(() =>
    box()!
      .querySelector('.lightbox-image')!
      .dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }) as any),
  );
  assert.ok(box());
  await act(() => box()!.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }) as any));
  assert.equal(box() === null, true);
  await act(() => root.unmount());
});

test('the lightbox shows alt text and works without a thumbnail', async () => {
  const root = createRoot(document.createElement('div'));
  let closed = 0;
  await act(() => root.render(createElement(ImageLightbox, { src: 'b.png', alt: 'chart', onClose: () => closed++ })));
  assert.equal(document.querySelector('.lightbox-image')!.getAttribute('alt'), 'chart');
  await act(() => root.render(createElement(ZoomableImage, { src: 'c.png', alt: 'c' })));
  assert.equal(document.querySelector('.lightbox') === null, true);
  await act(() => root.unmount());
  assert.equal(closed, 0);
});

for (const key of ['Enter', ' ']) {
  test(`a thumbnail is keyboard-accessible and opens with ${JSON.stringify(key)}`, async (t) => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    t.after(async () => {
      await act(() => root.unmount());
      host.remove();
    });
    await act(() => root.render(createElement(ZoomableImage, { src: 'keyboard.png', alt: 'Diagram' })));
    const img = host.querySelector('img')!;
    assert.equal(img.tabIndex, 0);
    assert.equal(img.getAttribute('role'), 'button');
    assert.equal(img.getAttribute('aria-label'), 'Open image: Diagram');
    img.focus();
    assert.equal(document.activeElement === img, true);
    for (const options of [{ key: 'a' }, { key, repeat: true }, { key, isComposing: true }, { key, keyCode: 229 }]) {
      const event = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...options });
      if ('keyCode' in options) Object.defineProperty(event, 'keyCode', { value: options.keyCode });
      await act(() => img.dispatchEvent(event as unknown as Event));
      assert.ok(!document.querySelector('.lightbox'));
    }
    const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    await act(() => img.dispatchEvent(event as unknown as Event));
    assert.equal(event.defaultPrevented, true);
    assert.equal(document.querySelector('.lightbox-image')?.getAttribute('src'), 'keyboard.png');
    await act(() => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })));
    assert.ok(!document.querySelector('.lightbox'));
  });
}

test('thumbnail keyboard handling preserves an explicitly consumed key and accessibility props', async (t) => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(() => root.unmount());
    host.remove();
  });
  let handled = 0;
  await act(() =>
    root.render(
      createElement(ZoomableImage, {
        src: 'custom.png',
        tabIndex: 3,
        'aria-label': 'Open custom preview',
        onKeyDown: (event) => {
          handled++;
          event.preventDefault();
        },
      }),
    ),
  );
  const img = host.querySelector('img')!;
  await act(() =>
    img.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }) as unknown as Event),
  );
  assert.equal(handled, 1);
  assert.ok(!document.querySelector('.lightbox'));
  assert.equal(img.tabIndex, 3);
  assert.equal(img.getAttribute('aria-label'), 'Open custom preview');
});

test('image preview focuses Close, keeps Tab inside, and restores the thumbnail after dismissal', async (t) => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(() => root.unmount());
    host.remove();
  });
  await act(() => root.render(createElement(ZoomableImage, { src: 'focus.png', alt: 'Chart' })));
  const thumbnail = host.querySelector('img')!;
  thumbnail.focus();
  await act(() => thumbnail.click());
  const close = document.querySelector('.lightbox-close') as HTMLButtonElement;
  assert.equal(document.activeElement === close, true);
  assert.equal(document.querySelector('.lightbox')!.getAttribute('role'), 'dialog');
  assert.equal(document.querySelector('.lightbox')!.getAttribute('aria-modal'), 'true');
  assert.equal(document.querySelector('.lightbox')!.getAttribute('aria-label'), 'Image preview: Chart');
  for (const shiftKey of [false, true]) {
    const event = new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
    await act(() => close.dispatchEvent(event as unknown as Event));
    assert.equal(event.defaultPrevented, true);
    assert.equal(document.activeElement === close, true);
  }
  for (const legacy of [false, true]) {
    const event = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: !legacy });
    if (legacy) Object.defineProperty(event, 'keyCode', { value: 229 });
    await act(() => close.dispatchEvent(event as unknown as Event));
    assert.ok(document.querySelector('.lightbox'));
  }
  await act(() => close.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as Event));
  assert.ok(!document.querySelector('.lightbox'));
  assert.equal(document.activeElement === thumbnail, true);
});

test("a double-click opens the preview and leaves it open: the second press doesn't count as a backdrop press", async (t) => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(() => root.unmount());
    host.remove();
  });
  await act(() => root.render(createElement(ZoomableImage, { src: 'double.png' })));
  const img = host.querySelector('img')!;
  const box = () => document.querySelector('.lightbox');
  // the browser's double-click: press, click (opens), then a second press counted 2 on what is now the backdrop
  await act(() => img.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, detail: 1 }) as any));
  await act(() => img.click());
  await act(() => box()!.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, detail: 2 }) as any));
  assert.ok(box());
  // a later single press on the backdrop still closes it
  await act(() => box()!.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, detail: 1 }) as any));
  assert.equal(box(), null);
});

test("a picture with a file asks main for its menu on right-click; one without leaves the press to main's own menu", async (t) => {
  const asked: unknown[] = [];
  let fail = false;
  const previous = installNative({
    menu: {
      image: async (image: unknown) => {
        asked.push(image);
        if (fail) throw new Error('menu gone');
      },
    },
  } as any);
  t.after(() => installNative(previous));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(() => root.unmount());
    host.remove();
  });
  const rightClick = (el: Element) => {
    const event = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    el.dispatchEvent(event as any);
    return event.defaultPrevented;
  };
  await act(() => root.render(createElement(ZoomableImage, { src: 'web.png' })));
  assert.equal(rightClick(host.querySelector('img')!), false);
  assert.deepEqual(asked, []);

  await act(() => root.render(createElement(ZoomableImage, { src: 'data:image/png;base64,AA==', path: '/pics/shot.png' })));
  assert.equal(rightClick(host.querySelector('img')!), true);
  await act(() => host.querySelector('img')!.click());
  // the open preview's picture has the same menu; a failed ask is only noted
  fail = true;
  assert.equal(rightClick(document.querySelector('.lightbox-image')!), true);
  await act(async () => {});
  assert.deepEqual(asked, [
    { src: 'data:image/png;base64,AA==', path: '/pics/shot.png' },
    { src: 'data:image/png;base64,AA==', path: '/pics/shot.png' },
  ]);
});

test("the Files pane's image preview hands its file to the picture's right-click menu", async (t) => {
  const asked: unknown[] = [];
  const previous = installNative({ menu: { image: async (image: unknown) => void asked.push(image) } } as any);
  t.after(() => installNative(previous));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(() => root.unmount());
    host.remove();
  });
  const noop = () => {};
  await act(() =>
    root.render(createElement(FileImagePreview, { path: '/pics/a b.png', onRetry: noop, onReady: noop, onFailure: noop } as any)),
  );
  host.querySelector('img')!.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }) as any);
  assert.deepEqual(asked, [{ src: 'codex-asset:///pics/a%20b.png', path: '/pics/a b.png' }]);
});
