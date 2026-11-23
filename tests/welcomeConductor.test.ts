// The welcome page's Conductor row (src/components/pages/WelcomeConductor.tsx): nothing without Conductor workspaces, else Import and how much, then what the import did and what it could not.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const told: unknown[][] = [];
const asked: unknown[] = [];
const ws = (name: string, adopted = false) => ({ path: `/c/${name}`, name, branch: name, adopted });
const repoA = (...workspaces: ReturnType<typeof ws>[]) => ({
  repos: [{ repo: '/r/a', name: 'a', workspaces }],
  skipped: [],
  truncated: false,
});
/** what the machine has, and what it has once an import ran */
let found: () => Promise<unknown> = async () => null;
let after: unknown = null;
let finish: (result: unknown) => void = () => {};
installNativeStub({
  conductor: {
    discover: () => found(),
    import: (only: unknown) => {
      asked.push(only);
      return new Promise((resolve) => {
        finish = (result) => {
          found = async () => after;
          resolve(result);
        };
      });
    },
  },
});
stubStore({ toast: (...a: unknown[]) => told.push(a) });
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { WelcomeConductor } = await import('../src/components/pages/WelcomeConductor.tsx');

async function render() {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(() => root.render(createElement(WelcomeConductor)));
  await act(async () => {});
  const row = () => host.querySelector('[data-testid="welcome-conductor"]');
  const hint = () => row()?.querySelector('.welcome-row-hint')?.textContent;
  return { host, root, row, hint, button: () => row()?.querySelector('button') ?? null };
}
const done = (...workspaces: object[]) => ({
  repos: [{ repo: '/r/a', name: 'a', projectId: 'p', workspaces }],
  skipped: [],
  truncated: false,
});

beforeEach(() => {
  told.length = 0;
  asked.length = 0;
});

test('nothing where Conductor left nothing, everything is brought over already, or the look failed', async () => {
  for (const f of [async () => repoA(), async () => repoA(ws('x', true)), () => Promise.reject(new Error('EACCES'))]) {
    found = f;
    const { host, root } = await render();
    assert.equal(host.innerHTML, '');
    await act(() => root.unmount());
  }
});

test('Import brings every workspace over: it waits while it runs, then says what it did', async () => {
  found = async () => repoA(ws('x'), ws('y'));
  after = repoA(ws('x', true), ws('y', true));
  const v = await render();
  assert.equal(v.hint(), '2 workspaces in 1 repository. They open where they are, on their own branches.');
  assert.equal(v.button()!.textContent, 'Import');
  // two clicks before the button is drawn again as busy start one import
  await act(async () => {
    v.button()!.click();
    v.button()!.click();
  });
  // running: the button keeps its name and takes no second click
  assert.deepEqual([v.button()!.disabled, v.button()!.getAttribute('aria-label'), v.button()!.textContent], [true, 'Import', '']);
  await act(async () => v.button()!.click());
  await act(async () => finish(done({ ...ws('x'), status: 'adopted' }, { ...ws('y'), status: 'adopted' })));
  await act(async () => {});
  assert.deepEqual(asked, [undefined]);
  assert.deepEqual(told, [['Imported 2 workspaces', 'info']]);
  assert.equal(v.button(), null);
  assert.equal(v.row()!.querySelector('.welcome-row-state')!.textContent, 'Done');
  assert.equal(v.hint(), 'Imported 2 workspaces');
  assert.equal(v.row()!.querySelector('[role="alert"]'), null);
  await act(() => v.root.unmount());
});

test('what could not be brought over stays on the row with its reason, with Import to try again while it is still there', async () => {
  found = async () => repoA(ws('x'), ws('y'));
  after = repoA(ws('x', true), ws('y'));
  const v = await render();
  await act(async () => v.button()!.click());
  await act(async () => finish(done({ ...ws('x'), status: 'adopted' }, { ...ws('y'), status: 'failed', error: 'Its branch is gone.' })));
  await act(async () => {});
  assert.deepEqual(told, [['Imported 1 workspace; 1 could not be imported', 'error']]);
  assert.equal(v.hint(), 'Imported 1 workspace; 1 could not be imported');
  assert.equal(v.row()!.querySelector('[role="alert"]')!.textContent, 'a/y: Its branch is gone.');
  assert.equal(v.button()!.disabled, false);
  // tried again, the folder is gone by then: not Done, and the reason stays
  after = repoA(ws('x', true));
  await act(async () => v.button()!.click());
  await act(async () => finish(done({ ...ws('y'), status: 'failed', error: 'It is gone.' })));
  await act(async () => {});
  assert.equal(v.button(), null);
  assert.equal(v.row()!.querySelector('.welcome-row-state'), null);
  assert.equal(v.hint(), 'Nothing was imported; 1 could not be imported');
  assert.equal(v.row()!.querySelector('[role="alert"]')!.textContent, 'a/y: It is gone.');
  await act(() => v.root.unmount());
});

test('a workspace that turns up after a clean import is offered like the first ones', async () => {
  found = async () => repoA(ws('x'));
  after = repoA(ws('x', true), ws('z'));
  const v = await render();
  await act(async () => v.button()!.click());
  await act(async () => finish(done({ ...ws('x'), status: 'adopted' })));
  await act(async () => {});
  assert.equal(v.hint(), '1 workspace in 1 repository. They open where they are, on their own branches.');
  assert.equal(v.button()!.disabled, false);
  await act(() => v.root.unmount());
});
