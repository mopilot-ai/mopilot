import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';
const { createElement, act, useSyncExternalStore } = await import('react');
const { createRoot } = await import('react-dom/client');
const listeners = new Set<() => void>();
let state: any = { route: { name: 'settings', section: 'about' }, migrationIssue: true };
const useStore = (selector: any) =>
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => selector(state),
  );
const navigate = (route: any) => {
  state = { ...state, route };
  listeners.forEach((cb) => cb());
};
stubStore({ useStore, navigate, restoreMigration: async () => {}, retryMigration: async () => {}, toastFailure: () => () => {} });
mock.module('../src/session/open.ts', { namedExports: { revealPath: () => {} } });
installNativeStub({ chats: { migrationReport: async () => null } });
mock.module('../src/components/pages/Settings.tsx', { namedExports: { Group: (p: any) => p.children } });
const { MigrationBanner } = await import('../src/components/sidebar/MigrationBanner.tsx');
const { MigrationAdvanced } = await import('../src/components/pages/settings/MigrationReport.tsx');
test('migration report link opens the disclosure in About, while recovery tools stay collapsed by default', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  try {
    await act(() => root.render(createElement('div', {}, createElement(MigrationBanner), createElement(MigrationAdvanced))));
    assert.equal(host.querySelector('[data-testid="migration-report"]'), null);
    const report = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Report')!;
    await act(async () => report.click());
    assert.deepEqual(state.route, { name: 'settings', section: 'about', tab: 'chat-data' });
    assert.ok(host.querySelector('[data-testid="migration-report"]'));
    await act(() => (host.querySelector('[data-testid="advanced-toggle"]') as HTMLElement).click());
    assert.equal(host.querySelector('[data-testid="migration-report"]'), null);
  } finally {
    await act(() => root.unmount());
    host.remove();
  }
});
