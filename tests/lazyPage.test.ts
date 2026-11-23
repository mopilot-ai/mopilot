// src/lib/lazyPage.tsx: a code-split page renders its export once the chunk loads, and a chunk that fails to load shows a retry card (and reports it) instead of blanking the shell.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';

const reported: unknown[][] = [];
mock.module('../src/lib/telemetry.ts', { namedExports: { reportError: (...a: unknown[]) => reported.push(a) } });
const { createElement: h, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { lazyPage } = await import('../src/lib/lazyPage.tsx');

const mount = async (el: any) => {
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as any);
  await act(async () => root.render(el));
  return { host, root };
};

test('the page shows nothing while its chunk loads, then the picked export with its props', async () => {
  let release!: (m: unknown) => void;
  const Page = lazyPage(
    'Demo',
    () => new Promise<any>((r) => (release = r)),
    (m) => m.Demo,
  );
  const { host, root } = await mount(h(Page as any, { name: 'x' }));
  assert.equal(host.textContent, '');
  await act(async () => release({ Demo: ({ name }: { name: string }) => h('p', null, `hello ${name}`) }));
  assert.equal(host.textContent, 'hello x');
  await act(async () => root.unmount());
});

test('a failed chunk load shows a retry card and reports it; Try again imports once more and shows the page', async () => {
  let attempts = 0;
  const Page = lazyPage(
    'Demo page',
    async () => {
      if (++attempts === 1) throw new Error('chunk 404');
      return { Demo: () => h('p', null, 'loaded') };
    },
    (m: any) => m.Demo,
  );
  const quiet = mock.method(console, 'error', () => {});
  const { host, root } = await mount(h(Page, {}));
  quiet.mock.restore();
  assert.match(host.textContent ?? '', /Couldn't load Demo page/);
  assert.equal((reported[0][1] as any).kind, 'chunk-load');
  assert.equal((reported[0][1] as any).component, 'Demo page');
  await act(async () => (host.querySelector('button') as any).click());
  assert.equal(host.textContent, 'loaded');
  assert.equal(attempts, 2);
  await act(async () => root.unmount());
});
