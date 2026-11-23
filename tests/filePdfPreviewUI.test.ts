// PDF controls and cancellable task ownership cover every load/render boundary and pending replacement.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import './support/dom.ts';
import { render } from './support/shell-panels-kit.ts';
import { deferred } from './support/async-scenarios.ts';

let destroyed = 0,
  cancelled = 0,
  disconnected = 0,
  retries = 0,
  measuredWidth = 600;
const observers: (() => void)[] = [];
globalThis.ResizeObserver = class {
  constructor(callback: () => void) {
    observers.push(callback);
  }
  observe() {}
  disconnect() {
    disconnected++;
  }
  unobserve() {}
} as any;
Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', {
  get() {
    return measuredWidth;
  },
  configurable: true,
});
mock.method(console, 'debug', () => {});
let getText = async (): Promise<any> => ({ items: [{ str: 'PDF content' }, {}] });
let renderPage = () => ({
  promise: Promise.resolve(),
  cancel: () => {
    cancelled++;
  },
});
const page = {
  getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
  render: () => renderPage(),
  getTextContent: () => getText(),
};
let getPage = async (_n: number): Promise<any> => page;
const doc = { numPages: 2, getPage: (n: number) => getPage(n) };
const task = (promise = Promise.resolve(doc), fails = false) => ({
  promise,
  destroy: async () => {
    destroyed++;
    if (fails) throw Error('cleanup failed');
  },
});
let open = async (_data: Uint8Array, _signal: AbortSignal): Promise<any> => task();
mock.module('../src/lib/previewPdf.ts', {
  namedExports: { openPreviewPdf: (data: Uint8Array, signal: AbortSignal) => open(data, signal) },
});
const { createElement: h, act, StrictMode } = await import('react');
const { FilePdfPreview } = await import('../src/components/panels/FilePdfPreview.tsx');
const input = new Uint8Array([1]);
const view = (data = input) =>
  h(FilePdfPreview, {
    data,
    onRetry: () => {
      retries++;
    },
  });
const click = (host: HTMLElement, label: string) =>
  act(() => {
    host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click();
  });
const flush = () =>
  act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });
const reset = () => {
  open = async () => task();
  getPage = async () => page;
  renderPage = () => ({
    promise: Promise.resolve(),
    cancel: () => {
      cancelled++;
    },
  });
  getText = async () => ({ items: [{ str: 'PDF content' }, {}] });
  measuredWidth = 600;
};

