// The App's real SidePaneSlot keeps resource hosts alive past the exit timer and releases them only when closed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h, useEffect, act } from 'react';
import { autoMock, mockStore, resetStore, setStore, useStore, render } from './support/thread-kit.ts';

mockStore();
let starts = 0;
let stops = 0;
function Resource({ id }: { id: string }) {
  useEffect(() => {
    starts++;
    return () => {
      stops++;
    };
  }, [id]);
  return h('span', { 'data-resource': id });
}
autoMock('src/components/panels/SidePane.tsx', 'pane', {
  SidePane: ({ hidden }: { hidden: boolean }) => {
    const tabs = useStore((s: any) => s.paneTabs);
    return h(
      'div',
      { 'data-pane': '', hidden },
      tabs.map((tab: any) => h(Resource, { key: tab.id, id: tab.id })),
    );
  },
});
const { SidePaneSlot } = await import('../src/components/panels/SidePaneSlot.tsx');

test('a session switch keeps browser/terminal hosts mounted after the close animation and reopening reuses them', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  starts = 0;
  stops = 0;
  resetStore({
    route: { name: 'thread', id: 'a' },
    diffPanel: { open: true },
    paneFull: false,
    paneTabs: [
      { kind: 'terminal', id: 'term-a' },
      { kind: 'browser', id: 'browser-a' },
    ],
  });
  const v = await render(h(SidePaneSlot, { cwd: '/a', threadId: 'a' }));
  assert.equal(starts, 2);
  await act(() => setStore({ route: { name: 'thread', id: 'b' }, diffPanel: { open: false } }));
  await v.rerender(h(SidePaneSlot, { cwd: '/b', threadId: 'b' }));
  await act(() => t.mock.timers.tick(600));
  assert.equal(v.$('[data-pane]')!.hidden, true);
  assert.equal(stops, 0, 'hiding the pane must not run a terminal/page cleanup');
  await act(() => setStore({ route: { name: 'thread', id: 'a' }, diffPanel: { open: true } }));
  assert.equal(v.$('[data-pane]')!.hidden, false);
  assert.equal(starts, 2, 'returning to the owner reuses the existing resource hosts');
  await act(() => setStore({ diffPanel: { open: false }, paneTabs: [] }));
  await act(() => t.mock.timers.tick(600));
  assert.equal(stops, 2);
  assert.equal(v.$('[data-pane]'), null);
  await v.unmount();
});

test('ordinary panels unmount after their exit without retaining an empty host on non-chat routes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  resetStore({ route: { name: 'home' }, diffPanel: { open: true }, paneFull: true, paneTabs: [] });
  const v = await render(h(SidePaneSlot, { cwd: '/new', threadId: null }));
  await act(() => setStore({ route: { name: 'settings' } }));
  await act(() => t.mock.timers.tick(250));
  assert.equal(v.$('[data-pane]'), null);
  await v.unmount();
});

test('closing from full view restores title-bar controls while retaining the resource host', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  starts = 0;
  stops = 0;
  resetStore({
    route: { name: 'thread', id: 'a' },
    diffPanel: { open: true },
    paneFull: true,
    paneTabs: [{ kind: 'browser', id: 'browser-a' }],
  });
  const v = await render(h(SidePaneSlot, { cwd: '/a', threadId: 'a' }));
  // The workspace shortcut closes only diffPanel, as do the pane-tab toggle actions.
  await act(() => setStore((s: any) => ({ diffPanel: { ...s.diffPanel, open: false } })));
  await act(() => t.mock.timers.tick(250));
  assert.equal(useStore.getState().paneFull, false);
  assert.equal(v.$('[data-pane]')!.hidden, true);
  assert.equal(stops, 0);
  await v.unmount();
});
