// Settings → About → Diagnostics → Chat data (MigrationAdvanced), imported directly so coverage maps to source.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, settingsExports, render, click, byText, flush } from './support/pages-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const { createElement: h, act } = await import('react');
const calls: any[] = [];
const store = fakeStore<any>({ route: { name: 'home' }, migrationIssue: null });
let report: any = null;
let confirmAnswer = true;
let retryError: unknown = null;
(globalThis as any).confirm = () => (calls.push(['confirm']), confirmAnswer);

stubStore({
  useStore: store.useStore,
  retryMigration: async () => {
    calls.push(['retry']);
    if (retryError) throw retryError;
  },
  restoreMigration: async () => calls.push(['restore']),
  toastFailure: (what: string) => (e: any) => calls.push(['toast', `${what}: ${e?.message ?? e}`, 'error']),
});
mock.module('../src/session/open.ts', { namedExports: { revealPath: (p: string) => calls.push(['reveal', p]) } });
installNativeStub({
  chats: {
    migrationReport: () => (calls.push(['report']), report instanceof Error ? Promise.reject(report) : Promise.resolve(report)),
  },
});
mock.module('../src/components/pages/Settings.tsx', { namedExports: settingsExports });
const { MigrationAdvanced } = await import('../src/components/pages/settings/MigrationReport.tsx');

const counts = (o: Partial<Record<string, number>> = {}) => ({
  chats: 3,
  pinned: 1,
  unread: 0,
  archived: 0,
  worktree: 0,
  accounts: 0,
  accountsPinned: 0,
  multiSegment: 0,
  ...o,
});
const result = (host: HTMLElement) => host.querySelector('[data-testid=migration-result]')?.textContent;

test('the group is collapsed until toggled, and opens itself on the chat-data tab', async () => {
  store.setState({ route: { name: 'home' } });
  report = null;
  const v = await render(h(MigrationAdvanced));
  assert.equal(v.host.querySelector('[data-testid=migration-report]'), null);
  await click(v.host.querySelector('[data-testid=advanced-toggle]'));
  assert.equal(result(v.host), 'No chat-data migration has run on this profile.');
  await click(v.host.querySelector('[data-testid=advanced-toggle]'));
  assert.equal(v.host.querySelector('[data-testid=migration-report]'), null);
  await act(async () => store.setState({ route: { name: 'settings', tab: 'chat-data' } }));
  await flush();
  assert.ok(v.host.querySelector('[data-testid=migration-report]'));
  await v.unmount();
});

test('a report that fails to load says so, not that no migration ran, and Try again reads it again', async () => {
  store.setState({ route: { name: 'settings', tab: 'chat-data' } });
  report = new Error('ipc down');
  const v = await render(h(MigrationAdvanced));
  try {
    await flush();
    assert.equal(result(v.host), "Couldn't read the migration report: ipc down");
    report = null;
    calls.length = 0;
    await click(byText(v.host, 'Try again'));
    assert.deepEqual(calls, [['report']]);
    assert.equal(result(v.host), 'No chat-data migration has run on this profile.');
  } finally {
    await v.unmount();
  }
});

for (const fails of [false, true])
  test(`a Retry's own read ${fails ? 'failing' : 'answering'} after a newer read started is dropped`, async () => {
    store.setState({ route: { name: 'settings', tab: 'chat-data' }, migrationIssue: null });
    report = { result: 'failed', backupOk: false };
    const v = await render(h(MigrationAdvanced));
    try {
      await flush();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      // Retry's read waits; meanwhile the issue changes and the newer read answers
      report = {
        then: (ok: (r: unknown) => void, no: (e: unknown) => void) =>
          gate.then(() => (fails ? no(new Error('late')) : ok({ result: 'restored' }))),
      };
      calls.length = 0;
      // pressed outside act: Retry's read stays pending while the rest happens
      byText(v.host, 'Retry').click();
      await flush();
      report = { result: 'ok', backupOk: true };
      await act(async () => store.setState({ migrationIssue: `newer-${fails}` }));
      await flush();
      assert.equal(result(v.host), 'Finished');
      await act(async () => release());
      await flush();
      assert.equal(result(v.host), 'Finished', 'the older read is not shown');
      assert.equal(
        calls.some((c) => c[0] === 'toast'),
        false,
        'nor its failure',
      );
    } finally {
      await v.unmount();
    }
  });

