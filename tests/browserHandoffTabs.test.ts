// Browser hand-offs (BU-12) and browser tab mentions (BU-09). A hand-off is read from a turn's tool
// items through the narration adapters (src/lib/agentNarration.ts), so MoPilot's built-in browser_*
// tools, Claude in Chrome and the Codex Browser plugin (cua_repl programs) show one strip
// (src/components/thread/HandoffStrip.tsx, its own tests in tests/handoffStrip.test.ts). Tab mentions are tokens (shared/tabMentions.mjs) the
// composer inserts from the @ menu (src/components/composer/BrowserTabMentions.tsx) and each harness adapter
// serializes on send: Codex as the Browser plugin's tab mention, Claude Code and ACP as text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/thread-kit.ts';
import { tabToken, tabMentions, withTabMentions } from '../shared/tabMentions.mjs';
import {
  fixture,
  act,
  createElement,
  render,
  call,
  chrome,
  js,
  view,
  renderToStaticMarkup,
  controlHandoff,
  controlSource,
  latestHandoff,
  browserTabsSeen,
  chatAgentTabs,
  browserTabOptions,
  useBrowserTabMentions,
  BrowserTabRows,
  linkify,
  buildInput,
  CodexAdapter,
  CODEX_API,
  buildClaudeMessage,
  acpBlocks,
} from './support/handoff-strip-kit.ts';

/* ---------- tab tokens and how each harness reads them ---------- */

const chromeTab = {
  where: 'chrome' as const,
  title: 'Docs [beta] (v2)',
  url: 'https://docs.test/a?b=1&c=(x)',
  tabId: '42',
  browserId: 'ext-1',
};
const appTab = { where: 'app' as const, title: 'Preview', url: 'http://localhost:5173/', tabId: 't2' };

test('a tab token round-trips its title, address, tab and browser, and survives markdown-breaking characters', () => {
  const token = tabToken(chromeTab);
  assert.equal(
    token,
    '[Docs \\[beta\\] (v2)](mopilot-tab://chrome?tabId=42&url=https%3A%2F%2Fdocs.test%2Fa%3Fb%3D1%26c%3D%28x%29&browserId=ext-1)',
  );
  const [m] = tabMentions(`see ${token} now`);
  assert.deepEqual(
    { ...m, token: undefined },
    {
      token: undefined,
      title: 'Docs [beta] (v2)',
      where: 'chrome',
      url: chromeTab.url,
      tabId: '42',
      browserId: 'ext-1',
      native: false,
      start: 4,
      end: 4 + token.length,
    },
  );
  // a title-less tab is named by its address; absent ids are left out
  assert.equal(
    tabToken({ where: 'app', title: '', url: 'https://x.test/' }),
    '[https://x.test/](mopilot-tab://app?url=https%3A%2F%2Fx.test%2F)',
  );
  assert.deepEqual(
    tabMentions(tabToken({ where: 'app', title: 'T', url: '' })).map((x) => [x.url, x.tabId, x.browserId]),
    [['', null, null]],
  );
});

test("the Codex Browser plugin's own tab mention links read back as tab references; other plugin links and bad encodings do not", () => {
  const ext =
    '[Inbox](plugin://browser@openai-bundled?mention=tab-v1&source=extension&browserId=e&tabId=7&title=Inbox&url=https%3A%2F%2Fmail.test%2F)';
  const iab = '[Local](plugin://browser@openai-bundled?mention=tab-v1&browserId=s&tabId=1&title=Local&url=http%3A%2F%2Flocalhost%2F)';
  const remote = '[Doc](plugin://browser@openai-curated-remote?mention=tab-v1&browserId=r&tabId=2&title=Doc&url=https%3A%2F%2Fd.test%2F)';
  const chromeDev = '[Dev](plugin://chrome-dev@openai-bundled?mention=tab-v1&browserId=c&tabId=3&title=Dev&url=https%3A%2F%2Fdev.test%2F)';
  const found = tabMentions(
    `${ext} ${iab} ${remote} ${chromeDev} [Plugin](plugin://github@openai-curated?ref=1) [Bad](mopilot-tab://chrome?url=%E0%A4%A)`,
  );
  assert.deepEqual(
    found.map((m) => [m.title, m.where, m.native, m.url]),
    [
      ['Inbox', 'chrome', true, 'https://mail.test/'],
      ['Local', 'app', true, 'http://localhost/'],
      ['Doc', 'chrome', true, 'https://d.test/'],
      ['Dev', 'chrome', true, 'https://dev.test/'],
    ],
  );
  // already in the harness's form: never rewritten
  assert.equal(withTabMentions(`${ext} please`, 'text'), `${ext} please`);
  // a query part without a value is ignored
  assert.equal(tabMentions('[A](mopilot-tab://app?flag&tabId=9)')[0].tabId, '9');
});

