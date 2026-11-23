// Browser approval cards' pure helpers: Codex's Browser plugin requests (src/harness/elicitation.ts,
// shapes from the shipped browser-use plugin) and Claude Code's Claude in Chrome permission requests
// (src/harness/chromeApproval.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowsAllSites, browserUseAnswer, browserUseApproval, originHost } from '../src/harness/elicitation.ts';
import { chromeApproval, chromeHost, chromeSuggestion, chromeTabUrl, chromeTool } from '../src/harness/chromeApproval.ts';

/* ---------- Codex's Browser plugin ---------- */

/** A Browser plugin request as the plugin sends it (browser-service.mjs), through Codex's app-server. */
const browserRequest = (meta: Record<string, unknown> = {}, o: { schema?: unknown; mode?: string | null } = {}) => ({
  serverName: 'cua_repl',
  ...(o.mode === null ? {} : { mode: o.mode ?? 'form' }),
  message: 'Allow Chrome to access https://example.com?',
  ...(o.schema === undefined
    ? { requestedSchema: { type: 'object', properties: {}, additionalProperties: false } }
    : o.schema === null
      ? {}
      : { requestedSchema: o.schema }),
  _meta: {
    codex_approval_kind: 'mcp_tool_call',
    codex_sensitive_action: true,
    connector_id: 'browser-use',
    connector_name: 'Chrome',
    persist: 'always',
    tool_name: 'access_browser_origin',
    tool_title: 'Access browser origin',
    tool_params: { origin: 'https://example.com' },
    tool_params_display: [],
    origin: 'https://example.com',
    ...meta,
  },
});
const values = (p: any) => browserUseApproval(p)?.choices.map((c) => c.value);

test('a site request offers this chat, this site and all sites when persist is "always" (a string)', () => {
  assert.deepEqual(browserUseApproval(browserRequest()), {
    kind: 'origin',
    origin: 'https://example.com',
    host: 'example.com',
    browser: 'Chrome',
    reason: null,
    details: [],
    sensitive: true,
    highRisk: false,
    choices: [
      { value: 'chat', label: 'Allow in this chat' },
      { value: 'site', label: 'Allow for this site' },
      { value: 'allSites', label: 'Allow for all sites' },
    ],
  });
  // no persistent grant offered: this chat only
  assert.deepEqual(values(browserRequest({ persist: undefined })), ['chat']);
  assert.deepEqual(values(browserRequest({ persist: null })), ['chat']);
  // a list works the same as the string
  assert.deepEqual(values(browserRequest({ persist: ['always'] })), ['chat', 'site', 'allSites']);
});

test('a site request takes its origin from _meta, else tool_params, and its reason from either', () => {
  const a = browserUseApproval(
    browserRequest({
      origin: undefined,
      tool_params: { origin: 'http://localhost:3000', reason: ' to test the app ' },
      codex_sensitive_action: undefined,
      connector_name: ' ',
    }),
  )!;
  assert.equal(a.origin, 'http://localhost:3000');
  assert.equal(a.host, 'localhost:3000');
  assert.equal(a.reason, 'to test the app');
  assert.equal(a.sensitive, false);
  assert.equal(a.browser, null);
  assert.equal(browserUseApproval(browserRequest({ reason: 'meta reason' }))!.reason, 'meta reason');
  const none = browserUseApproval(browserRequest({ origin: 7, tool_params: null }))!;
  assert.equal(none.origin, null);
  assert.equal(none.host, null);
  assert.equal(originHost('not a url'), null);
  assert.equal(originHost('file:///tmp/a.html'), null);
});

test('a raw DevTools request is high risk and can be kept for the chat or the site', () => {
  const a = browserUseApproval(
    browserRequest({
      tool_name: 'access_browser_origin_with_raw_cdp',
      riskLevel: 'high',
      full_cdp_access: true,
      codex_sensitive_action: undefined,
    }),
  )!;
  assert.equal(a.kind, 'devtools');
  assert.equal(a.highRisk, true);
  assert.deepEqual(a.choices, [
    { value: 'chat', label: 'Allow in this chat' },
    { value: 'site', label: 'Always allow for this site' },
  ]);
  assert.equal(
    browserUseApproval(browserRequest({ tool_name: 'access_browser_origin_with_raw_cdp', riskLevel: 'low', full_cdp_access: true }))!
      .highRisk,
    true,
  );
});

