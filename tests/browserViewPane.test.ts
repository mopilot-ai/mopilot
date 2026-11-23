// The pane's side of main-owned tab views (src/lib/browserView.ts): where the page goes around app UI drawn
// over it, the handle that mirrors the <webview> API from main's reports, and which pane tabs closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { viewBounds, sameRect, measure, ViewHandle, closedBrowserPanes, OVERLAY_SELECTOR, BAND_SELECTOR } from '../src/lib/browserView.ts';

const stage = { x: 100, y: 50, width: 400, height: 600 };

test('viewBounds: the stage, hidden under an overlay, laid out around top and bottom bands', () => {
  assert.deepEqual(viewBounds(stage), stage);
  assert.equal(viewBounds({ ...stage, width: 0 }), null);
  // an app menu or dialog over the page hides it; one elsewhere, or empty, does not
  assert.equal(viewBounds(stage, [{ x: 450, y: 60, width: 200, height: 100 }]), null);
  assert.deepEqual(
    viewBounds(stage, [
      { x: 0, y: 0, width: 90, height: 40 },
      { x: 200, y: 200, width: 0, height: 0 },
    ]),
    stage,
  );
  // Annotate's bar over the top, the floating composer over the bottom
  assert.deepEqual(
    viewBounds(
      stage,
      [],
      [
        { x: 108, y: 58, width: 384, height: 42.4 },
        { x: 300, y: 560, width: 190, height: 80 },
        { x: 0, y: 0, width: 10, height: 10 },
        { x: 120, y: 300, width: 0, height: 10 },
      ],
    ),
    { x: 100, y: 100, width: 400, height: 460 },
  );
  // bands that leave no room hide it
  assert.equal(
    viewBounds(
      stage,
      [],
      [
        { x: 100, y: 40, width: 400, height: 360 },
        { x: 100, y: 300, width: 400, height: 400 },
      ],
    ),
    null,
  );
});

test('sameRect compares rects and nulls', () => {
  assert.equal(sameRect(null, null), true);
  assert.equal(sameRect(stage, { ...stage }), true);
  assert.equal(sameRect(stage, { ...stage, height: 1 }), false);
  assert.equal(sameRect(stage, null), false);
  assert.equal(sameRect(null, stage), false);
});

test("measure: reads the stage and the document's overlays and bands, leaving out the stage's own content", () => {
  const doc = window.document as unknown as Document;
  const rect = (el: Element, r: { x: number; y: number; width: number; height: number }) =>
    ((el as any).getBoundingClientRect = () => ({ left: r.x, top: r.y, width: r.width, height: r.height }));
  const el = doc.createElement('div');
  rect(el, stage);
  const inner = doc.createElement('div');
  inner.className = 'menu';
  rect(inner, stage);
  el.append(inner);
  const band = doc.createElement('div');
  band.className = 'pane-float-composer';
  rect(band, { x: 300, y: 600, width: 100, height: 50 });
  doc.body.append(el, band);
  assert.deepEqual(measure(el, doc), { x: 100, y: 50, width: 400, height: 550 });
  const menu = doc.createElement('div');
  menu.setAttribute('role', 'dialog');
  rect(menu, { x: 120, y: 80, width: 50, height: 50 });
  doc.body.append(menu);
  assert.equal(measure(el), null);
  menu.remove();
  band.remove();
  el.remove();
  assert.ok(OVERLAY_SELECTOR.includes('.menu') && BAND_SELECTOR.includes('.browser-annotate-bar'));
});

test('ViewHandle: unbound until main binds it, then mirrors main state, fires its events and sends the toolbar', async () => {
  const sent: any[] = [];
  let fail = false;
  const api: any = {
    nav: (...a: any[]) => (sent.push(a), fail ? Promise.reject(new Error('gone')) : Promise.resolve()),
  };
  const h = new ViewHandle(api);
  assert.throws(() => h.getWebContentsId(), /not bound/);
  assert.equal(h.getURL(), '');
  assert.equal(h.getZoomFactor(), 1);
  const seen: any[] = [];
  h.addEventListener('did-attach', () => seen.push('attach'));
  h.addEventListener('did-fail-load', (e: any) => seen.push(['fail', e.errorCode]));
  h.addEventListener('page-title-updated', () => seen.push(['title', h.getTitle()]));
  const dropped = () => seen.push('dropped');
  h.addEventListener('did-attach', dropped);
  h.removeEventListener('did-attach', dropped);
  h.removeEventListener('never', dropped);
  h.bound(7, { url: 'https://a.test/', title: 'A', canGoBack: true, canGoForward: false, loading: true, zoom: 0 });
  assert.deepEqual(
    [h.getWebContentsId(), h.getURL(), h.getTitle(), h.canGoBack(), h.canGoForward(), h.isLoading(), h.getZoomFactor()],
    [7, 'https://a.test/', 'A', true, false, true, 1],
  );
  h.receive({ id: 8, type: 'page-title-updated', state: null, detail: null });
  h.receive({ id: 7, type: 'nobody-listens', state: null, detail: null });
  h.receive({ id: 7, type: 'page-title-updated', state: { ...h.state, title: 'B', zoom: 1.5 }, detail: null });
  h.receive({ id: 7, type: 'did-fail-load', state: null, detail: { errorCode: -105 } });
  assert.deepEqual(seen, ['attach', ['title', 'B'], ['fail', -105]]);
  assert.equal(h.getZoomFactor(), 1.5);
  await h.loadURL('https://b.test/');
  h.goBack();
  h.goForward();
  h.reload();
  h.reloadIgnoringCache();
  fail = true;
  h.stop();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, [
    [7, 'load', 'https://b.test/'],
    [7, 'back'],
    [7, 'forward'],
    [7, 'reload'],
    [7, 'reloadIgnoringCache'],
    [7, 'stop'],
  ]);
});

test('closedBrowserPanes: browser tabs that went or changed kind', () => {
  assert.deepEqual(
    closedBrowserPanes(
      [
        { id: 'a', kind: 'browser' },
        { id: 'b', kind: 'browser' },
        { id: 'c', kind: 'files' },
        { id: 'd', kind: 'browser' },
      ],
      [
        { id: 'a', kind: 'browser' },
        { id: 'b', kind: 'chat' },
        { id: 'e', kind: 'browser' },
      ],
    ),
    ['b', 'd'],
  );
  // an artifact tab's claude.ai page is a view too: closing the tab lets it go
  assert.deepEqual(
    closedBrowserPanes(
      [
        { id: 'x', kind: 'artifact' },
        { id: 'y', kind: 'artifact' },
      ],
      [{ id: 'y', kind: 'artifact' }],
    ),
    ['x'],
  );
});
