// Local image file previews exercise the shared Files and message-link viewer, including loader ownership and retry.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { render, markdownStub } from './support/shell-panels-kit.ts';
import { deferred } from './support/async-scenarios.ts';
import { popoverStubs } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';

const reads: string[] = [];
let readText = async (_p: string): Promise<string | null> => null;
installNativeStub({
  fs: {
    readText: (p: string) => {
      reads.push(p);
      return readText(p);
    },
  },
});
mock.module('../src/session/open.ts', { namedExports: { openPath: () => {}, revealPath: () => {} } });
mock.module('../src/session/clipboard.ts', { namedExports: { copyText: () => {} } });
mock.module('../src/components/ui/Popover.tsx', { namedExports: popoverStubs() });
mock.module('../src/components/markdown/Markdown.tsx', { namedExports: markdownStub({ dark: false }) });
mock.module('../src/lib/highlight.ts', { namedExports: { highlight: async () => '', langFromPath: () => 'text' } });
const { createElement: h, act } = await import('react');
mock.module('../src/components/panels/DiffPanel.tsx', { namedExports: { LangIcon: () => null } });
const { FilePreview } = await import('../src/components/panels/FilesPanel.tsx');
const preview = (path: string) => h(FilePreview, { path, cwd: '/repo' });
const fire = async (image: Element, kind: string) =>
  act(() => {
    image.dispatchEvent(new window.Event(kind));
  });

test('opening a PNG file renders an image without reading binary bytes as text', async () => {
  reads.length = 0;
  const r = await render(h(FilePreview, { path: '/repo/cover.png', cwd: '/repo' }));
  try {
    const image = r.host.querySelector('.file-image-preview img');
    assert.ok(image, 'image files must reach the image viewer');
    assert.equal(image.getAttribute('src'), 'codex-asset:///repo/cover.png');
    assert.deepEqual(reads, []);
    await fire(image, 'load');
    assert.equal(r.host.querySelector('[role="alert"]'), null);
  } finally {
    await r.unmount();
  }
});

test('BMP and AVIF files use the image preview rather than text decoding', async () => {
  const r = await render(preview('/repo/cover.bmp'));
  try {
    assert.ok(r.host.querySelector('.file-image-preview img'));
    await r.rerender(preview('/repo/cover.avif'));
    assert.ok(r.host.querySelector('.file-image-preview img'));
  } finally {
    await r.unmount();
  }
});

test('all image extensions served by the local protocol bypass text; literal paths are encoded once', async () => {
  reads.length = 0;
  const r = await render(preview('/repo/封面 #1? 100%.PNG'));
  try {
    assert.equal(r.host.querySelector('img')?.getAttribute('src'), 'codex-asset:///repo/%E5%B0%81%E9%9D%A2%20%231%3F%20100%25.PNG');
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'JpEg']) {
      await r.rerender(preview(`/repo/cover.${ext}`));
      assert.ok(r.host.querySelector('.file-image-preview img'), ext);
      assert.equal(r.host.querySelector('.file-preview-toggle'), null);
      await fire(r.host.querySelector('img')!, 'load');
      assert.equal(r.host.querySelector('[role="status"]'), null);
    }
    assert.deepEqual(reads, []);
    await r.rerender(preview('/repo/cover.png.txt'));
    assert.equal(r.host.querySelector('.file-image-preview'), null);
    assert.deepEqual(reads, ['/repo/cover.png.txt']);
  } finally {
    await r.unmount();
  }
});

test('broken images show a retry and a fresh attempt can load the same path', async () => {
  const r = await render(preview('/repo/broken.png'));
  try {
    const first = r.host.querySelector('img')!;
    assert.ok(r.host.querySelector('[role="status"]'));
    await fire(first, 'error');
    assert.match(r.host.querySelector('[role="alert"]')?.textContent ?? '', /Could not load image/);
    assert.equal(r.host.querySelector('img'), null);
    await act(() => r.host.querySelector<HTMLButtonElement>('button[aria-label="Retry image preview"]')!.click());
    const retry = r.host.querySelector('img')!;
    assert.ok(retry);
    assert.notEqual(first, retry);
    await fire(first, 'load');
    assert.ok(r.host.querySelector('[role="status"]'), 'an obsolete load cannot finish the retry');
    await fire(first, 'error');
    assert.equal(r.host.querySelector('[role="alert"]'), null);
    await fire(retry, 'load');
    assert.equal(r.host.querySelector('[role="status"]'), null);
    assert.equal(r.host.querySelector('[role="alert"]'), null);
  } finally {
    await r.unmount();
  }
});

