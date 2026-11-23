// sign in browser control matrix cases using shared fake surfaces.
import {
  test,
  assert,
  EventEmitter,
  setupTabs,
  tabOfKit,
  controlHandoff,
  continueMessage,
  MOVED_PREFIX,
  NO_CHROME,
  chromeHandoff,
  createBrowserTools,
  openSiteForRoute,
  BOOKING,
} from './fixture.ts';

export function registerSignIn() {
  /** Browser settings as they stay during a hand-off. */
  const BUILTIN = { channel: 'builtin', profileDir: '' };
  /** The hand-off as main runs it, over a real BrowserTabs whose tab waits in browser_request_signin. */
  function signinWorld(t: any, route: string) {
    const h = setupTabs(t);
    const tab = tabOfKit(h);
    tab.wc.url = 'https://accounts.google.com/v3/signin/challenge/pk';
    const tools = createBrowserTools({ tabs: h.tabs, grants: { anchor: () => 'ask' }, credentials: {} });
    const signin = tools.find((x: any) => x.name === 'browser_request_signin');
    const opened: string[][] = [];
    const configured: string[] = [];
    const handoff = chromeHandoff({
      browserWindows: { owned: () => ({}) },
      chromeChannel: {
        has: () => false,
        instance: async () => {
          throw new Error('the Playwright Extension is not installed');
        },
      },
      browserControl: {
        seq: 0,
        async configure(c: string) {
          configured.push(c);
          return c;
        },
      },
      isEnabled: () => true,
      getPrefs: () => BUILTIN,
      commitPrefs: () => {},
      changed: () => {},
      route: () => route,
      openSite: async (url: string, r: string) => void opened.push([url, r]),
      signinMoved: (chatId: string, note: string, wcId: number | undefined) => h.tabs.signinMoved(chatId, note, wcId),
    });
    return { h, tab, signin, handoff, opened, configured };
  }
  /** What a browser_* call returned to the agent: its text (the browser state follows the first part). */
  const said = async (call: Promise<any>) => {
    const out = await call;
    return Array.isArray(out) ? String(out[0]?.text ?? '') : String(out);
  };
  /** A finished tool call as every harness's thread shows it (a Codex or ACP MCP call, or Claude's mcp__sage__ name). */
  const narrated = (tool: string, args: any, text: string) => ({
    id: `n-${tool}`,
    type: 'mcpToolCall',
    server: 'sage',
    tool,
    arguments: args,
    status: 'completed',
    result: { content: [{ type: 'text', text }] },
  });

  test("CM-B22: Open in Chrome on Claude in Chrome or the Codex Browser plugin opens the site in the user's Chrome and tells the agent to continue there with its own tool", async (t) => {
    for (const [route, tool] of [
      ['codex-browser-plugin', /browser\.user\.openTabs\(\)\) and claim the one at .* \(browser\.user\.claimTab\)/],
      ['claude-in-chrome', /with Claude in Chrome: call tabs_context_mcp, then navigate a tab of your tab group to /],
    ] as const) {
      const s = signinWorld(t, route);
      // the agent handed the in-app tab to the user (browser_request_signin): the call returns at once (#1834)
      assert.match(await said(s.signin.handler({ tabId: s.tab.id, reason: 'Google sign-in' }, { chatId: 'c', signal: null })), /^Handed /);
      assert.ok(s.tab.signin, "the in-app tab is the user's");
      const r = await s.handoff({ chatId: 'c', url: BOOKING });
      assert.equal(r.ok, true, r.message);
      assert.equal(r.route, route);
      assert.deepEqual(s.opened, [[r.url, route]], "the site opens in the user's Chrome, the vendor's own browser");
      assert.deepEqual(s.configured, [], "the browser channel stays: the vendor drives the user's Chrome");
      // the hand-off ends, and the agent's next browser result says where to continue, never a button on a tab the user left
      const note = s.tab.signinMoved;
      assert.ok(note.startsWith(MOVED_PREFIX), note);
      assert.match(note, tool);
      assert.ok(note.includes(r.url));
      assert.equal(s.tab.signin, null);
      assert.ok(s.h.tabs.state('c').includes(note));
      // the chat's strip turns into a hand-off in Chrome, for every harness's naming of the call
      for (const name of ['mcp__sage__browser_request_signin', 'browser_request_signin']) {
        const h = controlHandoff(narrated(name, { tabId: s.tab.id }, note));
        assert.deepEqual(h, { where: 'chrome', reason: 'signIn', url: r.url, tabId: null });
      }
      // the pane's "Continue task in Chrome" names the same tool
      assert.match(continueMessage(route, r.url), tool);
    }
  });

  test("CM-B23: MoPilot's own Chrome extension and the relay open the site in their Chrome profile, with no Playwright Extension and no channel switch", async (t) => {
    for (const route of ['extension', 'relay'] as const) {
      const s = signinWorld(t, route);
      await s.signin.handler({ tabId: s.tab.id }, { chatId: 'c', signal: null });
      const r = await s.handoff({ chatId: 'c', url: BOOKING });
      assert.equal(r.ok, true, r.message);
      assert.deepEqual(s.opened, [[r.url, route]]);
      assert.deepEqual(s.configured, []);
      assert.match(
        s.tab.signinMoved,
        /with your Chrome tools: call chrome_tabs_context_mcp, then navigate a tab of this chat's tab group to /,
      );
    }
    // the opener: the chrome_* tools' profile; a vendor's paired browser and profile on macOS; the default browser otherwise
    const spawned: any[] = [];
    const spawn = (cmd: string, args: string[]) => {
      spawned.push([cmd, ...args]);
      const child: any = new EventEmitter();
      // Google Chrome isn't installed for b.test: open fails
      setImmediate(() => child.emit('exit', args.includes('https://b.test/') ? 1 : 0));
      return child;
    };
    const external: string[] = [];
    const relayOpened: any[] = [];
    const o = (extra: any = {}) => ({
      openExternal: async (u: string) => void external.push(u),
      openInChrome: async (u: string, p: any) => void relayOpened.push([u, p]),
      vendorProfile: (c: string) => (c === 'claude-in-chrome' ? { browser: 'brave', name: 'Brave', profile: 'Profile 1' } : null),
      profileDir: 'Profile 3',
      platform: 'darwin',
      spawn,
      // a real user's environment, whatever the shell running the tests has set
      env: {},
      ...extra,
    });
    await openSiteForRoute('https://a.test/', 'extension', o());
    assert.deepEqual(relayOpened, [['https://a.test/', { profileDir: 'Profile 3' }]]);
    await openSiteForRoute('https://a.test/', 'claude-in-chrome', o());
    await openSiteForRoute('https://a.test/', 'codex-browser-plugin', o());
    assert.deepEqual(spawned, [
      ['open', '-na', 'Brave Browser', '--args', '--profile-directory=Profile 1', 'https://a.test/'],
      ['open', '-a', 'Google Chrome', 'https://a.test/'],
    ]);
    assert.deepEqual(external, []);
    // a vendor paired with Google Chrome opens in its profile there
    spawned.length = 0;
    await openSiteForRoute(
      'https://a.test/',
      'codex-browser-plugin',
      o({ vendorProfile: () => ({ browser: 'chrome', name: 'Google Chrome', profile: 'Default' }) }),
    );
    assert.deepEqual(spawned, [['open', '-na', 'Google Chrome', '--args', '--profile-directory=Default', 'https://a.test/']]);
    // Google Chrome isn't installed (open fails), the relay can't start Chrome, or not a Mac: the default browser
    await openSiteForRoute('https://b.test/', 'codex-browser-plugin', o());
    await openSiteForRoute('https://c.test/', 'relay', o({ openInChrome: async () => Promise.reject(new Error('no Chrome')) }));
    await openSiteForRoute('https://d.test/', 'claude-in-chrome', o({ platform: 'win32' }));
    assert.deepEqual(external, ['https://b.test/', 'https://c.test/', 'https://d.test/']);
    // a spawn error is a failure too
    const broken = () => {
      const child: any = new EventEmitter();
      setImmediate(() => child.emit('error', new Error('ENOENT')));
      return child;
    };
    await openSiteForRoute('https://e.test/', 'codex-browser-plugin', o({ spawn: broken }));
    assert.equal(external.at(-1), 'https://e.test/');
  });

  test("CM-B24: a chat with no Chrome controller is told why and opens nothing; a site that can't open is an accurate failure", async (t) => {
    const s = signinWorld(t, 'none');
    const r = await s.handoff({ chatId: 'c', url: BOOKING });
    assert.deepEqual(r, { ok: false, message: NO_CHROME });
    assert.match(NO_CHROME, /Turn it on, or sign in another way\.$/);
    assert.deepEqual([s.opened, s.configured], [[], []]);
    // the opener fails (no browser could take it): said so, and the tab stays the user's
    const failing = chromeHandoff({
      browserWindows: { owned: () => ({}) },
      getPrefs: () => ({}),
      route: () => 'codex-browser-plugin',
      openSite: async () => {
        throw new Error('no browser');
      },
      signinMoved: () => assert.fail('nothing moved'),
    } as any);
    assert.deepEqual(await failing({ chatId: 'c', url: BOOKING }), {
      ok: false,
      message: 'Could not open the site in your Chrome: no browser.',
    });
    const quiet = chromeHandoff({
      browserWindows: { owned: () => ({}) },
      getPrefs: () => ({}),
      route: () => 'relay',
      openSite: async () => Promise.reject(new Error('')),
    } as any);
    assert.equal((await quiet({ chatId: 'c', url: BOOKING })).message, 'Could not open the site in your Chrome: it did not start.');
    // a hand-off main was never given an opener for says so rather than pretending
    const bare = chromeHandoff({ browserWindows: { owned: () => ({}) }, getPrefs: () => ({}), route: () => 'relay' } as any);
    assert.match((await bare({ chatId: 'c', url: BOOKING })).message, /not available here/);
    // the default route is Your Chrome, and moving a sign-in nobody waits on changes nothing
    const yc = chromeHandoff({
      browserWindows: { owned: () => ({}) },
      chromeChannel: { has: () => true, instance: async () => ({ call: async () => ({}) }) },
      browserControl: {
        seq: 0,
        async configure(c: string) {
          this.seq++;
          return c;
        },
      },
      isEnabled: () => true,
      getPrefs: () => BUILTIN,
      commitPrefs: () => {},
      changed: () => {},
    } as any);
    assert.equal((await yc({ chatId: 'c', url: BOOKING })).route, 'your-chrome');
    assert.equal(s.h.tabs.signinMoved('c', 'note'), false);
  });

  test("CM-B25: Your Chrome ends the hand-off too; Done, continue twice, or after the move, does nothing more; a stopped turn leaves the tab the user's", async (t) => {
    const s = signinWorld(t, 'your-chrome');
    const yc = chromeHandoff({
      browserWindows: { owned: () => ({}) },
      chromeChannel: { has: () => false, instance: async () => ({ call: async () => ({}) }) },
      browserControl: {
        seq: 0,
        async configure(c: string) {
          this.seq++;
          return c;
        },
      },
      isEnabled: () => true,
      getPrefs: () => BUILTIN,
      commitPrefs: () => {},
      changed: () => {},
      route: () => 'your-chrome',
      signinMoved: (chatId: string, note: string) => s.h.tabs.signinMoved(chatId, note),
    });
    await s.signin.handler({ tabId: s.tab.id }, { chatId: 'c', signal: null });
    assert.equal((await yc({ chatId: 'c', url: BOOKING })).ok, true);
    assert.match(s.h.tabs.state('c'), /with your Chrome browser tools at .*: take a fresh snapshot in this chat's Chrome tab group/);
    // the strip's Done, continue after the move: nothing holds, so it tells the agent in a message instead (HandoffStrip)
    assert.equal(await s.h.tabs.signinDone('c', null), false);
    // Done, continue pressed twice: the second finds nothing held
    await s.signin.handler({ tabId: s.tab.id }, { chatId: 'c', signal: null });
    assert.equal(s.tab.signinMoved, '', 'a new hand-off forgets the old move');
    assert.equal(await s.h.tabs.signinDone('c', s.tab.id), true);
    assert.equal(await s.h.tabs.signinDone('c', s.tab.id), false);
    assert.match(s.h.tabs.state('c'), /user_done tab_aaaaaa: the user finished on accounts\.google\.com; read the page again/);
    assert.equal(s.h.tabs.signinMoved('c', 'late'), false, 'a move after Done, continue finds nothing held');
    // the turn is stopped after the hand-off (the call already returned): the tab stays the user's until Stop ends it
    const stop = new AbortController();
    await s.signin.handler({ tabId: s.tab.id }, { chatId: 'c', signal: stop.signal });
    stop.abort();
    await s.h.tabs.turnEnded('c');
    assert.ok(s.tab.signin);
    assert.equal(s.h.tabs.endHandoffs('c', 'stopped'), 1);
    assert.equal(s.h.tabs.signinMoved('c', 'note'), false);
    const v = signinWorld(t, 'codex-browser-plugin');
    assert.equal((await v.handoff({ chatId: 'c', url: BOOKING })).ok, true);
    assert.equal(v.opened.length, 1);
    // only the handed-off page's hand-off moves: another tab on another site stays the user's; a popup's opener counts
    const other = tabOfKit(v.h, 'tab_bbbbbb');
    other.wc.url = 'https://github.com/login';
    const popup = v.h.tabs.adoptPopup(v.tab.wc, v.h.popupWC());
    popup.wc.url = 'https://accounts.google.com/o/oauth2';
    await v.signin.handler({ tabId: other.id }, { chatId: 'c', signal: null });
    await v.signin.handler({ tabId: popup.id }, { chatId: 'c', signal: null });
    assert.equal((await v.handoff({ webContentsId: v.tab.wc.id, chatId: 'c', url: BOOKING })).ok, true);
    assert.ok(popup.signinMoved.startsWith(MOVED_PREFIX), "the popup's hand-off moved with its opener's page");
    assert.equal(popup.signin, null);
    assert.ok(other.signin, "the other site is still the user's");
    assert.equal(await v.h.tabs.signinDone('c', other.id), true);
    assert.equal(other.signin, null);
  });
}
