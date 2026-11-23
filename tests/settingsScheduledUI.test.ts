// Scheduler app status and task counts in general settings, including refresh ownership.
// Settings → General, Appearance and Keyboard shortcuts.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, calls, responses, resetCtl, defaultState, useStore, render, text, row, flush } from './support/settings-harness.ts';

await setup();
const { createElement: h, act } = await import('react');
const { Settings } = await import('../src/components/pages/Settings.tsx');

const section = (s: string) => render(h(Settings, { section: s }));
beforeEach(() => {
  resetCtl();
  useStore.setState(defaultState(), true);
});

test('scheduled counts and app status ignore older replies after a newer change', async () => {
  const listeners = new Set<() => void>();
  responses['automation.onChanged'] = (cb: () => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  };
  let oldTasks!: (value: any) => void;
  let oldApps!: (value: any) => void;
  responses['automation.list'] = () =>
    new Promise((resolve) => {
      oldTasks = resolve;
    });
  responses['automation.apps'] = () =>
    new Promise((resolve) => {
      oldApps = resolve;
    });
  const { host, unmount } = await section('general');
  responses['automation.list'] = {
    tasks: [
      { id: 'a', native_app: 'codex-app', status: 'ACTIVE' },
      { id: 'b', native_app: 'codex-app', status: 'ACTIVE' },
    ],
    errors: [],
  };
  const currentApps = {
    scheduler: true,
    codexApp: { installed: true, running: true },
    claudeDesktop: { installed: false, running: false },
  };
  responses['automation.apps'] = currentApps;
  await act(async () => listeners.forEach((cb) => cb()));
  assert.match(text(host), /Runs its 2 active tasks itself/);
  await act(async () => {
    oldTasks({ tasks: [], errors: [] });
    oldApps({ ...currentApps, codexApp: { installed: true, running: false } });
  });
  assert.match(text(host), /Runs its 2 active tasks itself/);
  assert.doesNotMatch(text(host), /Codex appClosed/);
  const queued = [...listeners];
  await unmount();
  const before = calls.length;
  await act(async () => queued.forEach((cb) => cb()));
  assert.equal(calls.length, before, 'a queued change after cleanup starts no new reads');
});

test('scheduled tasks: the switch, and the native apps that also run tasks, open or closed, with what they run', async () => {
  let changed: (() => void) | null = null;
  responses['automation.onChanged'] = (cb: () => void) => ((changed = cb), () => {});
  responses['automation.apps'] = {
    scheduler: true,
    codexApp: { installed: true, running: true },
    claudeDesktop: { installed: true, running: false },
  };
  let tasks: any[] = [
    { id: 'a', native_app: 'codex-app', status: 'ACTIVE' },
    { id: 'b', native_app: 'claude-desktop', status: 'ACTIVE' },
  ];
  responses['automation.list'] = () => Promise.resolve({ tasks, errors: [] });
  const { host, unmount } = await section('general');
  await flush();
  assert.match(text(row(host, 'Run scheduled tasks')), /A time missed while nothing was open runs once/);
  const apps = () => [...host.querySelectorAll('.sched-app-status-row')].map((r) => text(r));
  assert.deepEqual(apps(), [
    'Codex appOpenRuns its 1 active task itself',
    'Claude DesktopClosedMoPilot runs its 1 active task and records each run there',
  ]);
  // a task changes: the counts follow
  tasks = [...tasks, { id: 'c', native_app: 'codex-app', status: 'ACTIVE' }];
  changed!();
  await flush();
  assert.match(apps()[0], /Runs its 2 active tasks itself/);
  // a list that fails keeps what it showed
  responses['automation.list'] = () => Promise.reject(new Error('io'));
  changed!();
  await flush();
  assert.match(apps()[0], /Runs its 2 active tasks itself/);
  await unmount();
  // no native app installed: no list of them
  responses['automation.apps'] = {
    scheduler: true,
    codexApp: { installed: false, running: false },
    claudeDesktop: { installed: false, running: false },
  };
  const n = await section('general');
  await flush();
  assert.equal(n.host.querySelector('.sched-app-status-row'), null);
  await n.unmount();
});
