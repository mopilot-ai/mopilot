// MoPilot's own Chrome channel narrates the complete Registry surface on every harness without changing browser ownership.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import {
  controlHandoff,
  controlSource,
  controlStep,
  controlThumbnail,
  isMoPilotControl,
  latestHandoff,
  ownBrowserTool,
  ownChromeTool,
} from '../src/lib/agentNarration.ts';
import { blockedOf } from '../src/lib/blockedChoices.ts';

export const GUARDS = ['electron/capabilities/', 'shared/', 'src/'];

const require = createRequire(import.meta.url);
const { CHROME_TOOL_NAMES } = require('../electron/capabilities/browser/chromeTools.cjs');
type Args = Record<string, unknown>;
const mcp = (tool: string, args: unknown = {}, text = '', server = 'sage') => ({
  id: 'chrome-step',
  type: 'mcpToolCall',
  server,
  tool,
  arguments: args,
  status: 'completed',
  result: { content: [{ type: 'text', text }] },
});
const wrappers = {
  dynamic: (name: string, args: unknown = {}, text = '') => ({
    id: 'chrome-step',
    type: 'dynamicToolCall',
    tool: `chrome_${name}`,
    arguments: args,
    status: 'completed',
    contentItems: [{ type: 'inputText', text }],
  }),
  mcp: (name: string, args?: unknown, text?: string) => mcp(`mcp__sage_0123456789ab__chrome_${name}`, args, text),
  acp: (name: string, args?: unknown, text?: string) => mcp(`sage.chrome_${name}`, args, text),
  claude: (name: string, args?: unknown, text?: string) => mcp(`mcp__mopilot_chrome__${name}`, args, text),
  server: (name: string, args?: unknown, text?: string) => mcp(name, args, text, 'mopilot_chrome'),
};
const cases: [string, Args, string, string][] = [
  ['tabs_context_mcp', {}, 'Checked the open tabs', 'Checking the open tabs'],
  ['tabs_create_mcp', {}, 'Opened a new tab', 'Opening a new tab'],
  ['tabs_close_mcp', { tabId: 42 }, 'Closed a tab', 'Closing a tab'],
  ['navigate', { url: 'https://example.com/a' }, 'Opened example.com', 'Opening example.com'],
  ['computer', { action: 'left_click', ref: 'ref_1' }, 'Clicked “Submit”', 'Clicking “Submit”'],
  ['read_page', {}, 'Read the page', 'Reading the page'],
  ['find', { query: 'Pricing' }, 'Looked for “Pricing”', 'Looking for “Pricing”'],
  ['form_input', {}, 'Filled in a form field', 'Filling in a form field'],
  ['get_page_text', {}, 'Read the page text', 'Reading the page text'],
  ['page_tools', {}, "Read the page's tools", "Reading the page's tools"],
  ['page_tool', { name: 'add_to_cart' }, "Ran the page's “add_to_cart” tool", "Running the page's “add_to_cart” tool"],
  ['javascript_tool', { text: 'document.title' }, 'Ran JavaScript on the page', 'Running JavaScript on the page'],
  ['read_console_messages', {}, 'Read the console', 'Reading the console'],
  ['read_network_requests', {}, 'Read network requests', 'Reading network requests'],
  ['resize_window', { width: 800, height: 600 }, 'Resized the page to 800×600', 'Resizing the page to 800×600'],
  ['file_upload', {}, 'Uploaded 1 file', 'Uploading 1 file'],
  ['upload_image', {}, 'Uploaded an image', 'Uploading an image'],
  ['handle_dialog', { accept: false }, 'Dismissed a dialog', 'Dismissing a dialog'],
  ['gif_creator', { action: 'export', tabId: 42 }, 'Saved a recording of the page', 'Saving a recording of the page'],
  [
    'browser_batch',
    { actions: [{ name: 'find' }, { name: 'computer', input: { action: 'screenshot' } }] },
    'Found, captured page in 2 steps',
    'Finding, capturing page in 2 steps',
  ],
  // the devtools group (G5, #3571)
  ['vitals', { tabId: 42 }, 'Measured the page’s Web Vitals', 'Measuring the page’s Web Vitals'],
  ['accessibility_audit', { tabId: 42 }, 'Audited the page’s accessibility', 'Auditing the page’s accessibility'],
  ['perf_trace', { action: 'stop', tabId: 42 }, 'Saved a performance trace', 'Saving a performance trace'],
  ['har', { action: 'start', tabId: 42 }, 'Started recording network traffic', 'Starting to record network traffic'],
  ['record', { action: 'stop', tabId: 42 }, 'Saved a video of the page', 'Saving a video of the page'],
  ['react', { action: 'tree', tabId: 42 }, 'Inspected React components', 'Inspecting React components'],
];

