// Open in's app list: names, which apps are offered, and an installed list that answers after its menu closed.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, popoverStub, render } from './support/shell-panels-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

let answer!: (v: Record<string, boolean>) => void;
installNativeStub({ app: { installed: () => new Promise((r) => (answer = r)), icon: async () => null } });
stubStore(fakeStore({ prefs: { openDestination: 'finder' } }).exports);
mock.module('../src/session/open.ts', { namedExports: { openInApp: () => {}, showInFinder: () => {} } });
mock.module('../src/components/ui/Popover.tsx', { namedExports: popoverStub });
const { createElement, act } = await import('react');
const { OPEN_APPS, openAppLabel, availableOpenApps } = await import('../src/lib/openApps.ts');
const { useInstalledApps, OpenInItems } = await import('../src/components/titleBar/OpenInApps.tsx');

test('each app has its menu name; an id the list does not know shows as itself', () => {
  assert.equal(openAppLabel('vscode'), 'VS Code');
  assert.equal(openAppLabel('iterm'), 'iTerm2');
  assert.equal(openAppLabel('sublime'), 'sublime');
});

test('installed apps are offered with the current choice; every app while the list is unknown', () => {
  assert.deepEqual(availableOpenApps(null, 'finder'), OPEN_APPS);
  const offered = availableOpenApps({ finder: true, vscode: false, cursor: true }, 'zed');
  assert.deepEqual(
    offered.map((o) => o.value),
    ['finder', 'cursor', 'zed'],
  );
});

test('the installed list shows once it answers, a later mount starts from the last answer, and an answer after unmount is kept for the next', async () => {
  const seen: (Record<string, boolean> | null)[] = [];
  function Probe() {
    seen.push(useInstalledApps());
    return null;
  }
  const first = await render(createElement(Probe));
  await act(async () => answer({ cursor: true }));
  assert.deepEqual(seen.at(-1), { cursor: true });
  await first.unmount();

  seen.length = 0;
  const second = await render(createElement(Probe));
  await second.unmount();
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => errors.push(a);
  try {
    await act(async () => answer({ vscode: true }));
  } finally {
    console.error = original;
  }
  // a later mount starts from the last answer, so a menu that opens again doesn't list every app first
  assert.deepEqual(seen, [{ cursor: true }]);
  assert.deepEqual(errors, []);
  seen.length = 0;
  const third = await render(createElement(Probe));
  assert.deepEqual(seen[0], { vscode: true });
  await third.unmount();
});

test('no folder, no items: a chat on a machine has none here', async () => {
  const v = await render(createElement(OpenInItems, { path: '' }));
  assert.equal(v.host.textContent, '');
  await v.unmount();
});

test("a chat's folder on a machine opens in nothing here: one greyed item says where it is", async () => {
  const v = await render(createElement(OpenInItems, { path: '', machine: { name: 'Studio' } }));
  const item = v.host.querySelector('button, [role=menuitem]') as HTMLElement;
  assert.equal(item.textContent, 'Open folderOn Studio');
  assert.equal(item.getAttribute('title'), 'This folder is on Studio, not on this Mac');
  await v.unmount();
});
