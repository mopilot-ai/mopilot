// The control matrix, group U (VendorErrors, docs/control-plane/design.md): Playwright MCP's error for a Chrome profile
// without the Playwright Extension reaches the model as Your Chrome not set up, with what the user does and no
// workaround, never as Playwright's sentence about its environment variables (#1319 G21). The Your Chrome tools, the
// vendor error table and the refusal rules are real; Playwright MCP's instance and the site table are fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

export const GUARDS = ['electron/capabilities/', 'shared/'];

const require = createRequire(import.meta.url);
const { chromeTools } = require('../electron/capabilities/browser/extension.cjs');

const SITE = 'https://example.com/';
const MISSING =
  '### Error\nError: Playwright Extension not found in "/Users/me/Library/Application Support/Google/Chrome". Install it from https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm, or set the PLAYWRIGHT_MCP_EXECUTABLE_PATH environment variable to use a browser at a custom location.';
const ctx = { chatId: 'c1', segmentId: 's1' };

function tools(answer: (name: string) => any) {
  const inst = { url: SITE, call: async (name: string) => answer(name) };
  const grants = { require: async () => {}, act: async () => false };
  const defs = chromeTools({
    channel: { instance: async () => inst },
    grants,
    enabled: () => true,
    schemas: [{ name: 'browser_navigate' }, { name: 'browser_click' }],
  });
  return Object.fromEntries(defs.map((d: any) => [d.name, d.handler]));
}

test('CM-U05: Your Chrome without the Playwright Extension refuses as not set up, with the next step and no workaround, on a read and before a write', async () => {
  const by = tools(() => ({ isError: true, content: [{ type: 'text', text: MISSING }] }));
  for (const [name, args] of [
    ['sage_browser_navigate', { url: SITE }],
    ['sage_browser_click', { element: 'Delete', ref: 'e1' }],
  ] as const) {
    const e: any = await by[name](args, ctx).then(
      () => null,
      (err: any) => err,
    );
    assert.ok(e, name);
    assert.equal(e.code, 'not_installed', name);
    assert.match(e.message, /^Your Chrome isn't set up: the Playwright Extension isn't installed/);
    assert.match(e.message, /reason="chrome_not_set_up" retryable="false" browser="chrome"/);
    assert.match(e.message, /Settings → Browser/);
    assert.match(e.message, /Do not try to achieve the same outcome/);
    assert.doesNotMatch(e.message, /PLAYWRIGHT_MCP_EXECUTABLE_PATH/);
  }
  // any other Playwright error stays as Playwright sent it
  const other = tools(() => ({ isError: true, content: [{ type: 'text', text: '### Error\nError: net::ERR_NAME_NOT_RESOLVED' }] }));
  const e: any = await other.sage_browser_navigate({ url: SITE }, ctx).catch((err: any) => err);
  assert.equal(e.code, 'failed');
  assert.match(e.message, /ERR_NAME_NOT_RESOLVED/);
});