test('an older report read that answers late does not replace the newer one', async () => {
  store.setState({ route: { name: 'settings', tab: 'chat-data' }, migrationIssue: null });
  let release!: (r: unknown) => void;
  report = { result: 'failed', backupOk: false };
  const first = new Promise((r) => (release = r));
  const real = report;
  // the first read waits; the issue changes and the second read answers first
  report = { then: (ok: (r: unknown) => void) => first.then(ok) };
  const v = await render(h(MigrationAdvanced));
  try {
    report = { result: 'ok', backupOk: true };
    await act(async () => store.setState({ migrationIssue: 'again' }));
    await flush();
    assert.equal(result(v.host), 'Finished');
    await act(async () => release(real));
    await flush();
    assert.equal(result(v.host), 'Finished');
  } finally {
    await v.unmount();
  }
});

test('a finished migration shows its counts, mismatches, failed chats and backup; restore asks first', async () => {
  store.setState({ route: { name: 'settings', tab: 'chat-data' } });
  report = {
    result: 'ok',
    at: 0,
    backupOk: true,
    backup: '/b/backup',
    report: { before: counts(), after: counts({ pinned: 0 }), failed: ['c1', 'c2'] },
  };
  const v = await render(h(MigrationAdvanced));
  await flush();
  assert.equal(result(v.host), 'Finished');
  assert.equal(v.host.querySelector('[data-count=pinned]')!.className, 'mismatch');
  assert.equal(v.host.querySelector('[data-count=chats]')!.className, '');
  assert.deepEqual(
    [...v.host.querySelectorAll('[data-testid=migration-failed] li')].map((e) => e.textContent),
    ['c1', 'c2'],
  );
  assert.equal(v.host.querySelector('.migration-actions')!.textContent!.includes('Retry'), false);
  calls.length = 0;
  await click(byText(v.host, 'Show backup'));
  assert.deepEqual(calls, [['reveal', '/b/backup']]);
  confirmAnswer = false;
  calls.length = 0;
  await click(byText(v.host, 'Restore pre-migration data'));
  assert.deepEqual(calls, [['confirm']]);
  confirmAnswer = true;
  calls.length = 0;
  report = { result: 'restored', at: 1_700_000_000_000, backupOk: true, report: { before: counts(), after: counts(), failed: [] } };
  await click(byText(v.host, 'Restore pre-migration data'));
  assert.deepEqual(calls, [['confirm'], ['restore'], ['report']]);
  assert.match(result(v.host)!, /^Restored from the backup.* · /);
  assert.equal(v.host.querySelector('[data-testid=migration-failed]'), null);
  assert.equal(v.host.querySelector('.migration-actions')!.textContent!.includes('Restore'), false);
  assert.equal(v.host.querySelector('.migration-actions')!.textContent!.includes('Show backup'), false);
  await v.unmount();
});

test('a failed run offers retry, disables restore without a verified backup, and reloads when the issue changes', async () => {
  store.setState({ route: { name: 'settings', tab: 'chat-data' }, migrationIssue: null });
  report = { result: 'failed', backupOk: false };
  const v = await render(h(MigrationAdvanced));
  await flush();
  assert.match(result(v.host)!, /^Failed\./);
  assert.equal(v.host.querySelector('[data-testid=migration-counts]'), null);
  const restore = byText(v.host, 'Restore pre-migration data') as HTMLButtonElement;
  assert.ok(restore.disabled);
  assert.equal(restore.title, 'The backup is missing or does not verify');
  report = { result: 'odd-state', backupOk: true };
  calls.length = 0;
  await click(byText(v.host, 'Retry'));
  assert.deepEqual(calls, [['retry'], ['report']]);
  assert.equal(result(v.host), 'odd-state');
  // a retry that fails says why and gives the buttons back
  retryError = new Error('locked');
  calls.length = 0;
  await click(byText(v.host, 'Retry'));
  assert.deepEqual(calls, [['retry'], ['toast', "Couldn't migrate again: locked", 'error']]);
  assert.equal((byText(v.host, 'Retry') as HTMLButtonElement).disabled, false);
  retryError = null;
  // the retry went through but the report couldn't be read again: that, not the retry, is what failed
  report = new Error('report unreadable');
  calls.length = 0;
  await click(byText(v.host, 'Retry'));
  assert.deepEqual(calls, [['retry'], ['report'], ['toast', "Couldn't read the migration report again: report unreadable", 'error']]);
  assert.equal((byText(v.host, 'Retry') as HTMLButtonElement).disabled, false);
  report = { result: 'odd-state', backupOk: true };
  calls.length = 0;
  await act(async () => store.setState({ migrationIssue: 'changed' }));
  await flush();
  assert.deepEqual(calls, [['report']]);
  await v.unmount();
});