test('PDF renders accessible page text, navigation, fit width and zoom; resizing retires the old render', async () => {
  reset();
  const r = await render(view());
  await flush();
  try {
    assert.match(r.host.textContent ?? '', /Page 1 of 2/);
    assert.match(r.host.textContent ?? '', /PDF content/);
    assert.equal(r.host.querySelector<HTMLCanvasElement>('canvas')?.width, 576);
    assert.equal(r.host.querySelector<HTMLButtonElement>('button[aria-label="Previous page"]')?.disabled, true);
    await click(r.host, 'Next page');
    await flush();
    assert.match(r.host.textContent ?? '', /Page 2 of 2/);
    assert.equal(r.host.querySelector<HTMLButtonElement>('button[aria-label="Next page"]')?.disabled, true);
    await click(r.host, 'Previous page');
    await flush();
    assert.match(r.host.textContent ?? '', /Page 1 of 2/);
    const select = r.host.querySelector('select')!;
    await act(() => {
      select.value = '2';
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await flush();
    assert.equal(r.host.querySelector<HTMLCanvasElement>('canvas')?.width, 1152);
    const before = cancelled;
    await act(() => {
      measuredWidth = 400;
      for (const observe of observers) observe();
    });
    await flush();
    assert.ok(cancelled > before);
    assert.equal(r.host.querySelector<HTMLCanvasElement>('canvas')?.width, 752);
  } finally {
    await r.unmount();
    assert.ok(disconnected > 0);
  }
});

test('a zero-width initial pane still renders with a bounded default width', async () => {
  reset();
  measuredWidth = 0;
  const r = await render(view());
  await flush();
  try {
    assert.ok(r.host.querySelector('canvas'));
  } finally {
    await r.unmount();
  }
});

for (const stage of ['open', 'document', 'page', 'render', 'text'] as const)
  test(`a PDF ${stage} failure ends loading with a retry`, async () => {
    reset();
    if (stage === 'open')
      open = async () => {
        throw Error('open failed');
      };
    if (stage === 'document') open = async () => task(Promise.reject(Error('document failed')));
    if (stage === 'page')
      getPage = async () => {
        throw Error('page failed');
      };
    if (stage === 'render') renderPage = () => ({ promise: Promise.reject(Error('render failed')), cancel: () => {} });
    if (stage === 'text')
      getText = async () => {
        throw Error('text failed');
      };
    const r = await render(view());
    await flush();
    try {
      assert.ok(r.host.querySelector('[role="alert"]'));
      const before = retries;
      await click(r.host, 'Retry file preview');
      assert.equal(retries, before + 1);
    } finally {
      await r.unmount();
    }
  });

for (const fails of [false, true])
  test(`a task created just after disposal is destroyed with ${fails ? 'failed' : 'successful'} cleanup`, async () => {
    reset();
    const pending = deferred<any>();
    open = () => pending.promise;
    const r = await render(view());
    await flush();
    await r.unmount();
    const before = destroyed;
    await act(async () => pending.resolve(task(Promise.resolve(doc), fails)));
    await flush();
    assert.equal(destroyed, before + 1);
  });

for (const rejection of [false, true])
  test(`a retired PDF document ${rejection ? 'rejection' : 'success'} cannot finish a pending replacement`, async () => {
    reset();
    const old = deferred<any>(),
      current = deferred<any>();
    let calls = 0;
    open = async () => task(calls++ === 0 ? old.promise : current.promise, true);
    const r = await render(view());
    await flush();
    try {
      await r.rerender(view(new Uint8Array([2])));
      await flush();
      await act(async () => {
        if (rejection) old.reject(Error('old'));
        else old.resolve(doc);
      });
      assert.ok(r.host.querySelector('[role="status"]'));
      assert.equal(r.host.querySelector('[role="alert"]'), null);
      await act(async () => current.resolve(doc));
      await flush();
      assert.match(r.host.textContent ?? '', /PDF content/);
    } finally {
      await r.unmount();
    }
  });

for (const stage of ['page', 'render', 'text'] as const)
  for (const rejection of [false, true])
    test(`PDF ${stage} ${rejection ? 'failure' : 'success'} after disposal publishes nothing`, async () => {
      reset();
      const gate = deferred<any>();
      if (stage === 'page') getPage = () => gate.promise;
      if (stage === 'render')
        renderPage = () => ({
          promise: gate.promise,
          cancel: () => {
            cancelled++;
          },
        });
      if (stage === 'text') getText = () => gate.promise;
      const r = await render(view());
      await flush();
      await r.unmount();
      await act(async () => {
        if (rejection) gate.reject(Error('disposed'));
        else gate.resolve(stage === 'page' ? page : stage === 'text' ? { items: [] } : undefined);
      });
      assert.equal(r.host.querySelector('canvas'), null);
    });

test('Strict Mode retires its first lazy task and opens a working replacement', async () => {
  reset();
  const r = await render(h(StrictMode, null, view()));
  await flush();
  try {
    assert.match(r.host.textContent ?? '', /PDF content/);
  } finally {
    await r.unmount();
  }
});

test('new PDF data immediately retires a displayed page and recovers from an earlier failure', async () => {
  reset();
  const r = await render(view());
  await flush();
  try {
    const pending = deferred<any>();
    open = async () => task(pending.promise);
    await r.rerender(view(new Uint8Array([3])));
    await flush();
    assert.ok(r.host.querySelector('[role="status"]'));
    assert.equal(r.host.querySelector('canvas'), null);
    await act(async () => pending.reject(Error('bad replacement')));
    await flush();
    assert.ok(r.host.querySelector('[role="alert"]'));
    open = async () => task();
    await r.rerender(view(new Uint8Array([4])));
    await flush();
    assert.match(r.host.textContent ?? '', /PDF content/);
  } finally {
    await r.unmount();
  }
});

test('PDF rendering reserves scrollbar space so loading cannot repeatedly invalidate measured width', async () => {
  reset();
  const style = document.createElement('style');
  style.textContent = fs.readFileSync(new URL('../src/styles/app/file-previews.css', import.meta.url), 'utf8');
  document.head.append(style);
  const r = await render(view());
  await flush();
  try {
    assert.equal(window.getComputedStyle(r.host.querySelector('.pdf-page-scroll')!).getPropertyValue('scrollbar-gutter'), 'stable');
  } finally {
    await r.unmount();
    style.remove();
  }
});

test('a page-render failure is recoverable for direct PDF callers without readiness callbacks', async () => {
  reset();
  getPage = async () => {
    throw Error('page unavailable');
  };
  const v = await render(view());
  await flush();
  assert.match(v.host.textContent!, /Could not preview this file/);
  await click(v.host, 'Retry file preview');
  await v.unmount();
});

test('a page-render failure notifies readiness owners so a staged PDF cannot replace the readable generation', async () => {
  reset();
  const pending = deferred<any>();
  getPage = () => pending.promise;
  let ready = 0,
    failed = 0;
  const v = await render(
    h(FilePdfPreview, {
      data: input,
      onRetry: () => {},
      onReady: () => {
        ready++;
      },
      onFailure: () => {
        failed++;
      },
    }),
  );
  await flush();
  assert.equal(ready, 0);
  assert.equal(failed, 0);
  await act(() => pending.reject(Error('page unavailable')));
  await flush();
  assert.equal(ready, 0);
  assert.equal(failed, 1);
  assert.match(v.host.textContent!, /Could not preview this file/);
  await v.unmount();
});
