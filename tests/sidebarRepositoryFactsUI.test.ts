// The sidebar retains only repository replies for the visible path and the current machine identity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { window } from './support/dom.ts';
import { flush, render } from './support/shell-chrome-kit.ts';
import { useFakeNative } from './support/ports/native.ts';
import { controlledReads } from './support/async-scenarios.ts';
import { folderRepository, useSidebarRepositories } from '../src/components/sidebar/sidebarRepositories.ts';
import type { ProjectGroupData } from '../src/components/sidebar/projectGroups.ts';

const checkout: ProjectGroupData = {
  id: null,
  path: '/remote/checkout',
  name: 'Checkout',
  machine: { id: 'box', name: 'Build box' },
  saved: false,
  threads: [],
};
const remote = (scope: string, status = 'online') => [{ id: 'box', status, repositoryScope: scope }];

test('a re-pair drops an old probe and a decided missing origin clears the matching fact', async (t) => {
  const replies = controlledReads<{ value?: string | null }>();
  const bridge = useFakeNative(t, { host: { sidebarRepository: replies.read }, git: { sidebarRepository: async () => null } });
  function Facts({ machines, needed }: { machines: ReturnType<typeof remote>; needed: boolean }) {
    const facts = useSidebarRepositories([checkout, { ...checkout, path: '' }], machines, needed);
    return createElement('div', null, folderRepository(facts, checkout, machines) ?? 'unknown');
  }
  const view = await render(createElement(Facts, { machines: remote('old'), needed: false }));
  try {
    assert.equal(replies.requests.length, 0);
    await view.rerender(createElement(Facts, { machines: [], needed: true }));
    assert.equal(view.host.textContent, 'unknown');
    assert.equal(replies.requests.length, 0);
    await view.rerender(createElement(Facts, { machines: remote('old'), needed: true }));
    await view.rerender(createElement(Facts, { machines: remote('new'), needed: true }));
    await act(async () => replies.requests[1].resolve({ value: 'github.com/new/app' }));
    await act(async () => replies.requests[0].resolve({ value: 'github.com/old/app' }));
    assert.equal(view.host.textContent, 'github.com/new/app');
    assert.deepEqual(bridge.callsTo('host.sidebarRepository'), [
      ['box', { path: '/remote/checkout' }],
      ['box', { path: '/remote/checkout' }],
    ]);
    const refresh = () => act(async () => void window.dispatchEvent(new window.Event('focus')));
    await refresh();
    await act(async () => replies.requests[2].resolve({}));
    await refresh();
    await act(async () => replies.requests[3].reject(new Error('offline')));
    await refresh();
    await act(async () => replies.requests[4].resolve({ value: 'github.com/new/app' }));
    assert.equal(view.host.textContent, 'github.com/new/app');
    await refresh();
    await act(async () => replies.requests[5].resolve({ value: null }));
    await flush();
    assert.equal(view.host.textContent, 'unknown');
  } finally {
    await view.unmount();
  }
});
