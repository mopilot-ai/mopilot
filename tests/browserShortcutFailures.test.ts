// Async browser reload failures belong only to the current live page and visible shortcut subscription.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { act, createElement } from 'react';
import { render } from './support/shell-panels-kit.ts';
import { deferred } from './support/async-scenarios.ts';
import { ViewHandle } from '../src/lib/browserView.ts';
import { installNativeStub } from './support/ports/native.ts';
installNativeStub({ browser: { onShortcut: () => () => {} } });
mock.module('../src/session/clipboard.ts', { namedExports: { copyText: () => {} } });
const { useBrowserShortcuts } = await import('../src/session/useBrowserShortcuts.ts');
const page: { current: any } = { current: null };
let failures = 0;
function Pane() {
  useBrowserShortcuts({
    page,
    address: { current: null },
    front: true,
    paneId: 'one',
    url: 'https://fallback.test',
    reload() {},
    annotate() {},
    find() {},
    unavailable: () => {
      failures++;
    },
  });
  return null;
}
const command = async () => {
  await act(async () => {
    window.dispatchEvent(new CustomEvent('workspace-shortcut', { detail: { paneId: 'one', id: 'browser-reload-cache' } }));
  });
};
test('native reload failures surface for the current page, but retire after replacement and unmount', async () => {
  for (const retirement of ['none', 'rerender', 'replace', 'unmount']) {
    const wait = deferred<void>();
    const view = new ViewHandle({ nav: () => wait.promise } as any);
    view.bound(7, {} as any);
    page.current = view;
    const r = await render(createElement(Pane));
    const before = failures;
    await command();
    if (retirement === 'rerender') await r.rerender(createElement(Pane));
    if (retirement === 'replace') page.current = null;
    if (retirement === 'unmount') await r.unmount();
    await act(async () => {
      wait.reject(new Error('native failure'));
      await wait.promise.catch(() => {});
    });
    assert.equal(failures - before, ['none', 'rerender'].includes(retirement) ? 1 : 0);
    if (retirement !== 'unmount') await r.unmount();
  }
});
test('an unbound browser cannot execute a cache reload, and says nothing failed', async () => {
  page.current = null;
  const r = await render(createElement(Pane));
  const before = failures;
  await command();
  assert.equal(failures, before);
  await r.unmount();
});