test('upload, download and page-asset requests offer once, this chat and this site as the plugin offers them', () => {
  const up = browserUseApproval(
    browserRequest({
      tool_name: 'upload_browser_files',
      tool_params: { origin: 'https://drive.example' },
      origin: 'https://drive.example',
      file_transfer: 'upload',
      persist: ['session', 'always'],
    }),
  )!;
  assert.equal(up.kind, 'upload');
  assert.deepEqual(up.choices, [
    { value: 'once', label: 'Allow once' },
    { value: 'session', label: 'Allow in this chat' },
    { value: 'site', label: 'Always allow for this site' },
  ]);
  assert.deepEqual(values(browserRequest({ tool_name: 'download_browser_files', persist: 'session' })), ['once', 'session']);
  assert.equal(browserUseApproval(browserRequest({ tool_name: 'download_browser_files' }))!.kind, 'download');
  const assets = browserUseApproval(
    browserRequest({
      tool_name: undefined,
      origin: undefined,
      tool_params: { asset_origins: ['https://cdn.example'] },
      tool_params_display: [{ name: 'asset_origins', display_name: 'Download from', value: 'https://cdn.example' }],
      persist: ['session', 'always'],
    }),
  )!;
  assert.equal(assets.kind, 'assets');
  assert.equal(assets.host, 'cdn.example');
  assert.deepEqual(assets.details, [{ label: 'Download from', value: 'https://cdn.example' }]);
  assert.deepEqual(
    assets.choices.map((c) => c.value),
    ['once', 'session', 'site'],
  );
});

test('a browsing history request offers once and, when the plugin allows it, always', () => {
  const h = browserUseApproval(
    browserRequest({
      tool_name: undefined,
      origin: undefined,
      tool_params: {},
      sensitive_data: 'browsing_history',
      subtitle: 'ChatGPT can use records of pages visited.',
      persist: 'always',
    }),
  )!;
  assert.equal(h.kind, 'history');
  assert.equal(h.reason, 'ChatGPT can use records of pages visited.');
  assert.deepEqual(h.choices, [
    { value: 'once', label: 'Allow once' },
    { value: 'always', label: 'Always allow' },
  ]);
  assert.deepEqual(values(browserRequest({ tool_name: undefined, sensitive_data: 'browsing_history', persist: undefined })), ['once']);
});

test('a WebMCP request shows the tool, its description, page and input, and is allowed once', () => {
  const w = browserUseApproval(
    browserRequest({
      tool_name: 'webmcp:example.com:add_to_cart',
      tool_title: 'Invoke Add to cart (add_to_cart) on https://example.com',
      tool_description: 'Adds an item',
      page_url: 'https://example.com/shop',
      tool_params: { sku: 'A1', qty: 2 },
      persist: undefined,
    }),
  )!;
  assert.equal(w.kind, 'webmcp');
  assert.deepEqual(w.details, [
    { label: 'Tool', value: 'Invoke Add to cart (add_to_cart) on https://example.com' },
    { label: 'Description', value: 'Adds an item' },
    { label: 'Page', value: 'https://example.com/shop' },
    { label: 'Input', value: '{\n  "sku": "A1",\n  "qty": 2\n}' },
  ]);
  assert.deepEqual(w.choices, [{ value: 'once', label: 'Allow once' }]);
  // a WebMCP tool's input is shown even when empty or not an object
  assert.deepEqual(browserUseApproval(browserRequest({ tool_name: 'webmcp:a:b', tool_title: undefined, tool_params: 'raw' }))!.details, [
    { label: 'Input', value: 'raw' },
  ]);
  assert.deepEqual(browserUseApproval(browserRequest({ tool_name: 'webmcp:a:b', tool_params: undefined }))!.details, [
    { label: 'Tool', value: 'Access browser origin' },
  ]);
});

