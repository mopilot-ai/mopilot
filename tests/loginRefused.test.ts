// How a provider's refusal of a stored login reads (shared/loginRefused.mjs, #4908): the CLI's own word and its sentence, for the adapter that marks a login and the check that probes it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeAuthFailed, isLoginRefused, LOGIN_REFUSED_SIGNAL } from '../shared/loginRefused.mjs';

const SENTENCE =
  'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access';
const said = (text: string) => ({ content: [{ type: 'text', text }] });

test('the provider refusing the login is read by its code, its signal and its sentence, and other words are left alone', () => {
  assert.equal(LOGIN_REFUSED_SIGNAL, 'oauth_org_not_allowed');
  for (const text of [SENTENCE, 'API Error: 403 oauth_not_allowed_for_organization', 'oauth_org_not_allowed'])
    assert.equal(isLoginRefused(text), true, text);
  for (const text of ['Your organization has disabled web search for this chat', 'rate_limit', '', 'Failed to authenticate'])
    assert.equal(isLoginRefused(text), false, text);
  for (const value of [undefined, null, 7, {}]) assert.equal(isLoginRefused(value), false);
});

test('an assistant message is its login failing by the CLI’s word, a lapse’s words or the refusal, and only when the CLI marked it an error', () => {
  assert.equal(claudeAuthFailed({ error: 'authentication_failed' }), true);
  assert.equal(claudeAuthFailed({ error: 'oauth_org_not_allowed' }), true, 'the CLI’s word for the refusal');
  assert.equal(claudeAuthFailed({ error: 'unknown', message: said('OAuth token has expired') }), true);
  assert.equal(claudeAuthFailed({ error: 'unknown', message: said(SENTENCE) }), true, 'the sentence alone, with no known code');
  assert.equal(claudeAuthFailed({ error: 'other', message: said('fine') }), false);
  assert.equal(claudeAuthFailed({ error: 'other' }), false);
  assert.equal(claudeAuthFailed({ message: said(SENTENCE) }), false, 'a reply that quotes the words is not a failure');
});