test("Codex: a Chrome tab the Browser plugin reported is the plugin's tab mention; without its browser id it is plain words", () => {
  const plugin = withTabMentions(`Summarize ${tabToken(chromeTab)} please`, 'codex-browser-plugin');
  assert.equal(
    plugin,
    'Summarize [Docs \\[beta\\] (v2)](plugin://browser@openai-bundled?mention=tab-v1&source=extension&browserId=ext-1&tabId=42&title=Docs%20%5Bbeta%5D%20%28v2%29&url=https%3A%2F%2Fdocs.test%2Fa%3Fb%3D1%26c%3D%28x%29) please',
  );
  // the link the plugin's docs describe, decoded back to the exact tab
  assert.deepEqual(
    tabMentions(plugin).map((m) => [m.where, m.native, m.browserId, m.tabId, m.title, m.url]),
    [['chrome', true, 'ext-1', '42', chromeTab.title, chromeTab.url]],
  );
  const noBrowser = withTabMentions(tabToken({ ...chromeTab, browserId: null }), 'codex-browser-plugin');
  assert.equal(noBrowser, `the open tab “${chromeTab.title}” <${chromeTab.url}> in my Chrome`);
  assert.equal(
    withTabMentions(tabToken({ ...chromeTab, tabId: null }), 'codex-browser-plugin'),
    `the open tab “${chromeTab.title}” <${chromeTab.url}> in my Chrome`,
  );
  assert.equal(withTabMentions('no tabs here', 'codex-browser-plugin'), 'no tabs here');
});

test('every harness: an in-app tab is its title, address and the tabId the browser_* tools take', () => {
  for (const style of ['codex-browser-plugin', 'text'] as const) {
    assert.equal(
      withTabMentions(`Check ${tabToken(appTab)}.`, style),
      'Check the built-in browser tab “Preview” <http://localhost:5173/> (tabId "t2" for the browser_* tools).',
    );
  }
  assert.equal(withTabMentions(tabToken({ where: 'app', title: 'Blank', url: '' }), 'text'), 'the built-in browser tab “Blank”');
  assert.equal(withTabMentions(tabToken({ where: 'chrome', title: 'Bare', url: '' }), 'text'), 'the open tab “Bare” in my Chrome');
});