test('another browser action shows its title, description and input; tool_params_display rows are kept', () => {
  const a = browserUseApproval(
    browserRequest({
      tool_name: 'automated_safety_precheck.submit',
      tool_title: undefined,
      tool_description: 'Submit the form',
      tool_params: { form: 'checkout' },
      persist: ['session'],
      origin: undefined,
    }),
  )!;
  assert.equal(a.kind, 'action');
  assert.deepEqual(a.details, [
    { label: 'Description', value: 'Submit the form' },
    { label: 'Input', value: '{\n  "form": "checkout"\n}' },
  ]);
  assert.deepEqual(
    a.choices.map((c) => c.value),
    ['once', 'session'],
  );
  const b = browserUseApproval(
    browserRequest({
      tool_name: 'x',
      tool_title: 'Do x',
      tool_params: {},
      tool_params_display: [{ name: 'Where', value: 3 }, { display_name: ' ', value: 1 }, { name: 'skip' }, null],
    }),
  )!;
  assert.deepEqual(b.details, [
    { label: 'Action', value: 'Do x' },
    { label: 'Where', value: '3' },
  ]);
  assert.deepEqual(
    browserUseApproval(
      browserRequest({ tool_name: 'x', tool_title: undefined, tool_params: 'not an object', tool_params_display: 'not a list' }),
    )!.details,
    [],
  );
});

test('only an empty Browser plugin form is a browser approval', () => {
  // the schema may be left out, and the mode too
  assert.equal(browserUseApproval(browserRequest({}, { schema: null }))?.kind, 'origin');
  assert.equal(browserUseApproval(browserRequest({}, { mode: null }))?.kind, 'origin');
  assert.equal(browserUseApproval(browserRequest({}, { schema: { type: 'object' } }))?.kind, 'origin');
  assert.equal(browserUseApproval(browserRequest({}, { schema: { type: 'object', properties: {}, required: [] } }))?.kind, 'origin');
  const not = [
    null,
    {},
    browserRequest({ connector_id: 'computer-use' }),
    browserRequest({ codex_approval_kind: 'browser_auth' }),
    browserRequest({}, { mode: 'url' }),
    browserRequest({}, { schema: { type: 'string' } }),
    browserRequest({}, { schema: { type: 'object', properties: null } }),
    browserRequest({}, { schema: { type: 'object', properties: 'x' } }),
    browserRequest({}, { schema: { type: 'object', properties: [] } }),
    browserRequest({}, { schema: { type: 'object', properties: { approved: { type: 'boolean' } } } }),
    browserRequest({}, { schema: { type: 'object', properties: {}, required: 'x' } }),
    browserRequest({}, { schema: { type: 'object', properties: {}, required: ['x'] } }),
  ];
  for (const p of not) assert.equal(browserUseApproval(p), null, JSON.stringify(p));
});

test('each grant answers with the exact _meta the plugin reads, and never one it did not offer', () => {
  const site = browserRequest();
  assert.deepEqual(browserUseAnswer(site, 'chat'), { action: 'accept', content: {}, _meta: null });
  assert.deepEqual(browserUseAnswer(site, 'site'), { action: 'accept', content: {}, _meta: { persist: 'always' } });
  assert.deepEqual(browserUseAnswer(site, 'allSites'), {
    action: 'accept',
    content: {},
    _meta: { persist: 'always', browser_use_persistent_approval_scope: 'all-sites' },
  });
  const upload = browserRequest({ tool_name: 'upload_browser_files', persist: ['session', 'always'] });
  assert.deepEqual(browserUseAnswer(upload, 'once'), { action: 'accept', content: {}, _meta: null });
  assert.deepEqual(browserUseAnswer(upload, 'session'), { action: 'accept', content: {}, _meta: { persist: 'session' } });
  assert.deepEqual(browserUseAnswer(upload, 'site'), { action: 'accept', content: {}, _meta: { persist: 'always' } });
  const history = browserRequest({ tool_name: undefined, sensitive_data: 'browsing_history' });
  assert.deepEqual(browserUseAnswer(history, 'always'), { action: 'accept', content: {}, _meta: { persist: 'always' } });
  // not offered (a site grant without persist, once on a site), or not a browser request: cancel
  assert.deepEqual(browserUseAnswer(browserRequest({ persist: undefined }), 'site'), { action: 'cancel', content: null, _meta: null });
  assert.deepEqual(browserUseAnswer(site, 'once'), { action: 'cancel', content: null, _meta: null });
  assert.deepEqual(browserUseAnswer({}, 'chat'), { action: 'cancel', content: null, _meta: null });
  assert.deepEqual(browserUseAnswer(site, 'decline'), { action: 'decline', content: null, _meta: null });
  assert.deepEqual(browserUseAnswer(site, 'cancel'), { action: 'cancel', content: null, _meta: null });
});

