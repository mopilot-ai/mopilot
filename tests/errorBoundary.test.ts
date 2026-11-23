// Render errors (src/components/ui/ErrorBoundary.tsx): reported, shown, and retried.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';

const reported: [unknown, any][] = [];
mock.module('../src/lib/telemetry.ts', { namedExports: { reportError: (e: unknown, extra: any) => reported.push([e, extra]) } });
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ErrorBoundary } = await import('../src/components/ui/ErrorBoundary.tsx');

let fail: unknown = null;
const Child = () => {
  if (fail) throw fail;
  return 'ok';
};

test('a labelled boundary shows the stack, reports it, and Try again re-renders', async (t) => {
  t.mock.method(console, 'error', () => {});
  fail = new Error('boom');
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(() => root.render(createElement(ErrorBoundary, { label: 'Thread' } as any, createElement(Child))));
  assert.equal(host.querySelector('.conn-error-title')!.textContent, 'Something went wrong in Thread');
  assert.match(host.querySelector('pre')!.textContent!, /^Error: boom/);
  assert.deepEqual(reported.at(-1), [fail, { kind: 'react', component: 'Thread' }]);
  fail = null;
  await act(() => (host.querySelector('button') as HTMLElement).click());
  assert.equal(host.textContent, 'ok');
  await act(() => root.unmount());
});

test('an unlabelled boundary names the component from the stack; a thrown value is shown as text', async (t) => {
  t.mock.method(console, 'error', () => {});
  fail = 'plain failure';
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(() => root.render(createElement(ErrorBoundary, null, createElement(Child))));
  assert.equal(host.querySelector('.conn-error-title')!.textContent, 'Something went wrong');
  assert.equal(host.querySelector('pre')!.textContent, 'plain failure');
  assert.match(reported.at(-1)![1].component, /Child/);
  await act(() => root.unmount());
  fail = null;
});

test('a missing component stack reports an empty component name', (t) => {
  t.mock.method(console, 'error', () => {});
  const b = new ErrorBoundary({ children: null });
  const e = new Error('x');
  b.componentDidCatch(e, { componentStack: null });
  assert.deepEqual(reported.at(-1), [e, { kind: 'react', component: '' }]);
});
