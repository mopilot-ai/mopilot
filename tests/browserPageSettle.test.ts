// Settling after a browser action (electron/capabilities/browser/pageSettle.cjs, #1651): event-based, on virtual time.
// An idle page returns after a short quiet window; a navigation, a load, network activity or a changing DOM keeps it
// waiting, a navigation the action scheduled is never cut off before it commits, and every wait is bounded. Also the
// routes that share it: BrowserTabs.settle (browser_*, browser_script, the user's Chrome) and PanelBrowser (sage_browser_*).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { setup, tabOf, viewTabs, drive } from './support/browser-host-kit.ts';
import { tick as flush } from './support/async-scenarios.ts';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { settlePage, NAV_GRACE_MS, DOM_QUIET_MS, NET_QUIET_MS, SETTLE_MAX_MS } = require('../electron/capabilities/browser/pageSettle.cjs');
const { stopLoading } = require('../electron/capabilities/browser/loadInterruption.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');
const { PanelBrowser } = require('../electron/capabilities/browser/cdp.cjs');

/** Settles `p` while virtual time advances 1 ms at a time; the virtual ms it took. */
async function timed(t: any, p: Promise<unknown>, max = 30_000) {
  const t0 = Date.now();
  let done = false;
  let error: unknown = null;
  p.then(
    () => (done = true),
    (e) => ((done = true), (error = e)),
  );
  await waitFor(() => done, 'the page to settle', {
    step: async () => {
      await flush();
      if (!done) t.mock.timers.tick(1);
    },
  });
  await flush();
  if (!done) throw new Error('did not settle');
  if (error) throw error;
  return Date.now() - t0;
}

/** A page as webContents shows one: loading state and its events, a URL and a DOM whose last change is known. */
function page(t: any) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const wc: any = new EventEmitter();
  Object.assign(wc, {
    destroyed: false,
    loading: false,
    url: 'https://a.test/',
    changed: Date.now() - 10_000,
    reads: 0,
    isDestroyed: () => wc.destroyed,
    isLoading: () => wc.loading,
    stop: () => void (wc.loading = false),
  });
  /** the page agent's state read: how long the DOM has been quiet */
  const dom = async () => {
    wc.reads++;
    return { quietMs: Date.now() - wc.changed };
  };
  /** a navigation starting in `at` ms: committed `commitMs` later, loaded `loadMs` after the start; a fresh DOM */
  const navigate = (at: number, url: string, { commitMs = 10, loadMs = 30 } = {}) => {
    setTimeout(() => {
      wc.loading = true;
      wc.emit('did-start-loading');
    }, at);
    setTimeout(() => {
      wc.url = url;
      wc.changed = Date.now();
      wc.emit('did-navigate');
    }, at + commitMs);
    setTimeout(() => {
      wc.loading = false;
      wc.emit('did-stop-loading');
    }, at + loadMs);
  };
  /** the DOM changes at each of `times` ms from now */
  const mutate = (...times: number[]) => {
    for (const at of times) setTimeout(() => void (wc.changed = Date.now()), at);
  };
  return { wc, dom, navigate, mutate };
}

test('an idle page settles when the navigation grace is over; a navigation that already loaded waits only for a quiet DOM', async (t) => {
  const { wc, dom } = page(t);
  // after an input that may navigate: no load started, the DOM was quiet long ago
  const ms = await timed(t, settlePage({ wc, dom }));
  assert.ok(ms >= NAV_GRACE_MS && ms <= NAV_GRACE_MS + 5, `${ms} ms`);
  assert.equal(wc.reads, 1, 'the DOM is read once the grace is over, not polled through it');
  // after a load (grace 0): a fresh document quiet for 10 ms returns once it has been quiet for DOM_QUIET_MS
  wc.changed = Date.now() - 10;
  const fresh = await timed(t, settlePage({ wc, dom }, { grace: 0 }));
  assert.ok(fresh >= DOM_QUIET_MS - 10 && fresh <= DOM_QUIET_MS, `${fresh} ms`);
  // already quiet: at once, the old floor (500 ms + 300 ms of quiet) is gone
  assert.equal(await timed(t, settlePage({ wc, dom }, { grace: 0 })), 0);
  // a route with nothing to read of the DOM settles as soon as its grace is over
  assert.equal(await timed(t, settlePage({ wc }, { grace: 0 })), 0);
  assert.equal(wc.listenerCount('did-start-loading'), 0, 'its listeners go when it returns');
});