test('"all sites" is allowed unless Codex\'s requirements turn global approval off, and unknown is no', () => {
  assert.equal(allowsAllSites({ requirements: null }), true);
  assert.equal(allowsAllSites({ requirements: { browserUse: null } }), true);
  assert.equal(allowsAllSites({ requirements: { browserUse: { allowGlobalPersistentApproval: true } } }), true);
  assert.equal(allowsAllSites({ requirements: { browserUse: { allowGlobalPersistentApproval: null } } }), true);
  assert.equal(allowsAllSites({ requirements: { browserUse: { allowGlobalPersistentApproval: false } } }), false);
  assert.equal(allowsAllSites(null), false);
  assert.equal(allowsAllSites('x'), false);
});

/* ---------- Claude in Chrome ---------- */

const T = (tool: string) => `mcp__claude-in-chrome__${tool}`;

test('only mcp__claude-in-chrome__ tools are Claude in Chrome tools', () => {
  assert.equal(chromeTool(T('navigate')), 'navigate');
  for (const n of ['mcp__claude-in-chrome__', 'mcp__claude-in-chromex__navigate', 'WebFetch', 7, null])
    assert.equal(chromeTool(n), null, String(n));
  assert.equal(chromeApproval('WebFetch', {}), null);
});

test('navigate names the page it opens and its host; back and forward name no site', () => {
  assert.deepEqual(chromeApproval(T('navigate'), { url: 'https://example.com/a?b=1', tabId: 3 }, 'https://other.example'), {
    action: 'Open a page',
    host: 'example.com',
    rows: [{ label: 'URL', value: 'https://example.com/a?b=1' }],
    block: null,
  });
  assert.equal(chromeApproval(T('navigate'), { url: 'example.org' })!.host, 'example.org');
  assert.deepEqual(chromeApproval(T('navigate'), { url: 'chrome://settings' }), {
    action: 'Open a page',
    host: null,
    rows: [{ label: 'URL', value: 'chrome://settings' }],
    block: null,
  });
  assert.deepEqual(chromeApproval(T('navigate'), { url: 'back', tabId: 1 }, 'https://news.example/x'), {
    action: 'Go back',
    host: null,
    rows: [{ label: 'Tab', value: 'last opened news.example in this chat' }],
    block: null,
  });
  assert.equal(chromeApproval(T('navigate'), { url: 'forward' })!.action, 'Go forward');
  assert.deepEqual(chromeApproval(T('navigate'), null), { action: 'Open a page', host: null, rows: [], block: null });
});

