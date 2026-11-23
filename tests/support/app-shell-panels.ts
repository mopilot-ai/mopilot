// Registers panel layout and focused chat ownership cases against the mounted App fixture.
import assert from 'node:assert/strict';
import { test } from 'node:test';

type AppShellPanelFixture = {
  reset: (state: Record<string, unknown>) => void;
  mount: () => Promise<void>;
  unmount: () => Promise<void>;
  set: (state: Record<string, unknown>) => PromiseLike<void>;
  props: (name: string) => Record<string, unknown>;
  getHost: () => HTMLElement;
};

export function registerAppShellPanelCases({ reset, mount, unmount, set, props, getHost }: AppShellPanelFixture) {
  test('panels: the side pane, a full pane, the terminal and the summary', async () => {
    reset({ route: { name: 'thread', id: 'a' }, diffPanel: { open: true }, bottomPanelOpen: true });
    await mount();
    assert.deepEqual(props('SidePane'), { leaving: false, hidden: false, cwd: '/a', threadId: 'a' });
    assert.equal(props('TerminalPanel').cwd, '/a');
    await set({ paneFull: true });
    assert.equal(getHost().querySelector<HTMLElement>('.main-content')!.hidden, true);
    await set({ route: { name: 'home' } });
    assert.deepEqual(props('SidePane'), { leaving: false, hidden: false, cwd: '/new', threadId: null });
    await set({ route: { name: 'projects' } });
    assert.equal(getHost().querySelector<HTMLElement>('.main-content')!.hidden, false);
    assert.equal(props('SidePane').leaving, true);
    await set({ route: { name: 'thread', id: 'b' } });
    assert.equal(props('SidePane').cwd, '/new');
    await unmount();
  });

  test('the session rail follows the repository pane’s focus during navigation and in split view', async () => {
    reset({ route: { name: 'thread', id: 'a' }, summaryOpen: true });
    await mount();
    assert.equal(props('SummaryPanel').threadId, 'a');
    await set({ route: { name: 'thread', id: 'b' } });
    assert.equal(props('SummaryPanel').threadId, 'b');
    await set({ split: { panes: [{ chatId: 'c', weight: 1 }], focus: 'c', primaryWeight: 1 } });
    assert.equal(props('SummaryPanel').threadId, 'c');
    await set({ route: { name: 'settings', section: 'general' } });
    assert.equal(getHost().querySelector('[data-c="SummaryPanel"]'), null);
    await unmount();
  });
}