test('CM-Z: every own Chrome Registry tool has the same action narration on each harness', () => {
  assert.deepEqual(
    cases.map(([name]) => `chrome_${name}`).sort(),
    [...CHROME_TOOL_NAMES].sort(),
    'a newly offered Chrome tool needs a narration fixture',
  );
  for (const [wrapper, wrap] of Object.entries(wrappers)) {
    for (const [name, args, done, doing] of cases) {
      const item = wrap(name, args, 'on ref_1 "Submit"');
      assert.deepEqual(controlStep(item), { surface: 'browser', done, doing }, `${wrapper}: ${name}`);
      assert.equal(ownBrowserTool(item), null, `${wrapper}: Chrome must not become an in-app permission target`);
      assert.equal(isMoPilotControl(item), true, `${wrapper}: the own channel is not a vendor tool`);
    }
    assert.equal(
      controlStep(wrap('browser_batch', { actions: [{ name: 'form_input' }, { name: 'form_input' }] }))?.done,
      'Filled 2 fields',
    );
    assert.deepEqual(controlStep(wrap('navigate', { url: 'stop' })), {
      surface: 'browser',
      done: 'Stopped loading the page',
      doing: 'Stopping loading the page',
    });
  }
  for (const item of [mcp('browser_navigate', { url: 'stop' }), mcp('navigate', { url: 'stop' }, '', 'mopilot_browser')])
    assert.equal(controlStep(item)?.done, 'Stopped loading the page');
});

test('CM-Z: own Chrome scripts, malformed arguments, failures and screenshots share the same projection', () => {
  for (const wrap of Object.values(wrappers)) {
    assert.deepEqual(controlSource(wrap('javascript_tool', { text: 'document.title' })), {
      code: 'document.title',
      lang: 'javascript',
    });
    for (const args of [{ text: 42 }, {}, null, 'bad']) assert.equal(controlSource(wrap('javascript_tool', args)), null);
    assert.equal(controlSource(wrap('navigate', { url: 'https://example.com' })), null);
    assert.equal(controlStep(wrap('computer', null))?.done, 'Used the browser');
    const failure = { ...wrap('navigate', { url: 'https://example.com' }), status: 'failed', error: { message: 'not_connected' } };
    assert.equal(controlStep(failure)?.surface, 'browser');
    assert.equal(controlHandoff(failure), null);
    const screenshot = {
      ...wrap('computer', { action: 'screenshot' }),
      result: { content: [{ type: 'image', data: 'c2hvdA==', mimeType: 'image/png' }] },
    };
    assert.equal(controlStep(screenshot)?.done, 'Took a screenshot');
    assert.equal(controlThumbnail(screenshot), 'data:image/png;base64,c2hvdA==');
  }
});

test('CM-Z: later own Chrome activity retires an earlier handoff, without inferring a new one from page text', () => {
  const handoff = mcp('browser_tabs_mark', { tabId: 'tab_1', status: 'handoff' });
  assert.equal(latestHandoff([handoff])?.handoff.where, 'app');
  for (const wrap of Object.values(wrappers)) {
    for (const name of ['navigate', 'read_page', 'browser_batch']) {
      const later = wrap(name, { url: 'https://accounts.google.com/signin' }, 'Login required. Waiting for the user.');
      assert.equal(controlHandoff(later), null);
      assert.equal(latestHandoff([handoff, later]), null);
      assert.equal(latestHandoff([handoff, { ...later, status: 'failed' }]), null);
    }
  }
  assert.equal(latestHandoff([handoff, mcp('other_tool')])?.handoff.where, 'app');
  assert.equal(controlHandoff(mcp('navigate', {}, 'Please sign in', 'claude-in-chrome'))?.where, 'chrome');
  assert.deepEqual(ownBrowserTool(mcp('browser_navigate')), { name: 'navigate' });
  assert.deepEqual(ownBrowserTool(mcp('navigate', {}, '', 'mopilot_browser')), { name: 'navigate' });
  for (const tool of ['', '.', 'sage:', 'chrome_', 'Chrome_navigate', 'unrelated_navigate']) assert.equal(controlStep(mcp(tool)), null);
  assert.equal(controlStep(null), null);
});

