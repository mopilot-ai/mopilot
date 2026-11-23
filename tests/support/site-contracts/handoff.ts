// Site-permission contract unit cases for handoff.
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import {
  chromeHandoff,
  vendorChromeOf,
  vendorChromeIdOf,
  handoffRoute,
  createBrowserTools,
  explainRefusal,
  ToolError,
  inAppBrowserNote,
  blockedOf,
  followUpFor,
  controlHandoff,
  latestHandoff,
  skyProblemOfItem,
  skyStepWorked,
  isVendorInstructions,
  ROOT,
  CHAT,
  ctx,
  flush,
  grantsFor,
  iabTab,
  fs,
  require,
} from './fixture.ts';

export function registerHandoff() {
  test('CM-P13: the iab backend refuses with structured refusals the ways-forward strip recognizes', async () => {
    const k = await iabTab();
    k.g.denied.set(CHAT, new Set(['https://shop.test']));
    let message = '';
    try {
      await k.cdp(k.tab, 'Input.insertText', { text: 'x' });
    } catch (e: any) {
      message = e.message;
      assert.equal(e.reason, 'site_permission_denied');
      assert.equal(e.browser, 'iab');
    }
    const b = blockedOf({
      id: 'p1',
      type: 'mcpToolCall',
      server: 'cua_repl',
      tool: 'js',
      arguments: { code: 'await tab.cua.click(1, 1)' },
      status: 'completed',
      result: { content: [{ type: 'text', text: `Error: ${message}` }] },
    });
    assert.equal(b?.reason, 'site_permission_denied');
    assert.equal(b?.browser, 'iab');
    assert.equal(b?.origin, 'https://shop.test');
    assert.deepEqual(b?.choices, ['allowSite', 'openInBrowser', 'takeOver']);
    // a plain cua_repl result is no refusal
    assert.equal(
      blockedOf({ id: 'p2', server: 'cua_repl', tool: 'js', arguments: {}, result: { content: [{ type: 'text', text: 'done' }] } }),
      null,
    );
    // the JSON-RPC answer carries the refusal as data too
    const { Peer, FrameDecoder, encodeFrame } = require('../../../electron/capabilities/browser/iabBackend.cjs');
    const sock: any = Object.assign(new EventEmitter(), { destroyed: false, written: [] as any[], destroy() {} });
    sock.write = (buf: Buffer) => sock.written.push(...new FrameDecoder().push(buf));
    new Peer(
      sock,
      async () => {
        throw explainRefusal(new ToolError('The user did not allow https://a.test in this chat.', 'denied'), 'iab');
      },
      Promise.resolve(true),
    );
    sock.emit('data', encodeFrame({ jsonrpc: '2.0', id: 1, method: 'executeCdp', params: {} }));
    await flush();
    await flush();
    assert.deepEqual(sock.written[0].error.data, {
      reason: 'site_permission_denied',
      retryable: false,
      next: sock.written[0].error.data.next,
      browser: 'iab',
    });
  });

  /* ---------- Chrome hand-offs, credentials and refusals in the user's Chrome ---------- */

  test('CM-P14: "Continue in Chrome" for a chat whose agent drives Chrome itself opens the site in the user\'s Chrome for that agent, and the channel stays', async () => {
    // who drives each chat's Chrome is its current segment's controller plan (electron/session/controllerPlan.cjs)
    const plans: Record<string, { bu: string | null }> = {
      'claude-chat': { bu: 'claude-in-chrome' },
      'codex-chat': { bu: 'codex-browser-plugin' },
      'acp-chat': { bu: 'your-chrome' },
    };
    const vendor = (chatId: string) => vendorChromeOf(plans[chatId] ?? null);
    assert.equal(vendor('claude-chat'), 'Claude in Chrome');
    assert.equal(vendor('codex-chat'), 'the Codex Browser plugin');
    assert.equal(vendor('acp-chat'), null);
    assert.equal(vendor('no-chat'), null, 'a chat whose segment cannot be read has no plan');
    const configured: string[] = [];
    const opened: string[][] = [];
    const prefs = { channel: 'builtin' };
    const handoff = chromeHandoff({
      browserWindows: { owned: () => ({}) },
      chromeChannel: { has: () => false, instance: async () => ({ call: async () => ({}) }) },
      browserControl: {
        seq: 0,
        async configure(c: string) {
          this.seq++;
          configured.push(c);
          return c;
        },
      },
      isEnabled: () => true,
      getPrefs: () => prefs,
      commitPrefs: () => {},
      changed: () => {},
      route: (chatId: string) =>
        handoffRoute({ vendor: vendorChromeIdOf(plans[chatId] ?? null), relay: null, yourChrome: true, onChrome: false }),
      openSite: async (url: string, route: string) => void opened.push([url, route]),
    });
    for (const chatId of ['claude-chat', 'codex-chat']) {
      const r = await handoff({ chatId, url: 'https://a.test/' });
      assert.equal(r.ok, true, r.message);
      assert.equal(r.route, plans[chatId].bu);
    }
    assert.deepEqual(opened, [
      ['https://a.test/', 'claude-in-chrome'],
      ['https://a.test/', 'codex-browser-plugin'],
    ]);
    assert.deepEqual(configured, [], 'the global channel was not flipped');
    // the site handed to the user's Chrome is recorded per chat, so that chat's group holding it keeps no CLI (#1403)
    const { handedOff, forgetHandoffs } = require('../../../electron/capabilities/browser/handoffPages.cjs');
    assert.equal(handedOff('claude-chat', 'https://a.test/account'), true);
    assert.equal(handedOff('codex-chat', 'https://a.test/'), true, "the Codex Browser plugin route opens the user's Chrome too");
    // a chat that gets Your Chrome's tools goes ahead in its own instance, with no page named (the ways-forward strip)
    assert.equal((await handoff({ chatId: 'acp-chat', url: 'https://a.test/' })).ok, true);
    assert.deepEqual(configured, ['chrome']);
    assert.equal(handedOff('acp-chat', 'https://a.test/'), false, "its own Chrome instance is not the user's Chrome");
    for (const c of ['claude-chat', 'codex-chat']) forgetHandoffs(c);
  });

  test('CM-P15: a sign-in in the user’s Chrome is handed to the user there, not to an in-app tab; an old in-app tab doesn’t count', async () => {
    const tab: any = { id: 't1', url: 'https://a.test/', held: false, queue: Promise.resolve(), kind: 'tab' };
    let route: string | null = 'the Codex Browser plugin in your Chrome';
    const tabs: any = { current: () => tab, resolve: async () => tab };
    const tools = createBrowserTools({ tabs, grants: grantsFor('iab').g, chromeRoute: () => route, credentials: {} as any });
    const creds = tools.find((t: any) => t.name === 'browser_request_credentials');
    await assert.rejects(
      creds.handler({}, ctx),
      (e: any) =>
        e.code === 'wrong_browser' &&
        /the Codex Browser plugin in your Chrome/.test(e.message) &&
        /next: Ask the user in chat to sign in themselves in their Chrome/.test(e.message),
    );
    // main's route: the chat's own Chrome controller, else Your Chrome; an in-app tab only while the agent holds it
    const src = fs.readFileSync(new URL('electron/app/browserTools.cjs', ROOT), 'utf8');
    assert.match(src, /browserTabs\?\.current\(chatId\)\?\.held\) return null;/);
    route = null;
    assert.ok(tools);
  });

  test('CM-P16: a refusal in Your Chrome offers the user the step in their Chrome and allows the site in Chrome’s table', () => {
    const refused = explainRefusal(new ToolError('The user did not allow https://mail.test.', 'denied'), 'chrome');
    const b = blockedOf({
      id: 'c1',
      type: 'mcpToolCall',
      tool: 'mcp__sage__sage_browser_click',
      arguments: {},
      status: 'failed',
      error: { message: refused.message },
    })!;
    assert.equal(b.browser, 'chrome');
    assert.deepEqual(b.choices, ['allowSite', 'doItMyself'], 'no in-app tab to take over, and already in Chrome');
    assert.match(followUpFor('doItMyself', b, true), /in my Chrome\. Take a fresh snapshot/);
    // with no site named, only the step itself
    const ro = explainRefusal(new ToolError('Read only here.', 'read_only'), 'chrome');
    assert.deepEqual(blockedOf({ id: 'c2', tool: 'sage_browser_type', arguments: {}, error: { message: ro.message } })!.choices, [
      'doItMyself',
    ]);
    // allowing it lands in Chrome's own table (main's IPC picks the table by the refusal's browser)
    const src = fs.readFileSync(new URL('electron/app/ipc/browser.cjs', ROOT), 'utf8');
    assert.match(src, /const grantsOf = \(browser\) => \(browser === 'chrome' \? live\.chromeGrants : live\.browserGrants\);/);
  });

  /* ---------- the plugin's viewport, visibility, auto-attach, turns, marks, popups and dialogs ---------- */
}