test('a click that navigates: waits for the load and its fresh DOM, then skips the rest of the grace', async (t) => {
  const { wc, dom, navigate } = page(t);
  const loads: string[] = [];
  // the click's navigation started before the settle (isLoading at once)
  wc.loading = true;
  navigate(20, 'https://a.test/next', { commitMs: 5, loadMs: 40 });
  const ms = await timed(t, settlePage({ wc, dom, onLoad: () => loads.push(wc.url) }));
  assert.equal(wc.url, 'https://a.test/next');
  // loaded at 60, quiet DOM_QUIET_MS after its commit at 25: not held to the 350 ms grace
  assert.ok(ms >= 60 && ms < 25 + DOM_QUIET_MS + 10, `${ms} ms`);
  assert.deepEqual(loads, ['https://a.test/'], 'the old page is stale once, when its load starts');
});

test('a click that navigates later (setTimeout 100–300 ms) never returns before that navigation committed and loaded', async (t) => {
  for (const delay of [100, 200, 300]) {
    const { wc, dom, navigate } = page(t);
    navigate(delay, `https://a.test/after-${delay}`, { commitMs: 15, loadMs: 60 });
    const urls: string[] = [];
    const ms = await timed(t, settlePage({ wc, dom, onLoad: () => urls.push('stale') }));
    assert.equal(wc.url, `https://a.test/after-${delay}`, `${delay} ms: returned before the navigation committed`);
    assert.equal(wc.isLoading(), false);
    assert.ok(ms >= delay + 60, `${delay} ms: ${ms} ms`);
    assert.deepEqual(urls, ['stale']);
    t.mock.timers.reset();
  }
});

test('a frame loading or a route change that Electron reports as a load keeps the grace: a later top-level navigation is waited for', async (t) => {
  const { wc, dom, navigate } = page(t);
  // an iframe load (or a pushState, which Electron reports with did-start-loading) right after the click: no commit
  setTimeout(() => ((wc.loading = true), wc.emit('did-start-loading')), 5);
  setTimeout(() => ((wc.loading = false), wc.emit('did-stop-loading')), 25);
  // then the click handler's own navigation, 250 ms in
  navigate(250, 'https://a.test/later', { commitMs: 10, loadMs: 40 });
  const ms = await timed(t, settlePage({ wc, dom }));
  assert.equal(wc.url, 'https://a.test/later', 'returned before the delayed navigation committed');
  assert.ok(ms >= 290, `${ms} ms`);
});

test('a page that polls the network more often than the quiet window still settles soon after the grace', async (t) => {
  const { wc, dom } = page(t);
  const net = { last: Date.now() };
  let polling = true;
  const poll = () => {
    net.last = Date.now();
    if (polling) setTimeout(poll, 50);
  };
  poll();
  const ms = await timed(t, settlePage({ wc, dom, net: () => ({ inflight: 0, quietMs: Date.now() - net.last }) }));
  polling = false;
  // network events hold the quiet window only for NET_QUIET_MS after the grace; the DOM has been quiet all along
  assert.ok(ms >= NAV_GRACE_MS && ms <= NAV_GRACE_MS + NET_QUIET_MS + DOM_QUIET_MS + 5, `${ms} ms`);
});

test('a DOM read that does not answer before the deadline leaves the page as it is', async (t) => {
  const { wc } = page(t);
  const ms = await timed(t, settlePage({ wc, dom: () => new Promise(() => {}) }, { grace: 0, maxMs: 700 }));
  assert.equal(ms, 700);
});

test('an SPA click: a route change with a fetch and a late render waits for the network and the DOM', async (t) => {
  const { wc, dom, mutate } = page(t);
  const net = { inflight: 0, last: 0 };
  const netOf = () => ({ inflight: net.inflight, quietMs: Date.now() - net.last });
  // pushState at once (no load), a fetch from 5 to 420 ms, its list rendered at 450 and 470
  setTimeout(() => {
    wc.emit('did-navigate-in-page');
    net.inflight = 1;
    net.last = Date.now();
  }, 5);
  setTimeout(() => void (net.last = Date.now()), 200);
  setTimeout(() => ((net.inflight = 0), (net.last = Date.now())), 420);
  mutate(450, 470);
  const ms = await timed(t, settlePage({ wc, dom, net: netOf }));
  assert.ok(ms >= 470 + DOM_QUIET_MS && ms <= 470 + DOM_QUIET_MS + 5, `${ms} ms`);
  // a response with nothing rendered from it yet holds the page for the quiet window after it
  net.inflight = 1;
  net.last = Date.now();
  setTimeout(() => ((net.inflight = 0), (net.last = Date.now())), 60);
  const late = await timed(t, settlePage({ wc, dom, net: netOf }, { grace: 0 }));
  assert.ok(late >= 60 + DOM_QUIET_MS && late <= 60 + DOM_QUIET_MS + 5, `${late} ms`);
  // a request held open with no activity (a long poll) stops holding the page after NET_QUIET_MS
  net.inflight = 1;
  net.last = Date.now();
  const poll = await timed(t, settlePage({ wc, dom, net: netOf }, { grace: 0 }));
  assert.ok(poll >= NET_QUIET_MS && poll <= NET_QUIET_MS + 30, `${poll} ms`);
});