test('Windows image paths retain drive identity and escape reserved filename characters', async () => {
  const r = await render(preview('C:\\pictures\\封面 #1.png'));
  try {
    const image = r.host.querySelector('img')!;
    assert.equal(image.getAttribute('src'), 'codex-asset:///C:/pictures/%E5%B0%81%E9%9D%A2%20%231.png');
    assert.equal(image.getAttribute('alt'), '封面 #1.png');
    await fire(image, 'load');
  } finally {
    await r.unmount();
  }
});

test('switching files retires pending loads, failures and an open lightbox', async () => {
  const r = await render(preview('/repo/first.png'));
  try {
    const old = r.host.querySelector('img')!;
    await r.rerender(preview('/repo/second.jpg'));
    const current = r.host.querySelector('img')!;
    await fire(old, 'load');
    await fire(old, 'error');
    assert.ok(r.host.querySelector('[role="status"]'));
    assert.equal(r.host.querySelector('[role="alert"]'), null);
    await fire(current, 'load');
    await act(() => (current as HTMLElement).click());
    assert.ok(document.querySelector('[role="dialog"]'));
    await r.rerender(preview('/repo/third.webp'));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await fire(r.host.querySelector('img')!, 'error');
    await r.rerender(preview('/repo/fourth.svg'));
    assert.equal(r.host.querySelector('[role="alert"]'), null);
    await fire(r.host.querySelector('img')!, 'load');
  } finally {
    await r.unmount();
  }
});

test('image preview uses the existing keyboard lightbox and closes on Escape', async () => {
  const r = await render(preview('/repo/cover.png'));
  try {
    const image = r.host.querySelector('img')!;
    await fire(image, 'load');
    await act(() => image.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    const dialog = document.querySelector('[role="dialog"]')!;
    assert.equal(dialog.querySelector('img')?.getAttribute('src'), image.getAttribute('src'));
    assert.equal(dialog.getAttribute('aria-label'), 'Image preview: cover.png');
    await act(() => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    assert.equal(document.querySelector('[role="dialog"]'), null);
  } finally {
    await r.unmount();
  }
});

for (const reject of [false, true])
  test(`a retired text ${reject ? 'failure' : 'read'} cannot replace an image preview`, async () => {
    const pending = deferred<string | null>();
    readText = () => pending.promise;
    const r = await render(preview('/repo/pending.txt'));
    try {
      await r.rerender(preview('/repo/new.png'));
      await act(async () => {
        if (reject) pending.reject(new Error('obsolete'));
        else pending.resolve('old text');
      });
      assert.ok(r.host.querySelector('.file-image-preview img'));
      assert.equal(r.host.querySelector('[role="alert"]'), null);
      readText = async () => null;
      await r.rerender(preview('/repo/missing.txt'));
      assert.match(r.host.querySelector('[role="alert"]')?.textContent ?? '', /can’t be previewed/);
    } finally {
      await r.unmount();
      readText = async () => null;
    }
  });

test('Strict Mode remount and disposal leave no live image loader or lightbox', async () => {
  const { StrictMode } = await import('react');
  const r = await render(h(StrictMode, null, preview('/repo/strict.png')));
  const image = r.host.querySelector('img')!;
  await fire(image, 'load');
  await act(() => (image as HTMLElement).click());
  assert.ok(document.querySelector('[role="dialog"]'));
  await r.unmount();
  await fire(image, 'error');
  await fire(image, 'load');
  assert.equal(document.querySelector('[role="dialog"]'), null);
});