test('each adapter serializes on send: Codex input items, the Claude message, ACP prompt blocks', async () => {
  const text = `Compare ${tabToken(chromeTab)} with ${tabToken(appTab)}`;
  const codex = buildInput(text, [])[0].text;
  assert.match(
    codex,
    /\[Docs \\\[beta\\\] \(v2\)\]\(plugin:\/\/browser@openai-bundled\?mention=tab-v1&source=extension&browserId=ext-1&tabId=42/,
  );
  assert.match(codex, /the built-in browser tab “Preview” <http:\/\/localhost:5173\/> \(tabId "t2" for the browser_\* tools\)/);
  const claude = buildClaudeMessage({ text }).content;
  assert.equal(
    claude,
    `Compare the open tab “${chromeTab.title}” <${chromeTab.url}> in my Chrome with the built-in browser tab “Preview” <http://localhost:5173/> (tabId "t2" for the browser_* tools)`,
  );
  const acp = await acpBlocks(text, [], async () => null);
  assert.equal(acp[0].text, claude);
  // a message without text stays empty
  assert.equal(buildClaudeMessage({}).content, '');
});

/* ---------- hand-offs ---------- */

test('in-app browser: a tab marked "handoff" or a navigation that lands on a sign-in page hands over; other steps do not', () => {
  assert.deepEqual(
    controlHandoff(
      call('mcp__sage_x__browser_tabs_mark', { tabId: 't3', status: 'handoff' }, 'Marked t3 as handoff: it stays open after this turn.'),
    ),
    { where: 'app', reason: 'continue', url: null, tabId: 't3' },
  );
  assert.deepEqual(controlHandoff(call('browser_tabs_mark', { status: 'handoff' })), {
    where: 'app',
    reason: 'continue',
    url: null,
    tabId: null,
  });
  assert.equal(controlHandoff(call('browser_tabs_mark', { tabId: 't3', status: 'deliverable' })), null);
  assert.deepEqual(
    controlHandoff(call('browser_navigate', { url: 'x' }, 'Navigated t1 to https://accounts.google.com/signin (Sign in).')),
    { where: 'app', reason: 'signIn', url: 'https://accounts.google.com/signin', tabId: 't1' },
  );
  assert.equal(controlHandoff(call('browser_navigate', { url: 'x' }, 'Navigated t1 to https://example.com/ (Example).')), null);
  assert.equal(controlHandoff({ ...call('browser_read_page'), arguments: undefined }), null);
  // a browser_script that marks its tab for hand-off, saying why
  assert.deepEqual(
    controlHandoff(
      call('mcp__sage_x__browser_script', { code: '// the user must sign in\nawait tab.goto("https://a.test")\nawait tab.markHandoff()' }),
    ),
    { where: 'app', reason: 'signIn', url: null, tabId: null },
  );
  assert.equal(controlHandoff(call('browser_script', { code: 'const s = "tab.markHandoff()"' })), null);
  assert.equal(controlHandoff(call('browser_script', { code: 5 })), null);
  assert.equal(latestHandoff([call('browser_script', { code: 5 })]), null);
  assert.equal(controlSource(call('browser_script', { code: 5 })), null);
  // Claude Code's short names on mopilot_browser hand over as the browser_* tools do
  assert.deepEqual(
    latestHandoff([call('tabs_mark', { tabId: 't4', status: 'handoff' }, 'Marked t4 as handoff.', 'mopilot_browser')])?.handoff,
    { where: 'app', reason: 'continue', url: null, tabId: 't4' },
  );
  assert.equal(latestHandoff([call('navigate', { url: 'x' }, 'Navigated t1 to https://example.com/ (Example).', 'mopilot_browser')]), null);
  // the turn ends on it; a later browser_script that did something else: the turn doesn't end on a hand-off
  assert.deepEqual(latestHandoff([call('browser_script', { code: '// sign in first\nawait tab.markHandoff()' })])?.handoff, {
    where: 'app',
    reason: 'signIn',
    url: null,
    tabId: null,
  });
  assert.equal(
    latestHandoff([call('browser_script', { code: 'await tab.markHandoff()' }), call('browser_script', { code: 'const x = 1' })]),
    null,
  );
  // nor on a later native program that did something else
  assert.equal(latestHandoff([call('browser_script', { code: 'await tab.markHandoff()' }), js('const y = 2')]), null);
  assert.equal(
    latestHandoff([call('browser_script', { code: 'await tab.markHandoff()' }), js('await a()\nawait b()', '', 'Checked the cart')]),
    null,
  );
  // the hand-off step shows the program that made it
  assert.deepEqual(controlSource(call('browser_script', { code: 'await tab.markHandoff()' })), {
    code: 'await tab.markHandoff()',
    lang: 'javascript',
  });
  // desktop control never hands the browser over
  assert.equal(controlHandoff(call('desktop_screenshot')), null);
  // not control at all, and a vendor namespace without hand-offs
  assert.equal(controlHandoff(call('read_file', {}, '', 'fs')), null);
  assert.equal(
    controlHandoff(
      call('mcp__Claude_Browser__navigate', { url: 'https://accounts.google.com' }, 'Navigated to https://accounts.google.com'),
    ),
    null,
  );
  assert.equal(controlHandoff(null), null);
});

test('Claude in Chrome: asking for sign-in details, a sign-in page, or a result that stops for the user hands Chrome over', () => {
  assert.deepEqual(controlHandoff(chrome('request_credentials', {}, 'Waiting for https://shop.test/login')), {
    where: 'chrome',
    reason: 'signIn',
    url: 'https://shop.test/login',
    tabId: null,
  });
  assert.deepEqual(controlHandoff(chrome('navigate', { url: 'x' }, 'Navigated to https://login.microsoftonline.com/common')), {
    where: 'chrome',
    reason: 'signIn',
    url: 'https://login.microsoftonline.com/common',
    tabId: null,
  });
  assert.equal(controlHandoff(chrome('navigate', { url: 'x' }, 'Navigated to https://example.com')), null);
  assert.deepEqual(controlHandoff(chrome('computer', { action: 'left_click' }, 'Blocked by a CAPTCHA challenge on https://t.test/')), {
    where: 'chrome',
    reason: 'captcha',
    url: 'https://t.test/',
    tabId: null,
  });
  assert.deepEqual(controlHandoff(chrome('computer', { action: 'screenshot' }, 'Login required: the user needs to sign in.')), {
    where: 'chrome',
    reason: 'signIn',
    url: null,
    tabId: null,
  });
  assert.deepEqual(controlHandoff(chrome('computer', { action: 'left_click' }, 'The user needs to confirm the payment.')), {
    where: 'chrome',
    reason: 'payment',
    url: null,
    tabId: null,
  });
  assert.deepEqual(controlHandoff(chrome('computer', { action: 'left_click' }, 'Waiting for the user.')), {
    where: 'chrome',
    reason: 'continue',
    url: null,
    tabId: null,
  });
  assert.deepEqual(controlHandoff(chrome('find', { query: 'x' }, 'The user took control of the tab.')), null);
  assert.deepEqual(controlHandoff(chrome('computer', { action: 'left_click' }, 'The user took control of the tab.')), {
    where: 'chrome',
    reason: 'tookOver',
    url: null,
    tabId: null,
  });
  // a page that only mentions signing in or reCAPTCHA is no pause
  assert.equal(controlHandoff(chrome('get_page_text', {}, 'Please sign in. Protected by reCAPTCHA')), null);
  assert.equal(controlHandoff(chrome('computer', { action: 'left_click' }, 'Clicked "Sign in"')), null);
});

test('Codex Browser plugin: tab.markHandoff() hands Chrome over with the reason the program gives; the user taking over does too', () => {
  assert.deepEqual(controlHandoff(js('await tab.markHandoff(); // waiting for login', 'https://app.test/login')), {
    where: 'chrome',
    reason: 'signIn',
    url: 'https://app.test/login',
    tabId: null,
  });
  assert.deepEqual(controlHandoff(js('await tab.markHandoff()', '', 'Solve the CAPTCHA')), {
    where: 'chrome',
    reason: 'captcha',
    url: null,
    tabId: null,
  });
  assert.deepEqual(controlHandoff(js('await tab.markHandoff()')), { where: 'chrome', reason: 'continue', url: null, tabId: null });
  assert.deepEqual(controlHandoff(js('await auth.request({})', '{"status":"declined","reason":"user_took_over"}')), {
    where: 'chrome',
    reason: 'tookOver',
    url: null,
    tabId: null,
  });
  // the word in a string or comment is no call
  assert.equal(controlHandoff(js('// markHandoff() later\nconst s = "tab.markHandoff()"; await tab.goto("https://a.test")')), null);
  assert.equal(controlHandoff(js(42)), null);
  assert.equal(controlHandoff(call('js_reset', {}, 'user_took_over', 'cua_repl')), null);
});

test("latestHandoff: only a hand-off that is the turn's last control step counts", () => {
  const mark = call('browser_tabs_mark', { tabId: 't1', status: 'handoff' });
  const reply = { id: 'm', type: 'agentMessage', text: 'Please sign in.' };
  assert.deepEqual(latestHandoff([call('browser_navigate', { url: 'a' }), mark, reply]), {
    id: mark.id,
    handoff: { where: 'app', reason: 'continue', url: null, tabId: 't1' },
  });
  // the agent went on after it
  assert.equal(latestHandoff([mark, call('browser_read_page')]), null);
  assert.equal(latestHandoff([reply]), null);
  assert.equal(latestHandoff([]), null);
  // an item without an id is keyed by its place
  const { id: _id, ...anon } = mark;
  assert.equal(latestHandoff([reply, anon])!.id, '1');
});

/* ---------- the user's Chrome tabs a chat's tools reported ---------- */

test("browserTabsSeen: Claude in Chrome tab lists and the Codex plugin's openTabs() output, newest first, each once", () => {
  const footer = chrome(
    'navigate',
    {},
    'Navigated.\n\nTab Context:\nAvailable tabs:\n  • tabId 11: "Mail" ("https://mail.test/")\n  • tabId 12: "" ("https://blank.test/")\nnot a tab',
  );
  const json = chrome(
    'tabs_context_mcp',
    {},
    JSON.stringify({
      availableTabs: [
        { tabId: 5, title: 'Docs', url: 'https://docs.test/' },
        { tabId: 6 },
        null,
        { tabId: 8, url: 'https://untitled-json.test/' },
      ],
    }),
  );
  const listed = js(
    'nodeRepl.write(JSON.stringify(await browser.user.openTabs()))',
    JSON.stringify({
      browser: { id: 'b', type: 'extension', metadata: { extensionInstanceId: 'ext-9' } },
      tabs: [
        { id: 'x', providerTabId: '77', title: 'Shop', url: 'https://shop.test/' },
        { id: 'y', url: 'https://untitled.test/' },
        { id: 'z', url: 'chrome://newtab/' },
      ],
    }),
  );
  const perLine = js(
    'for (const t of await browser.user.openTabs()) nodeRepl.write(JSON.stringify(t))',
    '{"providerTabId":"1","title":"A","url":"https://a.test/"}\n{"metadata":{"extensionInstanceId":"e1"}}\n{"metadata":{"extensionInstanceId":"e2"}}\n{bad json\nplain line',
  );
  const tabs = browserTabsSeen([
    footer,
    json,
    listed,
    perLine,
    chrome('tabs_context_mcp', {}, 'not json'),
    chrome('tabs_context_mcp', {}, '{"availableTabs":3}'),
    js('await tab.goto("https://a.test")', '{"url":"https://a.test/","id":"1"}'),
    js(5),
    { type: 'agentMessage' },
    footer,
  ]);
  assert.deepEqual(
    tabs.map((t: any) => [t.tabId, t.title, t.url, t.browserId]),
    [
      ['11', 'Mail', 'https://mail.test/', null],
      ['12', 'https://blank.test/', 'https://blank.test/', null],
      // two extension instances in one output: no browser id
      ['1', 'A', 'https://a.test/', null],
      ['77', 'Shop', 'https://shop.test/', 'ext-9'],
      ['y', 'https://untitled.test/', 'https://untitled.test/', 'ext-9'],
      ['5', 'Docs', 'https://docs.test/', null],
      ['8', 'https://untitled-json.test/', 'https://untitled-json.test/', null],
    ],
  );
  assert.ok(tabs.every((t: any) => t.where === 'chrome'));
});

test("chatAgentTabs finds a chat's in-app tabs under its own id or the native session behind it", () => {
  const v = (tabId: string) => ({
    tabId,
    tabKey: null,
    kind: 'tab',
    active: false,
    created: false,
    mark: null,
    takenOver: false,
    origin: null,
    access: null,
  });
  const map = { chat: [v('a')], native: [v('b')] };
  assert.deepEqual(
    chatAgentTabs(map as any, 'chat', (id: string) => id),
    { key: 'chat', tabs: map.chat },
  );
  assert.deepEqual(
    chatAgentTabs(map as any, 'other', (id: string) => (id === 'native' ? 'other' : id)),
    { key: 'native', tabs: map.native },
  );
  assert.equal(
    chatAgentTabs(map as any, 'none', (id: string) => id),
    null,
  );
});

/* ---------- the @ menu's "Browser tabs" ---------- */

test('browserTabOptions: in-app tabs on a web page (pane title and address), then Chrome tabs, filtered and capped', () => {
  const app = {
    key: 'chat',
    tabs: [
      view('t1', null),
      view('t2', 't2', { origin: 'https://origin.test' }),
      view('t3', 't3'),
      view('p', 'p', { kind: 'popup', origin: 'https://pop.test' }),
      view('t4', 't4'),
      view('t5', 't5'),
    ],
  };
  const paneTabs = [
    { kind: 'browser', agentChat: 'chat', url: 'https://one.test/x', title: 'One' },
    { kind: 'browser', agentChat: 'chat', agentTab: 't3', url: 'about:blank' },
    { kind: 'browser', agentChat: 'chat', agentTab: 't4', url: 'https://four.test/' },
    { kind: 'browser', agentChat: 'other', agentTab: 't2', url: 'https://not-mine.test/', title: 'Not mine' },
    { kind: 'terminal' },
  ];
  const seen = [{ where: 'chrome', tabId: '9', title: 'Mail', url: 'https://mail.test/', browserId: 'e' }];
  const all = browserTabOptions({ app, paneTabs, seen: seen as any, query: '' });
  assert.deepEqual(
    all.map((t: any) => [t.key, t.where, t.title, t.url, t.tabId]),
    [
      ['app:t1', 'app', 'One', 'https://one.test/x', 't1'],
      ['app:t2', 'app', 'https://origin.test', 'https://origin.test', 't2'],
      ['app:t4', 'app', 'https://four.test/', 'https://four.test/', 't4'],
      ['chrome:9:https://mail.test/', 'chrome', 'Mail', 'https://mail.test/', '9'],
    ],
  );
  assert.deepEqual(
    browserTabOptions({ app, paneTabs, seen: seen as any, query: ' MAIL ' }).map((t: any) => t.key),
    ['chrome:9:https://mail.test/'],
  );
  assert.deepEqual(
    browserTabOptions({ app, paneTabs, seen: seen as any, query: 'four.test' }).map((t: any) => t.key),
    ['app:t4'],
  );
  assert.equal(browserTabOptions({ app, paneTabs, seen: seen as any, query: '', limit: 2 }).length, 2);
  assert.deepEqual(browserTabOptions({ app: null, paneTabs: [], seen: [], query: '' }), []);
});

function Probe({ threadId, query }: { threadId: string | null; query: string }) {
  const tabs = useBrowserTabMentions(threadId, query);
  return createElement(
    'ul',
    null,
    tabs.map((t: any) => createElement('li', { key: t.key }, `${t.where}:${t.title}`)),
  );
}

test("useBrowserTabMentions reads the chat's agent tabs, the pane and every loaded turn; a new chat has none", async () => {
  fixture.state = {
    agentTabs: { 'native-1': [view('t1', null)] },
    paneTabs: [{ kind: 'browser', agentChat: 'native-1', url: 'https://app.test/', title: 'App' }],
    runtime: {
      chat: {
        turns: [
          {
            items: [
              chrome('tabs_context_mcp', {}, JSON.stringify({ availableTabs: [{ tabId: 1, title: 'Mail', url: 'https://mail.test/' }] })),
            ],
          },
        ],
      },
    },
  };
  fixture.chatOf = { 'native-1': 'chat' };
  let el = await render(createElement(Probe, { threadId: 'chat', query: '' }));
  assert.deepEqual(
    [...el.querySelectorAll('li')].map((li) => li.textContent),
    ['app:App', 'chrome:Mail'],
  );
  el = await render(createElement(Probe, { threadId: null, query: '' }));
  assert.equal(el.querySelectorAll('li').length, 0);
  // a chat with no turns loaded yet still lists its in-app tabs
  fixture.state = { ...fixture.state, runtime: {} };
  el = await render(createElement(Probe, { threadId: 'chat', query: '' }));
  assert.deepEqual(
    [...el.querySelectorAll('li')].map((li) => li.textContent),
    ['app:App'],
  );
});

test('BrowserTabRows: a labelled section whose rows follow the keyboard index and pick on mouse down', async () => {
  const tabs = [
    { key: 'a', where: 'app', title: 'Preview', url: 'http://localhost:5173/', tabId: 't', browserId: null },
    { key: 'c', where: 'chrome', title: 'Mail', url: 'https://mail.test/inbox', tabId: '1', browserId: null },
  ];
  const picked: any[] = [];
  const hovered: number[] = [];
  const el = await render(
    createElement(BrowserTabRows, {
      tabs: tabs as any,
      index: 1,
      setIndex: (n: number) => hovered.push(n),
      onPick: (t: any) => picked.push(t.key),
    }),
  );
  assert.equal(el.querySelector('.composer-popup-label')!.textContent, 'Browser tabs');
  const rows = [...el.querySelectorAll('.menu-item')];
  assert.deepEqual(
    rows.map((r) => [r.querySelector('.mention-name')!.textContent, r.querySelector('.mention-path')!.textContent]),
    [
      ['Preview', 'Built-in browser · localhost:5173'],
      ['Mail', 'Chrome · mail.test'],
    ],
  );
  assert.deepEqual(
    rows.map((r) => r.classList.contains('kbd-active')),
    [false, true],
  );
  assert.deepEqual(
    [...el.querySelectorAll('[data-icon]')].map((i) => i.getAttribute('data-icon')),
    ['AppWindow', 'Globe'],
  );
  await act(async () => {
    rows[0].dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true }) as any);
  });
  await act(async () => {
    rows[1].dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }) as any);
  });
  assert.deepEqual(hovered, [0]);
  assert.deepEqual(picked, ['c']);
  const empty = await render(createElement(BrowserTabRows, { tabs: [], index: 0, setIndex() {}, onPick() {} }));
  assert.equal(empty.innerHTML, '');
});

