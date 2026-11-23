// The apikey-login lint guard (lint/rules/apikey-login.grit): an API key handed to a Codex app-server login warns,
// since Codex saves it to its auth.json in plain text (#2201); other logins and requests do not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintFixtures } from '../scripts/biome-fixtures.mjs';

test('an apiKey login to a Codex app-server warns; ChatGPT token logins and other requests stay valid', () => {
  for (const [input, expected] of [
    ["this.mainRequest('account/login/start', { type: 'apiKey', apiKey: key });", 1],
    ["sc.call('account/login/start', { type: 'apiKey', apiKey });", 1],
    ['request("account/login/start", { apiKey: k, type: \'apiKey\' });', 1],
    ["this.mainRequest('account/login/start', { type: 'chatgptAuthTokens', accessToken: t });", 0],
    ["sc.call('account/login/start', { type: 'chatgpt' });", 0],
    ["this.mainRequest('account/read', { type: 'apiKey' });", 0],
  ] as const) {
    const report = lintFixtures({ 'electron/login.cjs': `${input}\n` });
    const hits = report.diagnostics.filter((d) => d.message.includes('[apikey-login]'));
    assert.equal(hits.length, expected, input);
  }
});