export function registerRouting() {
  test('CM-P18: the routing note says the plugin’s Chrome backend drives the browser its extension connected', () => {
    const note = inAppBrowserNote('sage', true, true).value;
    assert.match(note, /Chrome backend drives the browser the ChatGPT extension is connected to/);
    assert.doesNotMatch(note, /get\("chrome"\)/, 'Chrome is selected by id (CM-W02), never by family');
    assert.doesNotMatch(note, /controls the user's own Chrome/);
    assert.match(inAppBrowserNote('sage', true, false).value, /Chrome backend drives the browser the ChatGPT extension is connected to/);
  });

  /* ---------- guards ---------- */

  /** Every CDP method the Codex Browser plugin's service sends (browser-desktop/scripts/browser-service.mjs, 26.1007). */
}

export function registerNarration() {
  const PLUGIN_INSTRUCTIONS = [
    '## Computer Use',
    '',
    'Control native apps and browsers on the user’s computer by reading or operating UI.',
    '- `cua_repl` state is persistent across calls',
    '# Browser Control Interruption',
    '- If browser use is interrupted because the extension or user took control, do not quote the raw runtime error. Summarize it naturally for the user, for example: "Browser use was stopped in the extension."',
    '# Other Browser APIs',
    '- A status of `user_took_over` means the user took manual control of the tab.',
    '## API',
    'x'.repeat(2000),
  ].join('\n');
  const cuaItem = (id: string, code: string, texts: string[], status = 'completed') => ({
    id,
    type: 'mcpToolCall',
    server: 'cua_repl',
    tool: 'js',
    arguments: { code, title: 'Step' },
    status,
    result: { content: texts.map((text) => ({ type: 'text', text })) },
  });

  test("CM-P21: the Codex Browser plugin's own instructions in a result are never a hand-off or a Computer Use problem", () => {
    const open = cuaItem('i1', 'let tab = await cua.createBrowserTab("iab", "http://localhost:8790/s/oauth", { visible: true });', [
      'Wall time: 1.1 seconds\nOutput:',
      PLUGIN_INSTRUCTIONS,
      'Browser tab: 1, Title: "Notes app"',
    ]);
    assert.equal(controlHandoff(open), null, 'no "You took over" strip after opening a page');
    assert.equal(latestHandoff([open]), null);
    // a hand-off the program makes still reads by its own words, not the instructions'
    const mark = cuaItem('i2', 'await tab.markHandoff(); // sign in needed', ['Wall time: 0.01 seconds\nOutput:', PLUGIN_INSTRUCTIONS]);
    assert.deepEqual(latestHandoff([open, mark])?.handoff, { where: 'app', reason: 'signIn', url: null, tabId: null });
    // the plugin's real interruption still counts
    assert.equal(
      controlHandoff(cuaItem('i3', 'await tab.click("#go")', ['{"status":"declined","reason":"user_took_over"}']))?.reason,
      'tookOver',
    );
    // main's Computer Use health reads the same results: the instructions are no Sky problem
    assert.equal(skyProblemOfItem(open), null);
    assert.equal(skyStepWorked(open), true);
    // only long markdown that opens with a heading and has several reads as instructions
    assert.equal(isVendorInstructions(PLUGIN_INSTRUCTIONS), true);
    for (const text of [null, '## Short\n# a\n# b', `Output:\n${PLUGIN_INSTRUCTIONS}`, `# One\n## Two\n${'x'.repeat(2000)}`]) {
      assert.equal(isVendorInstructions(text), false, String(text).slice(0, 20));
    }
  });

  test('CM-P22: a later program on a tab the chat opened in the in-app browser hands over in the in-app browser', () => {
    const open = cuaItem('i1', 'let tab = await cua.createBrowserTab("iab", "http://localhost:8790/s/2fa", { visible: true });', ['ok']);
    const mark = cuaItem('i2', 'await tab.markHandoff();', ['Wall time: 0.0085 seconds\nOutput:']);
    assert.deepEqual(latestHandoff([open, mark])?.handoff, { where: 'app', reason: 'continue', url: null, tabId: null });
    // the latest program that names a browser decides; Chrome stays Chrome
    const chrome = cuaItem('i3', 'tab = await cua.createBrowserTab("chrome", "https://a.test");', ['ok']);
    assert.equal(latestHandoff([open, chrome, mark])?.handoff.where, 'chrome');
    assert.equal(latestHandoff([cuaItem('i4', 'const t = await browser.user.openTabs();', ['[]']), mark])?.handoff.where, 'chrome');
    // programs that name no browser, and other REPL calls, are skipped on the way back
    const reset = { ...cuaItem('i5', '', ['ok']), tool: 'js_reset', arguments: {} };
    const odd = { ...cuaItem('i6', '', ['ok']), arguments: { code: 5 } };
    assert.equal(latestHandoff([open, reset, odd, cuaItem('i7', 'await tab.reload();', ['ok']), mark])?.handoff.where, 'app');
    // a tab an earlier turn opened: the REPL keeps it across turns
    assert.equal(latestHandoff([mark], [open])?.handoff.where, 'app');
    // with no earlier program naming one, the default stays Chrome
    assert.equal(latestHandoff([mark])?.handoff.where, 'chrome');
    assert.equal(controlHandoff(mark)?.where, 'chrome');
  });

  test('CM-P24: a program that names a backend by the id getState() gave it hands over in that browser (#1319 G26)', () => {
    // the plugin numbers its backends per thread, in no fixed order: what getState() printed says which is the iab one
    const state = (order: [string, string][]) =>
      cuaItem('s1', 'await cua.getState();', [
        'Wall time: 0.1 seconds\nOutput:',
        JSON.stringify({ apps: [], browsers: order.map(([id, type]) => ({ id, type, name: type, tabs: [] })) }),
      ]);
    const open = (id: string) =>
      cuaItem('o1', `let tab = await cua.createBrowserTab("${id}", "http://localhost:8790/s/checkout");`, ['ok']);
    const mark = cuaItem('m1', 'await tab.markHandoff();', ['Wall time: 0.05 seconds\nOutput:']);
    assert.equal(
      latestHandoff([
        state([
          ['1', 'extension'],
          ['2', 'iab'],
        ]),
        open('2'),
        mark,
      ])?.handoff.where,
      'app',
    );
    assert.equal(
      latestHandoff([
        state([
          ['1', 'iab'],
          ['2', 'extension'],
        ]),
        open('2'),
        mark,
      ])?.handoff.where,
      'chrome',
    );
    // getTab's browser option and browsers.get name a backend too; a tab id equal to a backend's id does not
    const both = state([
      ['1', 'iab'],
      ['2', 'extension'],
    ]);
    assert.equal(
      latestHandoff([both, cuaItem('g1', 'let tab = await cua.getTab("7", { browser: "1" });', ['ok']), mark])?.handoff.where,
      'app',
    );
    assert.equal(latestHandoff([both, cuaItem('g2', 'const b = await agent.browsers.get("1");', ['ok']), mark])?.handoff.where, 'app');
    assert.equal(
      latestHandoff([both, cuaItem('g3', 'let tab = await cua.getTab("1", { browser: "2" });', ['ok']), mark])?.handoff.where,
      'chrome',
    );
    // getState() in the same program that hands over
    const one = cuaItem(
      'a1',
      'await cua.getState(); let tab = await cua.createBrowserTab("2", "http://a.test"); await tab.markHandoff();',
      [JSON.stringify({ browsers: [{ id: '2', type: 'iab' }] })],
    );
    assert.equal(controlHandoff(one)?.where, 'app');
    // what isn't a backend list is skipped: other output, other REPL calls, entries without an id and type
    const noise = [
      cuaItem('n1', 'null', ['null']),
      cuaItem('n2', 'x', [JSON.stringify({ browsers: 'none' })]),
      cuaItem('n3', 'y', [JSON.stringify({ browsers: [null, { id: 2, type: 'iab' }, { id: '2' }] })]),
      { ...cuaItem('n4', '', [JSON.stringify({ browsers: [{ id: '2', type: 'iab' }] })]), tool: 'js_reset', arguments: {} },
    ];
    assert.equal(latestHandoff([...noise, open('2'), mark])?.handoff.where, 'chrome');
  });
}
