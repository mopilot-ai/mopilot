// electron/capabilities/browser/pluginConsent.cjs: Codex's Browser plugin site consent becomes the chat's MoPilot site grant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pluginSiteConsent, siteConsentOf, consentScope } = require('../electron/capabilities/browser/pluginConsent.cjs');
const { OriginGrants } = require('../electron/capabilities/browser/origins.cjs');

const request = (id: any, meta: any, params: any = {}) => ({
  id,
  method: 'mcpServer/elicitation/request',
  params: { threadId: 'thread-1', serverName: 'cua_repl', mode: 'form', _meta: meta, ...params },
});
const siteMeta = (o: any = {}) => ({ connector_id: 'browser-use', tool_name: 'access_browser_origin', origin: 'https://a.test', ...o });

test('siteConsentOf reads only the Browser plugin site and raw DevTools consent requests', () => {
  assert.equal(siteConsentOf(null), null);
  assert.equal(siteConsentOf({ method: 'other', id: 1 }), null);
  assert.equal(siteConsentOf({ method: 'mcpServer/elicitation/request' }), null, 'a notification, not a request');
  assert.equal(siteConsentOf({ method: 'mcpServer/elicitation/request', id: 1 }), null, 'no params');
  assert.equal(siteConsentOf(request(1, null)), null);
  assert.equal(siteConsentOf(request(1, siteMeta({ connector_id: 'other' }))), null);
  assert.equal(siteConsentOf(request(1, siteMeta({ tool_name: 'upload_browser_files' }))), null);
  assert.deepEqual(siteConsentOf(request(1, siteMeta())), {
    threadId: 'thread-1',
    origin: 'https://a.test',
    tool: 'access_browser_origin',
    browser: null,
  });
  assert.deepEqual(
    siteConsentOf(
      request(2, siteMeta({ tool_name: 'access_browser_origin_with_raw_cdp', origin: ' ', tool_params: { origin: 'https://b.test' } })),
    ),
    { threadId: 'thread-1', origin: 'https://b.test', tool: 'access_browser_origin_with_raw_cdp', browser: null },
  );
  // the card names the user's own browser: the plugin's Chrome backend
  assert.equal(siteConsentOf(request(3, siteMeta({ connector_name: 'Google Chrome' })))!.browser, 'chrome');
  assert.equal(siteConsentOf(request(3, siteMeta({ origin: undefined, tool_params: 'x' }))), null, 'no origin');
  assert.equal(siteConsentOf(request(4, siteMeta(), { threadId: undefined })), null, 'no thread');
});

test('consentScope: a plain accept is for the chat, persist "always" is for good, anything else allows nothing', () => {
  assert.equal(consentScope(null), null);
  assert.equal(consentScope({ action: 'decline' }), null);
  assert.equal(consentScope({ action: 'accept', _meta: null }), 'chat');
  assert.equal(consentScope({ action: 'accept', _meta: { persist: 'session' } }), 'chat');
  assert.equal(
    consentScope({ action: 'accept', _meta: { persist: 'always', browser_use_persistent_approval_scope: 'all-sites' } }),
    'always',
  );
});

test("an accepted plugin card is recorded once, on the thread's chat, so the iab backend doesn't ask again", async () => {
  let grants: any = null;
  const consent = pluginSiteConsent({ grants: () => grants, chatOf: (id: string) => `chat-of-${id}`, inApp: () => true });
  assert.equal(consent.observe(request(1, siteMeta({ origin: 'https://www.chase.com' }))), false, 'never consumed');
  assert.equal(consent.answered(1, { action: 'accept', content: {}, _meta: null }), false, 'no grants yet');
  assert.equal(consent.answered(1, { action: 'accept' }), false, 'already answered');
  const asked: any[] = [];
  grants = new OriginGrants({ ask: async (q: any) => (asked.push(q), { decision: 'deny' }) });
  consent.observe(request(2, siteMeta({ origin: 'https://www.chase.com' })));
  assert.equal(consent.answered(2, { action: 'accept', content: {}, _meta: null }), true);
  await grants.require('https://www.chase.com/', 'write', { chatId: 'chat-of-thread-1', segmentId: 'thread-1' });
  assert.equal(asked.length, 0);
  consent.observe(request(3, siteMeta({ origin: 'https://b.test' })));
  assert.equal(consent.answered(3, { action: 'accept', content: {}, _meta: { persist: 'always' } }), true);
  assert.equal(grants.get('https://b.test'), 'write');
  // a declined card records nothing
  consent.observe(request(4, siteMeta({ origin: 'https://c.test' })));
  assert.equal(consent.answered(4, { action: 'decline', content: null, _meta: null }), false);
  assert.equal(grants.get('https://c.test'), null);
  // a request answered elsewhere is forgotten; other messages are passed by
  consent.observe(request(5, siteMeta({ origin: 'https://d.test' })));
  assert.equal(consent.observe({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 5 } }), false);
  assert.equal(consent.answered(5, { action: 'accept' }), false);
  assert.equal(consent.observe(null), false);
  assert.equal(consent.observe({ method: 'serverRequest/resolved' }), false);
  assert.equal(consent.answered(99, { action: 'accept' }), false, 'not a site consent');
});
