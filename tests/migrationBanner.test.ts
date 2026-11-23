// The unfinished chat-data migration banner (src/components/sidebar/MigrationBanner.tsx).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { stubStore } from './support/stubs.ts';

const calls: unknown[][] = [];
let issue: unknown = null;
let finish!: () => void;
stubStore({
  useStore: (f: any) => f({ migrationIssue: issue }),
  navigate: (r: unknown) => calls.push(['navigate', r]),
  retryMigration: () => (
    calls.push(['retry']),
    new Promise<void>((resolve) => {
      finish = () => resolve();
    })
  ),
});
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { MigrationBanner } = await import('../src/components/sidebar/MigrationBanner.tsx');

test('hidden without an issue', async () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(() => root.render(createElement(MigrationBanner)));
  assert.equal(host.innerHTML, '');
  await act(() => root.unmount());
});

test('Report opens the chat-data page; Retry is disabled while it runs', async () => {
  issue = { error: 'x' };
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(() => root.render(createElement(MigrationBanner)));
  const card = host.querySelector('[data-testid="migration-banner"]') as HTMLElement;
  assert.equal(card.dataset.tone, 'warn');
  assert.equal(card.querySelector('.title')?.textContent, "Couldn't move archived chats");
  assert.equal(card.querySelector('.detail')?.textContent, 'Restored from backup.');
  const [report, retry] = [...host.querySelectorAll('button')] as HTMLButtonElement[];
  assert.deepEqual([report.className, retry.className], ['btn sm', 'btn primary sm']);
  await act(() => report.click());
  await act(() => retry.click());
  assert.equal(retry.disabled, true);
  await act(async () => finish());
  assert.equal(retry.disabled, false);
  assert.deepEqual(calls, [['navigate', { name: 'settings', section: 'about', tab: 'chat-data' }], ['retry']]);
  await act(() => root.unmount());
});
