// Archived Settings owns only its latest mounted request, including failure and retry completion.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { stubStore } from './support/stubs.ts';
const requests: { resolve: (value: any) => void; reject: (error: any) => void }[] = [];
stubStore({
  useStore: (select: any) => select({ archived: [], savedProjects: [] }),
  loadArchived: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
  unarchiveThread: async () => {},
  deleteThread: async () => {},
  threadTitle: () => '',
  toast: () => {},
  projectForThread: () => null,
});
mock.module('../src/components/pages/settings/Controls.tsx', { exports: { Row: () => null, Select: () => null } });
mock.module('../src/components/ui/Popover.tsx', {
  exports: {
    Menu: () => null,
    MenuItem: () => null,
    Tooltip: () => null,
    useAnchor: () => ({ ref: { current: null }, toggle: () => {}, close: () => {}, open: false, anchor: null }),
  },
});
mock.module('../src/components/pages/settings/Rows.tsx', { exports: { groupBy: () => ({}) } });
const { Archived } = await import('../src/components/pages/settings/Archived.tsx');
const flush = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
async function render(strict = false) {
  requests.length = 0;
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  await act(async () => root.render(strict ? createElement(StrictMode, null, createElement(Archived)) : createElement(Archived)));
  return { el, root };
}

test('StrictMode replacement ignores the old failure after a newer successful response', async () => {
  const { el, root } = await render(true);
  assert.equal(requests.length, 2);
  requests[1].resolve([]);
  await flush();
  assert.match(el.textContent!, /No archived chats/);
  requests[0].resolve([{ source: 'Codex', error: 'old failure' }]);
  await flush();
  assert.doesNotMatch(el.textContent!, /old failure/);
  await act(async () => root.unmount());
  el.remove();
});

test('unexpected loader rejection ends loading, reports a retry, and successful retry clears it', async () => {
  const { el, root } = await render();
  requests[0].reject(new Error('startup failed'));
  await flush();
  assert.match(el.textContent!, /startup failed/);
  const retry = [...el.querySelectorAll('button')].find((x) => x.textContent === 'Retry')!;
  await act(async () => retry.click());
  assert.equal(requests.length, 2);
  requests[1].resolve([]);
  await flush();
  assert.match(el.textContent!, /No archived chats/);
  assert.doesNotMatch(el.textContent!, /startup failed/);
  await act(async () => root.unmount());
  el.remove();
});

test('unmount prevents late success and rejection from publishing', async () => {
  for (const fail of [false, true]) {
    const { el, root } = await render();
    await act(async () => root.unmount());
    if (fail) requests[0].reject(new Error('late'));
    else requests[0].resolve([{ source: 'Codex', error: 'late' }]);
    await flush();
    assert.equal(el.textContent, '');
    el.remove();
  }
});

test('obsolete StrictMode success or failure cannot clear the replacement request spinner', async () => {
  for (const reject of [false, true]) {
    const { el, root } = await render(true);
    assert.equal(requests.length, 2);
    if (reject) requests[0].reject(new Error('obsolete rejection'));
    else requests[0].resolve([{ source: 'Codex', error: 'obsolete result' }]);
    await flush();
    assert.equal(el.querySelector('.archived-bar'), null);
    assert.equal(el.querySelector('[role="alert"]'), null);
    assert.doesNotMatch(el.textContent!, /No archived chats|obsolete/);
    requests[1].resolve([]);
    await flush();
    assert.match(el.textContent!, /No archived chats/);
    await act(async () => root.unmount());
    el.remove();
  }
});