test('computer actions read as a verb with their target, text or keys', () => {
  const view = (input: any) => {
    const v = chromeApproval(T('computer'), input)!;
    return [v.action, v.rows];
  };
  assert.deepEqual(view({ action: 'left_click', coordinate: [10, 20], modifiers: 'shift' }), [
    'Click',
    [
      { label: 'Point', value: '10, 20' },
      { label: 'Holding', value: 'shift' },
    ],
  ]);
  assert.deepEqual(view({ action: 'double_click', ref: 'ref_7' }), ['Double-click', [{ label: 'Element', value: 'ref_7' }]]);
  assert.deepEqual(view({ action: 'hover', coordinate: [1] }), ['Hover', []]);
  assert.deepEqual(view({ action: 'type', text: 'x'.repeat(400) }), ['Type text', [{ label: 'Text', value: `${'x'.repeat(299)}…` }]]);
  assert.deepEqual(view({ action: 'type' }), ['Type text', []]);
  assert.deepEqual(view({ action: 'key', text: 'cmd+a' }), ['Press keys', [{ label: 'Keys', value: 'cmd+a' }]]);
  assert.deepEqual(view({ action: 'key' }), ['Press keys', []]);
  assert.deepEqual(view({ action: 'scroll', coordinate: [5, 5], scroll_direction: 'down' }), [
    'Scroll',
    [
      { label: 'Point', value: '5, 5' },
      { label: 'Direction', value: 'down' },
    ],
  ]);
  assert.deepEqual(view({ action: 'scroll' }), ['Scroll', []]);
  assert.deepEqual(view({ action: 'scroll_to', ref: 'ref_1' }), ['Scroll to an element', [{ label: 'Element', value: 'ref_1' }]]);
  assert.deepEqual(view({ action: 'scroll_to' }), ['Scroll to an element', []]);
  assert.deepEqual(view({ action: 'left_click_drag', start_coordinate: [1, 2], coordinate: [3, 4] }), [
    'Drag',
    [
      { label: 'From', value: '1, 2' },
      { label: 'To', value: '3, 4' },
    ],
  ]);
  assert.deepEqual(view({ action: 'left_click_drag' }), ['Drag', []]);
  assert.deepEqual(view({ action: 'screenshot' }), ['Take a screenshot', []]);
  assert.deepEqual(view({ action: 'zoom' }), ['Zoom into the page', []]);
  assert.deepEqual(view({ action: 'wait' }), ['Wait', []]);
  assert.deepEqual(view({ action: 'teleport' }), ['Use the browser (teleport)', []]);
  assert.deepEqual(view({}), ['Use the browser', []]);
});

test('the other Chrome tools read as their action with readable input', () => {
  const v = (tool: string, input: any, url?: string) => chromeApproval(T(tool), input, url)!;
  assert.deepEqual(v('form_input', { ref: 'ref_3', value: 42 }).rows, [
    { label: 'Element', value: 'ref_3' },
    { label: 'Value', value: '42' },
  ]);
  assert.deepEqual(v('form_input', {}), { action: 'Fill in a field', host: null, rows: [], block: null });
  assert.deepEqual(v('find', { query: 'login button' }).rows, [{ label: 'Looking for', value: 'login button' }]);
  assert.deepEqual(v('find', {}).action, 'Find on the page');
  assert.equal(v('read_page', {}).action, 'Read the page');
  assert.equal(v('get_page_text', {}).action, 'Read the page');
  assert.deepEqual(v('javascript_tool', { action: 'javascript_exec', text: 'document.title' }), {
    action: 'Run JavaScript',
    host: null,
    rows: [],
    block: 'document.title',
  });
  assert.equal(v('javascript_tool', {}).block, null);
  // a new tab or the tab list is not about the tab's last page
  assert.deepEqual(v('tabs_create_mcp', {}, 'https://a.example'), { action: 'Open a new tab', host: null, rows: [], block: null });
  assert.deepEqual(v('tabs_context_mcp', {}, 'https://a.example').rows, []);
  assert.deepEqual(v('tabs_close_mcp', { tabId: 2 }, 'https://a.example').rows, [
    { label: 'Tab', value: 'last opened a.example in this chat' },
  ]);
  assert.deepEqual(v('file_upload', { paths: ['/tmp/a.png', '/tmp/b.pdf'] }).rows, [
    { label: 'File', value: '/tmp/a.png' },
    { label: 'File', value: '/tmp/b.pdf' },
  ]);
  assert.deepEqual(v('upload_image', {}), { action: 'Upload files', host: null, rows: [], block: null });
  assert.deepEqual(v('gif_creator', { action: 'start_recording', tabId: 1, options: { fps: 2 }, none: undefined }), {
    action: 'Gif creator',
    host: null,
    rows: [
      { label: 'action', value: 'start_recording' },
      { label: 'options', value: '{"fps":2}' },
    ],
    block: null,
  });
  assert.equal(v('shortcuts_list_mcp', {}).action, 'Shortcuts list');
  assert.equal(v('_mcp', {}).action, '_mcp');
  // a page that is not on the web is not named as a site
  assert.deepEqual(v('read_page', {}, 'file:///tmp/a.html').rows, []);
  assert.equal(chromeHost(''), null);
  assert.equal(chromeHost('http://[bad'), null);
});

