// The sidebar's compact update strip: state-specific actions, version/retry detail and non-actionable progress.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { installNativeStub } from './support/ports/native.ts';

let st: any = { status: 'idle' };
const installs: unknown[] = [];
installNativeStub({ updates: { install: (o?: unknown) => installs.push(o ?? 'manual') } });
mock.module('../src/session/updates.ts', { namedExports: { useUpdateState: () => st } });
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { SidebarUpdate, updateLabel } = await import('../src/components/sidebar/SidebarUpdate.tsx');

async function mount() {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(() => root.render(createElement(SidebarUpdate)));
  return { host, refresh: () => act(() => root.render(createElement(SidebarUpdate))), unmount: () => act(() => root.unmount()) };
}

test('nothing shows while idle, checking, failed, unsupported, or ready without a version', async () => {
  for (const s of [
    { status: 'idle' },
    { status: 'checking' },
    { status: 'error', error: 'boom' },
    { status: 'unsupported' },
    { status: 'ready', available: null },
  ]) {
    st = s;
    assert.equal(updateLabel(st), null);
    const m = await mount();
    assert.equal(m.host.innerHTML, '');
    await m.unmount();
  }
});

test('a staged update offers a restart in a compact strip with version detail and a trailing arrow', async () => {
  st = { status: 'ready', available: { version: '2.0.0', notes: '' } };
  installs.length = 0;
  const m = await mount();
  const b = m.host.querySelector('button.sidebar-update') as HTMLButtonElement;
  assert.equal(b.getAttribute('aria-label'), 'Restart to update');
  assert.equal(b.querySelector('.sidebar-update-label')!.textContent, 'Restart to update');
  assert.equal(b.getAttribute('title'), 'Restart to update · v2.0.0');
  assert.equal(b.querySelector('.update-badge'), null);
  assert.ok(b.lastElementChild!.classList.contains('sidebar-update-arrow'));
  assert.equal(m.host.querySelector('[role="progressbar"]'), null);
  await act(() => b.click());
  assert.deepEqual(installs, [{ when: 'now' }]);
  await m.unmount();
});

test('installed rollback shares the ready action and preserves explicit installer and retry labels', async () => {
  const available = { version: '1.9.0', notes: '', rollback: { fromVersion: '2.0.0', channel: 'stable', requestId: 'id' } };
  for (const [extra, label] of [
    [{}, 'Restart to roll back'],
    [{ manual: true }, 'Download rollback'],
    [{ error: 'restart refused' }, 'Retry rollback'],
  ]) {
    st = { status: 'ready', available, ...(extra as object) };
    const m = await mount();
    const button = m.host.querySelector('button') as HTMLButtonElement;
    assert.equal(button.getAttribute('aria-label'), label);
    assert.match(button.title, /v1.9.0/);
    await m.unmount();
  }
});

test('a ready update also says when its restart waits for idle, or why the last restart failed', async () => {
  const available = { version: '2.0.0', notes: '' };
  assert.equal(updateLabel({ status: 'ready', available, restartWhenIdle: true, error: 'x' } as any), 'Restarting when idle');
  st = { status: 'ready', available, error: 'could not replace the app' };
  const m = await mount();
  const b = m.host.querySelector('button.sidebar-update') as HTMLButtonElement;
  assert.equal(b.getAttribute('aria-label'), 'Restart to retry update');
  assert.equal(b.getAttribute('title'), 'Restart to retry update · v2.0.0 · could not replace the app');
  installs.length = 0;
  await act(() => b.click());
  assert.deepEqual(installs, [{ when: 'now' }]);
  st = { status: 'ready', available, restartWhenIdle: true };
  await m.refresh();
  assert.equal(b.textContent, 'Restarting when idle');
  await act(() => b.click());
  assert.deepEqual(installs, [{ when: 'now' }, { when: 'now' }], 'a queued restart still lets the user restart now through the exit gate');
  await m.unmount();
});

