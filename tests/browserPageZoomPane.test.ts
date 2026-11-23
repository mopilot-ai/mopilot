// The browser pane's page zoom controls: ViewHandle's zoom requests and the address bar's badge for a site the user zoomed.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { act, createElement } from 'react';
import { render } from './support/shell-panels-kit.ts';
import { ViewHandle } from '../src/lib/browserView.ts';
import { ZoomBadge } from '../src/components/panels/browserPanel/ZoomBadge.tsx';
import { installNativeStub } from './support/ports/native.ts';
installNativeStub({ browser: { onShortcut: () => () => {} } });
mock.module('../src/session/clipboard.ts', { namedExports: { copyText: () => {} } });
const { useBrowserShortcuts } = await import('../src/session/useBrowserShortcuts.ts');

test('the pane: ViewHandle asks main to zoom and reports the fit; the badge shows a chosen zoom and fits again', async () => {
  const sent: any[] = [];
  let fail = false;
  const h = new ViewHandle({ nav: (...a: any[]) => (sent.push(a), fail ? Promise.reject(new Error('gone')) : Promise.resolve()) } as any);
  h.bound(7, { url: 'https://a.test/', title: '', canGoBack: false, canGoForward: false, loading: false, zoom: 0.7 });
  assert.equal(h.isZoomAuto(), true, 'a main without the flag fits');
  h.zoom('in');
  fail = true;
  h.zoom('reset');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, [
    [7, 'zoom-in'],
    [7, 'zoom-reset'],
  ]);
  fail = false;
  const r = await render(createElement(ZoomBadge, { page: h as any }));
  assert.equal(r.host.querySelector('.browser-zoom'), null, 'nothing while the page fits');
  await act(async () => h.receive({ id: 7, type: 'zoom-changed', state: { ...h.state, zoom: 0.9, zoomAuto: false }, detail: null }));
  const badge = r.host.querySelector('.browser-zoom') as HTMLButtonElement;
  assert.equal(badge.textContent, '90%');
  await act(async () => badge.click());
  assert.deepEqual(sent.at(-1), [7, 'zoom-reset']);
  await r.unmount();
  // no page, or a <webview> page with no zoom of its own: nothing
  const none = await render(createElement(ZoomBadge, { page: null }));
  assert.equal(none.host.innerHTML, '');
  await none.unmount();
  const legacy = await render(createElement(ZoomBadge, { page: { addEventListener() {}, removeEventListener() {} } as any }));
  assert.equal(legacy.host.querySelector('.browser-zoom'), null);
  await legacy.unmount();
});

test('the page zoom keys go to the front page’s own zoom; a <webview> page without one is left alone', async () => {
  const asked: string[] = [];
  const page: { current: any } = { current: { zoom: (a: string) => asked.push(a) } };
  function Pane() {
    useBrowserShortcuts({
      page,
      address: { current: null },
      front: true,
      paneId: 'one',
      url: '',
      reload() {},
      annotate() {},
      find() {},
      unavailable() {},
    });
    return null;
  }
  const r = await render(createElement(Pane));
  const key = (id: string) =>
    act(async () => window.dispatchEvent(new CustomEvent('workspace-shortcut', { detail: { paneId: 'one', id } })));
  await key('browser-zoom-in');
  await key('browser-zoom-out');
  await key('browser-zoom-reset');
  assert.deepEqual(asked, ['in', 'out', 'reset']);
  page.current = {};
  await key('browser-zoom-in');
  page.current = null;
  await key('browser-zoom-in');
  assert.equal(asked.length, 3);
  await r.unmount();
});