test('user bubbles show tab references, sent tokens and Codex plugin links alike, as chips beside chat references', () => {
  const plugin = withTabMentions(tabToken(chromeTab), 'codex-browser-plugin');
  const html = renderToStaticMarkup(
    createElement('p', null, linkify(`Read ${tabToken(appTab)} and ${plugin} like [Chat](session://c1) https://x.test`)),
  );
  assert.match(
    html,
    /<span class="bubble-link composer-session-token composer-tab-token" title="http:\/\/localhost:5173\/">Preview<\/span>/,
  );
  assert.match(
    html,
    /<span class="bubble-link composer-session-token composer-tab-token" title="https:\/\/docs.test\/a\?b=1&amp;c=\(x\)">Docs \[beta\] \(v2\)<\/span>/,
  );
  assert.match(html, /<a class="bubble-link composer-session-token" title="Chat" href="#thread=c1">Chat<\/a>/);
  assert.match(html, /<a class="bubble-link" href="https:\/\/x.test">/);
});

test('a chat reference in a user bubble still opens its chat', async () => {
  const opened: any[] = [];
  fixture.thread = { navigate: (to: any) => opened.push(to) };
  const el = await render(createElement('p', null, linkify(`see ${tabToken(appTab)} in [Chat](session://c1)`)));
  await act(async () => el.querySelector<HTMLElement>('a.composer-session-token')!.click());
  assert.deepEqual(opened, [{ name: 'thread', id: 'c1' }]);
});