test('a page that never goes quiet, or never stops loading, is read as it is after the bound', async (t) => {
  const { wc, dom } = page(t);
  // the DOM changes every 30 ms, for as long as the settle looks
  let busy = true;
  const tick = () => {
    wc.changed = Date.now();
    if (busy) setTimeout(tick, 30);
  };
  tick();
  const ms = await timed(t, settlePage({ wc, dom }), 10_000);
  busy = false;
  assert.ok(ms >= SETTLE_MAX_MS && ms <= SETTLE_MAX_MS + 1, `${ms} ms`);
  wc.loading = true;
  const loading = await timed(t, settlePage({ wc, dom }, { maxMs: 1_000 }));
  assert.equal(loading, 1_000);
  assert.equal(wc.reads > 0, true);
});

test('a crashed renderer, a dialog, a closed tab or the user Stop end the wait', async (t) => {
  const { wc, dom } = page(t);
  // crashed (or a dialog up): nothing more to wait for, nothing is read
  const reads = wc.reads;
  assert.equal(await timed(t, settlePage({ wc, dom, ended: () => true })), 0);
  assert.equal(wc.reads, reads);
  // a dialog opening mid-wait
  let dialog = false;
  setTimeout(() => void (dialog = true), 100);
  wc.loading = true;
  assert.equal(await timed(t, settlePage({ wc, dom, ended: () => dialog })), 100);
  // the tab closed while loading: its destroyed event ends the wait at once
  setTimeout(() => ((wc.destroyed = true), wc.emit('destroyed')), 70);
  assert.equal(await timed(t, settlePage({ wc, dom })), 70);
  wc.destroyed = false;
  // the user's Stop interrupts a load wait, and a read under way
  setTimeout(() => stopLoading(wc), 40);
  await assert.rejects(timed(t, settlePage({ wc, dom })), { code: 'interrupted' });
  assert.equal(wc.isLoading(), false);
  const hanging = () => new Promise<any>(() => {});
  setTimeout(() => stopLoading(wc), 10);
  await assert.rejects(timed(t, settlePage({ wc, dom: hanging }, { grace: 0 })), { code: 'interrupted' });
});

test('reading the DOM: a document going away is a load to wait for; a failed read or an unwatchable page ends the wait', async (t) => {
  const { wc, dom, navigate } = page(t);
  clearIgnored();
  // the read fails because a navigation replaced the document: the settle waits for that load, then reads again
  let first = true;
  const swapped = async () => {
    if (first) {
      first = false;
      navigate(0, 'https://a.test/swapped', { commitMs: 1, loadMs: 50 });
      wc.loading = true;
      throw new Error('Execution context was destroyed.');
    }
    return dom();
  };
  const ms = await timed(t, settlePage({ wc, dom: swapped }, { grace: 0 }));
  assert.equal(wc.url, 'https://a.test/swapped');
  assert.ok(ms >= 50, `${ms} ms`);
  // a load that starts while the DOM is read is waited for too
  const during = async () => {
    const r = await dom();
    if (wc.url !== 'https://a.test/during') {
      navigate(0, 'https://a.test/during', { commitMs: 1, loadMs: 40 });
      wc.loading = true;
      wc.emit('did-start-loading');
    }
    return r;
  };
  wc.changed = Date.now() - 10_000;
  const d = await timed(t, settlePage({ wc, dom: during }, { grace: 0 }));
  assert.equal(wc.url, 'https://a.test/during');
  assert.ok(d >= 40, `${d} ms`);
  // a read that fails on a page that is not loading: nothing more to watch, noted
  assert.equal(await timed(t, settlePage({ wc, dom: () => Promise.reject(new Error('gone')) }, { grace: 0 })), 0);
  // a page the agent could not watch for changes
  assert.equal(await timed(t, settlePage({ wc, dom: async () => ({ quietMs: 0, observeError: 'no observer' }) }, { grace: 0 })), 0);
  const notes = recentIgnored().map((e: any) => `${e.context}: ${e.message}`);
  assert.ok(notes.includes('read whether the page is still changing after an action: gone'), notes.join('\n'));
  assert.ok(notes.includes('watch the page for DOM changes after an action: no observer'), notes.join('\n'));
});

