// main wiring browser control matrix cases using shared fake surfaces.
import { test, assert, MOVED_PREFIX, NO_CHROME, BOOKING } from './fixture.ts';
import { bindActualControllerPlans } from '../main-controller-plan.ts';

export function registerCredentialWiring() {
  /* ====================================================================== */
  /* Browser use: the credential hand-off route, in main's own wiring        */
  /* ====================================================================== */

  test("CM-B03: browser_request_credentials on a chat now on Codex does not name the earlier segment's Claude in Chrome", async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const { loadMain, unloadMain, flush } = await import('../electron-main-harness.ts');
    const h = await loadMain({
      before: (h) => {
        h.mods['electron/capabilities/browser/host.cjs'] = { BrowserTabs: h.cls('BrowserTabs') };
        h.mods['electron/capabilities/browser/windows.cjs'] = { BrowserWindows: h.cls('BrowserWindows') };
        h.mods['electron/capabilities/browser/hostTools.cjs'] = {
          registerBrowserTools: t.mock.fn(),
          inAppBrowserEnabled: t.mock.fn(() => true),
        };
      },
    });
    try {
      await h.ready();
      await flush();
      const [, o] = h.mod('capabilities/browser/hostTools.cjs').registerBrowserTools.mock.calls[0].arguments;
      h.one('BrowserTabs').current = () => null;
      h.one('BrowserControl').drivesUserChrome = () => false;
      // the earlier Claude segment's CLI is still alive with a connected Claude in Chrome (CM-B02)
      h.one('SessionStore').get = () => ({ chromeLink: { connected: true, dropped: false } });
      // while the chat runs on Claude Code, its browser is Claude in Chrome (its segment's controller plan says so)
      h.one('ChatController').ref = () => ({ kind: 'claude', id: 's0' });
      h.one('ControllerPlans').current = () => ({ bu: 'claude-in-chrome' });
      assert.equal(o.chromeRoute('chat-b03'), 'Claude in Chrome');
      // after the switch to Codex, it is not: the Codex segment's plan names no Claude in Chrome (CM-A02)
      h.one('ChatController').ref = () => ({ kind: 'codex', id: 'cx-1' });
      h.one('ControllerPlans').current = () => ({ bu: null });
      assert.notEqual(o.chromeRoute('chat-b03'), 'Claude in Chrome');
    } finally {
      unloadMain();
    }
  });
}

