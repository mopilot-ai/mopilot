// Preview generations preserve readable content through pending, failed, superseded and retried decodes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h, act } from 'react';
import { render } from './support/shell-panels-kit.ts';
import { PreviewSwap, type PreviewReady } from '../src/components/panels/PreviewSwap.tsx';

test('only the latest successful decoder can replace the visible version; failures retain it and Retry owns a fresh attempt', async () => {
  const callbacks = new Map<number, PreviewReady>();
  const view = (value: string) =>
    h(PreviewSwap, {
      value,
      children: (g: any) => {
        callbacks.set(g.id, g);
        return h('p', { 'data-generation': g.id }, g.value);
      },
    });
  const r = await render(view('first'));
  await act(() => callbacks.get(0)!.onReady!());
  const shown = () => r.host.querySelector('.preview-generation:not([hidden])')!.textContent;
  await r.rerender(view('second'));
  assert.equal(shown(), 'first');
  const second = callbacks.get(1)!;
  await r.rerender(view('third'));
  await act(() => {
    second.onReady!();
    second.onFailure!();
  });
  assert.equal(shown(), 'first');
  assert.equal(r.host.querySelector('[role="alert"]'), null);
  await act(() => callbacks.get(2)!.onFailure!());
  assert.match(r.host.textContent!, /Showing its last readable version/);
  assert.equal(shown(), 'first');
  await act(() => callbacks.get(2)!.onReady!());
  assert.equal(shown(), 'first', 'failed attempt cannot revive itself');
  await act(() => r.host.querySelector<HTMLButtonElement>('[aria-label="Retry file preview"]')!.click());
  await act(() => callbacks.get(3)!.onReady!());
  assert.equal(shown(), 'third');
  assert.equal(r.host.querySelectorAll('.preview-generation').length, 1);
  const retired = callbacks.get(3)!;
  await r.unmount();
  await act(() => {
    retired.onReady!();
    retired.onFailure!();
  });
});

test('an initially failed preview can retry before any version was ready; repeated revision and content retain identity', async () => {
  let callback!: PreviewReady;
  const revisions: (string | undefined)[] = [];
  const view = (revision?: string) =>
    h(PreviewSwap, {
      revision,
      children: (g: any) => {
        callback = g;
        revisions.push(g.revision);
        return h('button', { onClick: g.onRetry }, 'Retry failed initial preview');
      },
    });
  const r = await render(view());
  await act(() => callback.onFailure!());
  await act(() => r.host.querySelector('button')!.click());
  await act(() => callback.onReady!());
  assert.equal(revisions.at(-1), ':1');
  await r.rerender(view());
  assert.equal(revisions.at(-1), ':1');
  await r.rerender(view('written'));
  await act(() => callback.onReady!());
  assert.equal(revisions.at(-1), 'written:2');
  await r.unmount();
});