test('a window reads Codex requirements by name (configRequirementsRead), not by app-server method', async () => {
  const a = Object.create(CodexAdapter.prototype);
  const sent: any[] = [];
  a.request = async (method: string, params?: unknown) => {
    sent.push([method, params]);
    return { requirements: null };
  };
  assert.ok(CODEX_API.has('configRequirementsRead'));
  assert.deepEqual(await a.configRequirementsRead(), { requirements: null });
  assert.deepEqual(sent, [['configRequirements/read', undefined]]);
});

test('a referenced tab with an unpaired title can still be sent through every harness', async () => {
  const title = 'Page \ud800/\udfff 😺';
  const token = tabToken({ ...chromeTab, title });
  const text = `Read ${token}`;
  const codex = buildInput(text, [])[0].text;
  assert.ok(codex.includes('&title=Page%20%EF%BF%BD%2F%EF%BF%BD%20%F0%9F%98%BA&'));
  const [mention] = tabMentions(codex);
  assert.equal(mention.tabId, chromeTab.tabId);
  assert.equal(mention.browserId, chromeTab.browserId);
  assert.equal(mention.url, chromeTab.url);
  const claude = buildClaudeMessage({ text }).content;
  const acp = await acpBlocks(text, [], async () => null);
  assert.equal(acp[0].text, claude);
  assert.ok(claude.includes(title));
});

test('seen tabs retain distinct opaque tab IDs and URLs with overlapping separators', () => {
  const output = (id: string, url: string, browser = 'one') =>
    js(
      'nodeRepl.write(JSON.stringify(await browser.user.openTabs()))',
      JSON.stringify({ browser: { id: browser, type: 'extension', metadata: { extensionInstanceId: browser } }, tabs: [{ id, url }] }),
    );
  const tabs = browserTabsSeen([output('a:https://b.test/x', 'https://c.test/'), output('a', 'https://b.test/x:https://c.test/')]);
  assert.equal(tabs.length, 2);
  const separateBrowsers = browserTabsSeen([output('same', 'https://same.test/', 'one'), output('same', 'https://same.test/', 'two')]);
  assert.equal(separateBrowsers.length, 2);
  assert.equal(browserTabsSeen([output('same', 'https://same.test/'), output('same', 'https://same.test/')]).length, 1);
});