export function registerRouteWiring() {
  test("CM-B26: main's wiring: the route comes from the chat's current plan, the switches and the channel; Open in Chrome opens through the route's opener and moves the waiting sign-in", async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const { loadMain, unloadMain, flush } = await import('../electron-main-harness.ts');
    const opens: any[] = [];
    const h = await loadMain({
      before: (h) => {
        h.mods['electron/capabilities/browser/host.cjs'] = { BrowserTabs: h.cls('BrowserTabs') };
        h.mods['electron/capabilities/browser/windows.cjs'] = { BrowserWindows: h.cls('BrowserWindows') };
        h.mods['electron/capabilities/browser/hostTools.cjs'] = {
          registerBrowserTools: t.mock.fn(),
          inAppBrowserEnabled: t.mock.fn(() => true),
        };
        // never a real browser: the opener records what it was asked
        h.mods['electron/capabilities/nativeAvailability.cjs'].vendorChromeProfile = (c: string) => ({ paired: c });
        h.mods['electron/capabilities/browser/openSite.cjs'] = {
          openSiteForRoute: async (url: string, route: string, o: any) => void opens.push({ url, route, o }),
        };
      },
    });
    try {
      await h.ready();
      await flush();
      const w = h.windows[0];
      const moved: any[] = [];
      h.one('BrowserTabs').current = () => null;
      h.one('BrowserTabs').signinMoved = (chatId: string, note: string) => moved.push([chatId, note]);
      h.one('BrowserWindows').owned = () => ({});
      assert.equal(await h.invokeFrom(w.webContents, 'browser:handoffRoute', 'chat'), 'none', 'absent snapshot is not readiness');
      let vendor: string | null = null;
      let kind = 'codex';
      h.one('ChatController').ref = () => ({ kind, id: 'thread', key: 'thread' });
      h.one('Registry').list = () => [{ name: 'sage_browser_snapshot' }];
      const tools = h.one('CodexToolInjection');
      tools.hasTools = () => true;
      tools.toolsOf = () => null;
      tools.loadedPath = () => null;
      tools.routedSurfaces = () => ({ surfaces: { chrome: vendor === 'codex-browser-plugin' } });
      h.claude.nativeChromeOf.mock.mockImplementation(() => vendor === 'claude-in-chrome');
      h.claude.toolsOf.mock.mockImplementation(() => null);
      const plans = bindActualControllerPlans(h);
      const plan = (bu: string | null) => {
        vendor = bu;
        kind = bu === 'claude-in-chrome' ? 'claude' : 'codex';
        h.one('ControllerPlans').snapshot = plans.snapshot.bind(plans);
      };
      plan('codex-browser-plugin');
      assert.equal(await h.invokeFrom(w.webContents, 'browser:handoffRoute', 'chat'), 'codex-browser-plugin');
      assert.equal(await h.invokeFrom(w.webContents, 'browser:handoffRoute', 7), 'none');
      const continuation = await h.invokeFrom(w.webContents, 'browser:handoffContinuation', { chatId: 'chat', url: BOOKING });
      assert.equal(continuation.precondition.url, BOOKING);
      assert.match(continuation.message, /Codex Browser/);
      // a sign-in the user says they finished: only the user's short line says so (#2030)
      const signedIn = await h.invokeFrom(w.webContents, 'browser:handoffContinuation', { chatId: 'chat', url: BOOKING, signedIn: true });
      assert.match(signedIn.message, /\nSigned in\. Continue in Chrome · [^\n]+$/);
      assert.match(continuation.message, /\nContinue in Chrome · [^\n]+$/);
      // This harness's Proxy invents functions on read: require an installed own property first.
      const ctl = h.one('ChatController');
      const guard = Object.getOwnPropertyDescriptor(ctl, 'chromeContinuationCheck');
      assert.equal(typeof guard?.value, 'function');
      const input = { opts: { chromeHandoff: continuation.precondition } };
      assert.doesNotThrow(() => guard!.value({ chatId: 'chat', item: input }));
      plan('claude-in-chrome');
      assert.throws(() => guard!.value({ chatId: 'chat', item: input }), /controller changed/);
      assert.doesNotThrow(() => guard!.value({ chatId: 'chat', item: { opts: {} } }));
      plan('codex-browser-plugin');
      await assert.rejects(async () => h.invokeFrom(w.webContents, 'browser:handoffContinuation'), /valid site/);
      const r = await h.invokeFrom(w.webContents, 'browser:continueInChrome', { chatId: 'chat', url: BOOKING });
      assert.equal(r.ok, true, r.message);
      assert.equal(opens.length, 1);
      assert.deepEqual([opens[0].url, opens[0].route], [r.url, 'codex-browser-plugin']);
      assert.equal(typeof opens[0].o.openExternal, 'function');
      assert.equal(typeof opens[0].o.vendorProfile, 'function');
      assert.equal(moved.length, 1);
      assert.equal(moved[0][0], 'chat');
      assert.ok(moved[0][1].startsWith(MOVED_PREFIX));
      // the opener opens what it is told in the default browser, and asks the probe for the vendor's browser
      await opens[0].o.openExternal('https://x.test/');
      assert.deepEqual(opens[0].o.vendorProfile('claude-in-chrome'), { paired: 'claude-in-chrome' });
      // Claude in Chrome on a Claude segment; a plan naming no vendor goes by the switches
      plan('claude-in-chrome');
      assert.equal(await h.invokeFrom(w.webContents, 'browser:handoffRoute', 'chat'), 'claude-in-chrome');
      plan(null);
      assert.equal(await h.invokeFrom(w.webContents, 'browser:handoffRoute', 'chat'), 'your-chrome');
      h.one('ControllerPlans').snapshot = () => null;
      assert.equal(await h.invokeFrom(w.webContents, 'browser:handoffRoute', 'chat'), 'none');
      plan(null);
      const flags = h.mod('platform/flags.cjs').isEnabled;
      flags.mock.mockImplementation(
        (k: string) => k !== 'shared.browser.extension' && !k.startsWith('shared.browser.chrome') && k !== 'shared.browser.viewTabs',
      );
      assert.equal(await h.invokeFrom(w.webContents, 'browser:handoffRoute', 'chat'), 'none');
      assert.deepEqual(await h.invokeFrom(w.webContents, 'browser:continueInChrome', { chatId: 'chat', url: BOOKING }), {
        ok: false,
        message: NO_CHROME,
      });
    } finally {
      unloadMain();
    }
  });
}
