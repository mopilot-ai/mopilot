// Real file viewers stage image/media/PDF/HTML replacements and retain valid source across failed or reversed reads.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { FilePreview, createElement as h, act, disk, fx, click, setFileDraft, calls } from './support/files-ui-kit.ts';
import { render } from './support/shell-panels-kit.ts';
import { deferred } from './support/async-scenarios.ts';
import { native } from '../src/lib/native.ts';

const view = (path: string, revision?: string) => h(FilePreview, { path, cwd: '/repo', revision });
const event = (element: Element, name: string) => act(() => element.dispatchEvent(new window.Event(name)));
const shown = (host: HTMLElement) => host.querySelector('.preview-generation:not([hidden])')!;
Object.defineProperty(window.HTMLMediaElement.prototype, 'pause', { value() {}, configurable: true });
Object.defineProperty(window.HTMLMediaElement.prototype, 'load', { value() {}, configurable: true });

test('a refreshed image retains its decoded predecessor until load; a failed replacement and retry keep the old image', async () => {
  const r = await render(view('/repo/image.png', 'one'));
  const original = r.host.querySelector('img')!;
  await event(original, 'load');
  await r.rerender(view('/repo/image.png', 'two'));
  assert.equal(shown(r.host).querySelector('img'), original);
  const next = r.host.querySelector('.preview-generation[hidden] img')!;
  assert.notEqual(next.getAttribute('src'), original.getAttribute('src'));
  await event(next, 'error');
  assert.equal(shown(r.host).querySelector('img'), original);
  assert.match(r.host.textContent!, /last readable version/);
  await click(r.host.querySelector('.preview-error')!.querySelector('button')!);
  const retry = r.host.querySelector('.preview-generation[hidden] img')!;
  await event(retry, 'load');
  assert.equal(shown(r.host).querySelector('img'), retry);
  await r.unmount();
});

test('video replacement waits for decoded data; valid metadata followed by a decoder error retains playback', async () => {
  const r = await render(view('/repo/movie.mp4', 'one'));
  const original = r.host.querySelector('video')!;
  await event(original, 'loadeddata');
  await r.rerender(view('/repo/movie.mp4', 'two'));
  assert.equal(shown(r.host).querySelector('video'), original);
  const next = r.host.querySelector('.preview-generation[hidden] video')!;
  await event(next, 'loadedmetadata');
  assert.equal(shown(r.host).querySelector('video'), original);
  await event(next, 'error');
  assert.equal(shown(r.host).querySelector('video'), original);
  await click(r.host.querySelector('.preview-error')!.querySelector('button')!);
  const retry = r.host.querySelector('.preview-generation[hidden] video')!;
  await event(retry, 'loadeddata');
  assert.equal(shown(r.host).querySelector('video'), retry);
  assert.equal(original.getAttribute('src'), null, 'retired playback resources are released');
  await r.unmount();
});

test('HTML replacement freezes the old document until its replacement frame loads', async () => {
  disk['/repo/site.html'] = '<h1>First</h1>';
  const r = await render(view('/repo/site.html', 'one'));
  const original = r.host.querySelector('iframe')!;
  await event(original, 'load');
  disk['/repo/site.html'] = '<h1>Second</h1>';
  const read = deferred<void>();
  fx.readGate = read.promise;
  await r.rerender(view('/repo/site.html', 'two'));
  assert.equal(shown(r.host).querySelector('iframe'), original);
  assert.match(original.srcdoc, /First/);
  await act(() => read.resolve());
  const next = r.host.querySelector('iframe:last-child')!;
  assert.match(next.getAttribute('srcdoc')!, /Second/);
  await event(next, 'load');
  assert.equal(shown(r.host).querySelector('iframe'), next);
  await act(() => window.dispatchEvent(new window.Event('focus')));
  assert.equal(shown(r.host).querySelector('iframe'), next, 'a poll never restores an obsolete preview revision');
  assert.equal(r.host.querySelectorAll('.preview-generation').length, 1);
  await r.unmount();
});

test('explicit same-text HTML refresh stages a new document after the read, preserving the displayed frame while pending', async () => {
  disk['/repo/site.html'] = '<h1>Unchanged content</h1>';
  const r = await render(view('/repo/site.html'));
  const original = r.host.querySelector('iframe')!;
  await event(original, 'load');
  const read = deferred<void>();
  fx.readGate = read.promise;
  await click(r.host.querySelector('[aria-label="Refresh preview"]')!);
  assert.equal(shown(r.host).querySelector('iframe'), original);
  await act(() => read.resolve());
  const next = r.host.querySelector('iframe:last-child')!;
  assert.notEqual(next, original);
  assert.match(next.getAttribute('srcdoc')!, /Unchanged content/);
  await event(next, 'load');
  assert.equal(shown(r.host).querySelector('iframe'), next);
  await r.unmount();
});