test('BrowserTabs.settle: the tab feeds the shared settle; a tab no window shows (#1569) and a crashed one settle too', async (t) => {
  const h = setup(t);
  // a view tab parked with no window (background agents, a closed pane): no frame, no window, the same settle
  const asView = viewTabs();
  const tab = tabOf(h, 'tab_hidden', 'c', asView(h.newWC({ type: 'window', prefs: { sandbox: true, contextIsolation: true } })), null);
  let changed = Date.now();
  tab.wc.ops.state = () => ({ quietMs: Date.now() - changed });
  // the reported journey: a click that changes nothing, then the settle the browser_computer click runs
  await drive(t, h.tabs.click(tab, { x: 10, y: 10, name: 'Add to cart' }));
  assert.deepEqual(tab.wc.debugger.dropped, []);
  const t0 = Date.now();
  await drive(t, h.tabs.settle(tab), { step: 5 });
  const ms = Date.now() - t0;
  assert.ok(ms >= NAV_GRACE_MS && ms <= NAV_GRACE_MS + 30, `${ms} ms`);
  assert.ok(tab.wc.agentCalls.some((c: any) => c.op === 'state'));
  // requests in flight and active hold it; a smaller grace (a scroll, typing) is the caller's
  tab.inflight.add('r1');
  tab.lastNet = Date.now();
  changed = Date.now() - 1_000;
  setTimeout(() => (tab.inflight.delete('r1'), (tab.lastNet = Date.now())), 150);
  const n0 = Date.now();
  await drive(t, h.tabs.settle(tab, { grace: 100 }), { step: 5 });
  // the response ended at 150 ms: quiet DOM_QUIET_MS after it
  assert.ok(Date.now() - n0 >= 150 + DOM_QUIET_MS && Date.now() - n0 <= 150 + DOM_QUIET_MS + 30, `${Date.now() - n0} ms`);
  // a crashed renderer: settled at once, without asking the page
  tab.wc.crashed = true;
  const calls = tab.wc.agentCalls.length;
  const c0 = Date.now();
  await drive(t, h.tabs.settle(tab), { step: 5 });
  assert.equal(Date.now() - c0, 0);
  assert.equal(tab.wc.agentCalls.length, calls);
});

test('PanelBrowser (sage_browser_*): a click settles through the shared helper; its refs go with a load the click started', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const ui: any = { id: 1 };
  const session = { name: 'persist:browser' };
  const wc: any = new EventEmitter();
  Object.assign(wc, {
    id: 2,
    session,
    hostWebContents: ui,
    loading: false,
    isDestroyed: () => false,
    isCrashed: () => false,
    getType: () => 'webview',
    getURL: () => 'https://a.test/',
    getTitle: () => 'A',
    isLoading: () => wc.loading,
    debugger: {
      attached: false,
      isAttached: () => wc.debugger.attached,
      attach: () => void (wc.debugger.attached = true),
      sendCommand: async (method: string) => {
        if (method === 'Accessibility.getFullAXTree')
          return { nodes: [{ nodeId: '1', role: { value: 'link' }, name: { value: 'L' }, backendDOMNodeId: 5 }] };
        if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 10, 0, 10, 20, 0, 20] } };
        return {};
      },
    },
  });
  const panel = new PanelBrowser({ appContents: () => [ui], panelSession: () => session, open: () => {}, attachMs: 20 });
  panel.attach('c', wc, ui);
  await drive(t, panel.snapshot('c'));
  // no load: settled when the grace is over, refs kept
  const t0 = Date.now();
  await drive(t, panel.click('c', { ref: 'e1' }), { step: 5 });
  assert.ok(Date.now() - t0 >= NAV_GRACE_MS && Date.now() - t0 <= NAV_GRACE_MS + 30, `${Date.now() - t0} ms`);
  assert.equal(panel.tabs.get('c').refs.size, 1);
  // a load the click started at 30 ms: waited through (not held to the grace), and the old refs are gone
  setTimeout(() => ((wc.loading = true), wc.emit('did-start-loading')), 30);
  setTimeout(() => wc.emit('did-navigate'), 40);
  setTimeout(() => ((wc.loading = false), wc.emit('did-stop-loading')), 90);
  const l0 = Date.now();
  await drive(t, panel.click('c', { ref: 'e1' }), { step: 5 });
  assert.ok(Date.now() - l0 >= 90 && Date.now() - l0 < NAV_GRACE_MS, `${Date.now() - l0} ms`);
  assert.equal(panel.tabs.get('c').refs.size, 0);
});