test("the tab's last page is the last navigate to it in the chat", () => {
  const nav = (tabId: unknown, url: unknown, extra: any = {}) => ({
    type: 'mcpToolCall',
    server: 'claude-in-chrome',
    tool: 'navigate',
    arguments: { tabId, url },
    ...extra,
  });
  const items = [
    nav(1, 'https://one.example'),
    nav(2, 'https://two.example'),
    nav(1, 'back'),
    nav(1, 'forward'),
    nav(1, ' '),
    { type: 'mcpToolCall', server: 'other', tool: 'navigate', arguments: { tabId: 1, url: 'https://x.example' } },
    { type: 'mcpToolCall', server: 'claude-in-chrome', tool: 'computer', arguments: { tabId: 1 } },
    { type: 'agentMessage' },
    null,
    { type: 'mcpToolCall', server: 'claude-in-chrome', tool: 'navigate' },
  ];
  assert.equal(chromeTabUrl(items, 1), 'https://one.example');
  assert.equal(chromeTabUrl(items, 2), 'https://two.example');
  assert.equal(chromeTabUrl(items, 3), null);
  assert.equal(chromeTabUrl(items, undefined), 'https://two.example');
  assert.equal(chromeTabUrl([], 1), null);
});

test("the CLI's suggestions become one choice that says what it keeps and where", () => {
  const add = (destination: string, rules: any[] = [{ toolName: T('navigate') }], o: any = {}) => ({
    type: 'addRules',
    behavior: 'allow',
    destination,
    rules,
    ...o,
  });
  assert.deepEqual(chromeSuggestion([add('session')]), {
    label: 'Allow navigate for this session',
    hint: "Claude Code keeps this permission until this chat's Claude Code process restarts (after a long idle, an account change or an edited message); then it asks again",
  });
  assert.deepEqual(chromeSuggestion([add('cliArg')])?.label, 'Allow navigate for this session');
  assert.deepEqual(chromeSuggestion([add('localSettings')]), {
    label: 'Always allow navigate in this project',
    hint: 'Claude Code keeps this permission in this project',
  });
  assert.equal(
    chromeSuggestion([add('projectSettings', [{ toolName: 'mcp__claude-in-chrome' }])])?.label,
    'Always allow every Claude in Chrome action in this project',
  );
  assert.equal(
    chromeSuggestion([
      add('session'),
      add('userSettings', [
        null,
        { ruleContent: 'x' },
        { toolName: T('navigate') },
        { toolName: 'WebFetch', ruleContent: 'domain:example.com' },
      ]),
    ])?.label,
    'Always allow navigate, WebFetch (domain:example.com) in every project',
  );
  assert.equal(
    chromeSuggestion([{ type: 'replaceRules', behavior: 'allow', destination: 'elsewhere', rules: [{ toolName: T('find') }] }])?.label,
    'Always allow find in your settings',
  );
  // updates that are not allow rules are kept as given, named by where they go
  assert.equal(
    chromeSuggestion([
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
      add('session', [], { behavior: 'deny' }),
      add('session', 'x' as any),
    ])?.label,
    'Allow this for this session',
  );
  assert.equal(chromeSuggestion([]), null);
  assert.equal(chromeSuggestion(null), null);
  assert.equal(chromeSuggestion('x'), null);
});