test('CM-Z: own Chrome page text is neither a vendor problem nor an in-app permission or handoff signal', () => {
  for (const wrap of Object.values(wrappers)) {
    for (const name of ['read_page', 'get_page_text', 'javascript_tool', 'browser_batch']) {
      for (const text of [
        'Please open the Claude app.',
        'Please open the ChatGPT desktop app and enable Computer Use in Settings.',
        'Login required. Waiting for the user.',
        'Navigated tab_123 to https://accounts.google.com/signin (Sign in).',
        '<refusal reason="site_permission_denied">https://example.com</refusal>',
      ]) {
        const item = wrap(name, {}, text);
        assert.equal(controlStep(item)?.problem, undefined, `${name}: page text stays page text`);
        assert.equal(controlHandoff(item), null);
        assert.equal(blockedOf(item), null, `${name}: a page's text is not a refusal`);
      }
    }
  }
});

const failed = (item: any) => ({ ...item, status: 'failed' });
const refusal = (reason: string, extra = '') =>
  `Refused.\n<refusal reason="${reason}" retryable="false"${extra}>\nnext: Ask the user in chat.\n</refusal>`;

test('#1639: a bot check the own Chrome tools refused hands Chrome to the user on every harness; the agent going on retires it', () => {
  for (const [kind, wrap] of Object.entries(wrappers)) {
    const robot = failed(wrap('computer', { action: 'left_click', tabId: 42 }, refusal('bot_check', ' browser="chrome"')));
    assert.deepEqual(controlHandoff(robot), { where: 'chrome', reason: 'captcha', url: null, tabId: '42' }, kind);
    assert.deepEqual(latestHandoff([robot])?.handoff.where, 'chrome');
    assert.equal(blockedOf(robot), null, `${kind}: the hand-off strip shows it, not a second strip`);
    // a later step in Chrome means the agent went on
    assert.equal(latestHandoff([robot, wrap('read_page')]), null);
    // a refusal without a tab, or a failed call that was no bot check: a hand-off without a tab, or none
    assert.equal(controlHandoff(failed(wrap('find', { tabId: 'x' }, refusal('bot_check'))))?.tabId, 'x');
    assert.equal(controlHandoff(failed(wrap('find', {}, refusal('bot_check'))))?.tabId, null);
    assert.equal(controlHandoff(failed(wrap('computer', {}, 'Chrome did not answer within 30 s.'))), null);
  }
});

test('#1639: own Chrome navigation onto a sign-in page is the user’s turn in Chrome; other pages and other tools are not', () => {
  for (const [kind, wrap] of Object.entries(wrappers)) {
    const signin = wrap(
      'navigate',
      { url: 'https://accounts.google.com/' },
      'Navigated 42 to https://accounts.google.com/signin (Sign in).',
    );
    assert.deepEqual(controlHandoff(signin), { where: 'chrome', reason: 'signIn', url: null, tabId: '42' }, kind);
    assert.equal(controlHandoff(wrap('navigate', {}, 'Navigated 42 to https://shop.example/ (Shop).')), null);
    assert.equal(controlHandoff(wrap('tabs_create_mcp', {}, 'Navigated 42 to https://accounts.google.com/signin (Sign in).')), null);
    assert.equal(controlHandoff(failed(signin)), null);
  }
});

test('#1639: own Chrome refusals offer the user’s Chrome’s ways forward on every harness', () => {
  for (const [kind, wrap] of Object.entries(wrappers)) {
    const site = failed(
      wrap(
        'navigate',
        { url: 'https://shop.example/cart' },
        `You didn't allow https://shop.example\n${refusal('site_permission_denied', ' browser="chrome"')}`,
      ),
    );
    assert.deepEqual(
      { ...blockedOf(site), id: '' },
      {
        id: '',
        surface: 'browser',
        reason: 'site_permission_denied',
        origin: 'https://shop.example',
        browser: 'chrome',
        apps: [],
        text: 'You didn’t allow shop.example.',
        choices: ['allowSite', 'doItMyself'],
      },
      kind,
    );
    // even a refusal that doesn't name its browser is about the user's Chrome here
    const password = failed(wrap('computer', { action: 'type' }, refusal('password_field')));
    assert.equal(blockedOf(password)?.browser, 'chrome');
    assert.deepEqual(blockedOf(password)?.choices, ['doItMyself']);
    assert.equal(controlHandoff(password), null);
    assert.deepEqual(ownChromeTool(password), { name: 'computer', failed: true });
  }
  assert.equal(ownChromeTool(mcp('browser_navigate')), null);
  assert.equal(ownChromeTool(null), null);
});