let pdfRead = async () => ({ kind: 'binary' as const, data: new Uint8Array([1]) });
(native.fs as any).readPreview = () => pdfRead();
let pdfOpen = async (data: Uint8Array): Promise<any> => ({
  promise: Promise.resolve({
    numPages: data[0],
    getPage: async () => ({
      getViewport: () => ({ width: 600, height: 800 }),
      render: () => ({ promise: Promise.resolve(), cancel() {} }),
      getTextContent: async () => ({ items: [{ str: `PDF version ${data[0]}` }] }),
    }),
  }),
  destroy: async () => {},
});
mock.module('../src/lib/previewPdf.ts', { namedExports: { openPreviewPdf: (data: Uint8Array) => pdfOpen(data) } });
const flush = () =>
  act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });

test('PDF replacement waits through binary read, document decode and page rendering, and preserves a valid document on failure', async () => {
  const r = await render(view('/repo/report.pdf', 'one'));
  await flush();
  const original = shown(r.host).querySelector('canvas')!;
  assert.match(shown(r.host).textContent!, /PDF version 1/);
  const second = deferred<any>();
  pdfRead = () => second.promise;
  await r.rerender(view('/repo/report.pdf', 'two'));
  assert.equal(shown(r.host).querySelector('canvas'), original);
  const decode = deferred<any>();
  const originalOpen = pdfOpen;
  pdfOpen = () => decode.promise;
  await act(() => second.resolve({ kind: 'binary', data: new Uint8Array([2]) }));
  assert.equal(shown(r.host).querySelector('canvas'), original);
  await act(() => decode.reject(Error('damaged document')));
  await flush();
  assert.equal(shown(r.host).querySelector('canvas'), original);
  assert.match(r.host.textContent!, /last readable version/);
  pdfOpen = originalOpen;
  pdfRead = async () => ({ kind: 'binary', data: new Uint8Array([3]) });
  await click(r.host.querySelector('.preview-error button')!);
  await flush();
  assert.match(shown(r.host).textContent!, /PDF version 3/);
  await r.unmount();
});

test('failed and invalid rereads keep source and drafts; explicit recovery clears the error', async () => {
  disk['/repo/a.ts'] = 'readable';
  const r = await render(view('/repo/a.ts', 'one'));
  await act(() => setFileDraft('/repo/a.ts', 'readable', 'my draft'));
  for (const bad of ['throw', 'binary\0', 'x'.repeat(400_001)]) {
    disk['/repo/a.ts'] = bad;
    await r.rerender(view('/repo/a.ts', bad.slice(0, 10)));
    assert.match(r.host.textContent!, /last readable version/);
    assert.equal((r.host.querySelector('textarea') as HTMLTextAreaElement).value, 'my draft');
  }
  delete disk['/repo/a.ts'];
  await r.rerender(view('/repo/a.ts', 'missing'));
  assert.match(r.host.textContent!, /last readable version/);
  disk['/repo/a.ts'] = 'recovered';
  await click(r.host.querySelector('[aria-label="Retry file preview"]')!);
  assert.equal(r.host.querySelector('.preview-error'), null);
  assert.ok(r.host.querySelector('.file-stale'));
  await r.unmount();
});

test('a late obsolete text read cannot overwrite a newer explicit revision, and disposal retires reads', async (t) => {
  const old = deferred<string>();
  const read = mock.method(native.fs, 'readText', () => old.promise);
  const r = await render(view('/repo/a.ts', 'old'));
  read.mock.mockImplementation(async () => 'newest');
  await r.rerender(view('/repo/a.ts', 'new'));
  await act(() => old.resolve('obsolete'));
  assert.equal(r.host.querySelector('.file-editor-code')?.textContent, 'newest');
  const late = deferred<string>();
  read.mock.mockImplementation(() => late.promise);
  await r.rerender(view('/repo/a.ts', 'pending'));
  await r.unmount();
  await act(() => late.resolve('after disposal'));
  t.after(() => read.mock.restore());
});

test('polling waits for an in-flight read rather than starving it with repeated replacements', async () => {
  const pending = deferred<void>();
  fx.readGate = pending.promise;
  const r = await render(view('/repo/a.ts'));
  disk['/repo/a.ts'] = 'finished';
  await act(async () => {
    window.dispatchEvent(new window.Event('focus'));
    pending.resolve();
  });
  assert.equal(r.host.querySelector('.file-editor-code')?.textContent, 'finished');
  await r.unmount();
});

test('a save that completes after its view closes never starts another file read', async (t) => {
  const wait = deferred<void>();
  const write = mock.method(native.fs, 'writeText', async (path: string, text: string) => {
    await wait.promise;
    disk[path] = text;
    return { ok: true };
  });
  t.after(() => write.mock.restore());
  disk['/repo/a.ts'] = 'base';
  const r = await render(view('/repo/a.ts', 'one'));
  await act(() => setFileDraft('/repo/a.ts', 'base', 'saved'));
  await click(r.host.querySelector('.btn-pill.primary')!);
  const reads = calls.filter((c) => c[0] === 'readText').length;
  await r.unmount();
  await act(() => wait.resolve());
  assert.equal(calls.filter((c) => c[0] === 'readText').length, reads);
});