test('on Windows the same button downloads the installer instead of restarting', async () => {
  st = { status: 'ready', manual: true, available: { version: '2.0.0', notes: '', url: 'https://x' } };
  installs.length = 0;
  const m = await mount();
  const b = m.host.querySelector('button.sidebar-update') as HTMLButtonElement;
  assert.equal(b.textContent, 'Download update');
  assert.equal(b.getAttribute('title'), 'Download update · v2.0.0');
  st = { ...st, restartWhenIdle: true, error: 'download failed' };
  await m.refresh();
  assert.equal(b.textContent, 'Download update', 'a manual installer never promises to restart the app');
  assert.equal(b.getAttribute('title'), 'Download update · v2.0.0 · download failed');
  st = { status: 'ready', manual: true, available: { version: '', notes: '' } };
  await m.refresh();
  assert.equal(b.getAttribute('title'), 'Download update', 'a feed without a display version must not invent one');
  await act(() => (m.host.querySelector('button.sidebar-update') as HTMLButtonElement).click());
  assert.deepEqual(installs, ['manual']);
  await m.unmount();
});

test('downloading and installing are busy statuses with a spinner and nothing to click', async () => {
  for (const [status, label] of [
    ['downloading', 'Downloading update'],
    ['installing', 'Restarting to update'],
  ]) {
    st = { status, available: null };
    const m = await mount();
    assert.equal(m.host.querySelector('button'), null);
    const p = m.host.querySelector('[role="progressbar"]')!;
    assert.equal(p.getAttribute('aria-label'), label);
    assert.equal(p.getAttribute('tabindex'), '0');
    assert.ok(p.classList.contains('busy'));
    assert.ok(p.querySelector('.sidebar-update-spinner .spinner'));
    assert.equal(p.querySelector('.sidebar-update-arrow'), null);
    assert.equal(p.querySelector('.update-badge'), null);
    assert.equal(p.getAttribute('aria-valuenow'), null, 'no progress to report');
    await m.unmount();
  }
});

test('a macOS download shows its percent, then that the update is being prepared', async () => {
  st = { status: 'downloading', available: null, progress: { version: '2.0.0', received: 50, total: 200 } };
  let m = await mount();
  let p = m.host.querySelector('[role="progressbar"]')!;
  assert.equal(p.getAttribute('aria-label'), 'Downloading update · 25%');
  assert.equal(p.getAttribute('title'), 'Downloading update · 25% · v2.0.0');
  assert.equal(p.getAttribute('aria-valuenow'), '25');
  await m.unmount();
  st = { status: 'downloading', available: null, progress: { version: '2.0.0', received: 50, total: null } };
  assert.equal(updateLabel(st), 'Downloading update', 'no percent without a size');
  st = { status: 'downloading', available: null, preparing: true, progress: { version: '2.0.0', received: 200, total: 200 } };
  m = await mount();
  p = m.host.querySelector('[role="progressbar"]')!;
  assert.equal(p.getAttribute('aria-label'), 'Preparing update');
  assert.equal(p.getAttribute('title'), 'Preparing update · v2.0.0');
  assert.equal(p.getAttribute('aria-valuenow'), null, 'preparing is indeterminate after the download has finished');
  await m.unmount();
});

test('one mounted strip follows the current updater state without retaining a stale action or failure', async () => {
  const available = { version: '2.0.0', notes: '' };
  st = { status: 'ready', available, error: 'old failure' };
  const m = await mount();
  st = { status: 'downloading', available, progress: { version: '2.0.0', received: 70, total: 100 } };
  await m.refresh();
  assert.equal(m.host.querySelector('button'), null);
  assert.equal(m.host.querySelector('[role="progressbar"]')!.getAttribute('title'), 'Downloading update · 70% · v2.0.0');
  st = { status: 'ready', available };
  await m.refresh();
  assert.equal(m.host.querySelector('button')!.getAttribute('title'), 'Restart to update · v2.0.0');
  st = { status: 'idle' };
  await m.refresh();
  assert.equal(m.host.innerHTML, '');
  await m.unmount();
});
