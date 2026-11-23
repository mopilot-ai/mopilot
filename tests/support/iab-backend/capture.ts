// Built-in browser backend capture unit cases with shared tab, host and grant fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { require, FRAME_SCRIPT, S, tick, backend, withTab } from './fixture';

export function registerCaptureCases() {
  test('screenshots and screencasts mask password fields and hide the cursor; detach unmasks a screencast', async () => {
    const { b, call, tab, host } = await withTab();
    const cdp = (method: string) => call('executeCdp', { target: { tabId: 1 }, method, commandParams: {} });
    tab.frames.set('c1', {});
    tab.masked = 1;
    await cdp('Page.captureScreenshot');
    assert.deepEqual(
      tab.agents.map((a: any) => [a[1].on, a[2]]),
      [
        [true, ''],
        [true, 'c1'],
        [false, ''],
        [false, 'c1'],
      ],
    );
    assert.ok(tab.sends.some((s: any) => s[0] === 'Runtime.evaluate' && s[1].expression === FRAME_SCRIPT));
    assert.deepEqual([host.o.cursor.conceals, host.o.cursor.reveals], [1, 1]);
    // a failing capture still unmasks
    tab.reply['Page.captureScreenshot'] = () => Promise.reject(new Error('no'));
    await assert.rejects(cdp('Page.captureScreenshot'), /no/);
    assert.equal(host.o.cursor.reveals, 2);
    // a screencast: masked from start to stop, once
    tab.agents.length = 0;
    tab.masked = 0;
    await cdp('Page.startScreencast');
    await cdp('Page.startScreencast');
    assert.equal(tab.agents.length, 2);
    await cdp('Page.stopScreencast');
    await cdp('Page.stopScreencast');
    assert.equal(tab.agents.length, 4);
    // a world that fails and a frame paint that never comes are both survived
    tab.agentFail = true;
    tab.masked = 1;
    await cdp('Page.startScreencast');
    // detaching mid-screencast takes the mask off
    tab.agentFail = false;
    tab.agents.length = 0;
    await call('detach', { tabId: 1 });
    await tick();
    assert.deepEqual(
      tab.agents.map((a: any) => a[1].on),
      [false, false],
    );
    // without a cursor, masking still works
    host.o.cursor = null;
    await b.conceal(tab, true);
    // the paint wait is bounded
    tab.masked = 1;
    tab.reply['Runtime.evaluate'] = () => Promise.reject(new Error('x'));
    await b.conceal(tab, true);
    // a frame whose mask cannot be taken off is recorded
    const { recentIgnored, clearIgnored } = require('../../../electron/ignored.cjs');
    clearIgnored();
    tab.agentFail = true;
    await b.conceal(tab, false);
    tab.agentFail = false;
    assert.ok(recentIgnored().some((e: any) => e.context === 'unmask password fields in a frame for the browser plugin'));
    // a nested frame the page could not reach is recorded; the rest is masked
    clearIgnored();
    tab.reply['Runtime.evaluate'] = () => ({});
    tab.unreadable = ['TypeError: frame torn down'];
    await b.conceal(tab, true);
    tab.unreadable = null;
    assert.ok(
      recentIgnored().some(
        (e: any) =>
          e.context === 'mask password fields in a nested frame for the browser plugin' && e.message === 'TypeError: frame torn down',
      ),
    );
    clearIgnored();
  });

  test('cached expressions, marks, downloads, the turn end, visibility and viewport', async () => {
    const { b, call, tab, host } = await withTab();
    const cached = (commandParams: any) =>
      call('executeCdpWithCachedExpression', { expressionCacheKey: 'k', target: { tabId: 1 }, method: 'Runtime.evaluate', commandParams });
    assert.deepEqual(await cached(undefined), { kind: 'cache-miss' });
    assert.deepEqual(await cached({ expression: '1+1', returnByValue: true }), { kind: 'executed', result: { ok: 'Runtime.evaluate' } });
    await cached({ returnByValue: true });
    assert.deepEqual(tab.sends.at(-1), ['Runtime.evaluate', { returnByValue: true, expression: '1+1' }, '']);
    await call('markTab', { tabId: 1, status: 'handoff', turn_id: 't' });
    assert.deepEqual(host.calls.at(-1), ['mark', `chat:${S}`, 'tab_1', 'handoff']);
    await assert.rejects(call('markTab', { tabId: 1, status: 'x' }), /invalid status x/);
    assert.equal(await call('allowDownload', { tabId: 1, url: 'https://x/' }), null);
    await assert.rejects(call('allowDownload', { tabId: 7 }), /Unknown tab/);
    await call('attach', { tabId: 1 });
    assert.equal(await call('turnEnded', { turn_id: 't' }), null);
    assert.equal(b.held.size, 0);
    assert.equal(b.controlled.size, 0);
    // visibility and viewport
    const cmd = (p: any) => call('executeUnhandledCommand', p);
    assert.deepEqual(await cmd({ type: 'browser_visibility_get' }), { visible: false });
    tab.layer = 'front';
    assert.deepEqual(await cmd({ type: 'browser_visibility_get' }), { visible: true });
    assert.deepEqual(await cmd({ type: 'browser_visibility_set', visible: true }), {});
    assert.deepEqual(host.calls.at(-1), ['select', `chat:${S}`, 'tab_1']);
    // the pane is the user's: an agent can't hide it
    await assert.rejects(cmd({ type: 'browser_visibility_set', visible: false }), /can't be hidden/);
    // the viewport goes on the tabs the plugin holds
    await call('attach', { tabId: 1 });
    assert.deepEqual(await cmd({ type: 'browser_viewport_set', width: 400, height: 800 }), {});
    assert.deepEqual(tab.sends.at(-1), [
      'Emulation.setDeviceMetricsOverride',
      { width: 400, height: 800, deviceScaleFactor: 0, mobile: false },
      '',
    ]);
    assert.deepEqual(await cmd({ type: 'browser_viewport_reset' }), {});
    assert.equal(tab.sends.at(-1)[0], 'Emulation.clearDeviceMetricsOverride');
    await assert.rejects(cmd({ type: 'tabs_content' }), /Unsupported command for MoPilot's built-in browser: tabs_content/);
    // with nothing in front, hidden already holds; with no current tab, showing waits for the next tab; with no tab
    // held, the viewport says so; a reset with nothing set does nothing
    tab.layer = 'back';
    assert.deepEqual(await cmd({ type: 'browser_visibility_set', visible: false }), {});
    host.cur = null;
    await call('turnEnded', {});
    const n = tab.sends.length;
    assert.deepEqual(await cmd({ type: 'browser_visibility_set', visible: true }), {});
    await assert.rejects(cmd({ type: 'browser_viewport_set', width: 1, height: 1 }), /attach a tab first/);
    await cmd({ type: 'browser_viewport_reset' });
    assert.equal(tab.sends.length, n);
  });

  // Guard: the vendor's cua.createBrowserTab('iab', url, { visible }) (@oai/cua tinysky_alt/create_browser_api.js)
  // runs visibility.set(visible), then tabs.new(), then tab.goto(url): in a fresh chat, each step must work.
}

export function registerViewportRecoveryCases() {
  test('the plugin viewport skips a tab whose renderer is gone and sizes it when it comes back', async () => {
    const { call, host } = backend();
    const created = await call('createTab');
    const tab = host.tabs[0];
    await call('attach', { tabId: created.id });
    tab.gone = true;
    const viewport = () => tab.sends.filter((x: any) => x[0].startsWith('Emulation.')).length;
    assert.deepEqual(await call('executeUnhandledCommand', { type: 'browser_viewport_set', width: 400, height: 800 }), {});
    assert.equal(viewport(), 0);
    // still gone: the next command doesn't size it either
    await call('executeCdp', { target: { tabId: created.id }, method: 'Page.reload', commandParams: {} });
    assert.equal(viewport(), 0);
    // back: the next command it carries sizes it first
    tab.gone = false;
    await call('executeCdp', { target: { tabId: created.id }, method: 'Runtime.evaluate', commandParams: { expression: '1' } });
    assert.deepEqual(tab.sends.filter((x: any) => x[0].startsWith('Emulation.'))[0][1], {
      width: 400,
      height: 800,
      deviceScaleFactor: 0,
      mobile: false,
    });
    await call('executeCdp', { target: { tabId: created.id }, method: 'Runtime.evaluate', commandParams: { expression: '2' } });
    assert.equal(viewport(), 1, 'sized once');
    // a reset on a tab whose renderer went again sends nothing to it
    tab.gone = true;
    assert.deepEqual(await call('executeUnhandledCommand', { type: 'browser_viewport_reset' }), {});
    assert.equal(viewport(), 1);
  });
}
