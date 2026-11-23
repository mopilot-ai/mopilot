// The sign-in words and link rules one module says for the Mac and the phone (shared/host/signinWords.mjs, signinLinks.mjs): the Mac's copy file, its sign-in service and its controls read the same ones the phone's sheet does.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { ACTION_LABEL, RUNNING_STATES, SIGNIN_WORDS, signinStatus, startLabel, wantsCode } from '../shared/host/signinWords.mjs';
import { MAX_URL, onVendorSite, openable, VENDOR_SITES } from '../shared/host/signinLinks.mjs';
import * as macCopy from '../src/lib/hostSigninCopy.ts';

const require = createRequire(import.meta.url);
const view = (o: object = {}) => ({ state: 'waiting', codes: [] as string[], link: false, error: null, ...o });

test('the words of every state, in the agent’s name', () => {
  assert.equal(signinStatus(undefined, 'Codex'), null);
  assert.deepEqual(signinStatus(view({ state: 'starting' }), 'Codex'), { text: 'Opening the sign-in page…', action: 'cancel' });
  assert.deepEqual(signinStatus(view(), 'Codex'), { text: 'Opening the sign-in page…', action: 'cancel' });
  assert.deepEqual(signinStatus(view({ link: true }), 'Codex'), { text: 'Finish signing in in your browser', action: 'cancel' });
  assert.deepEqual(signinStatus(view({ codes: ['ABCD-1234', 'X'] }), 'Codex'), {
    text: 'Enter this code in the page that opened',
    code: 'ABCD-1234',
    action: 'cancel',
  });
  assert.deepEqual(signinStatus(view({ state: 'checking' }), 'Codex'), { text: 'Checking the sign-in…' });
  assert.deepEqual(signinStatus(view({ state: 'signed-in' }), 'Codex'), { text: 'Signed in' });
  assert.deepEqual(signinStatus(view({ state: 'expired' }), 'Codex'), { text: 'That code expired', action: 'retry' });
  assert.deepEqual(signinStatus(view({ state: 'unreachable', error: 'away' }), 'Codex'), {
    text: "Couldn't reach the machine",
    action: 'retry',
    details: 'away',
  });
  assert.deepEqual(signinStatus(view({ state: 'unreachable' }), 'Codex'), { text: "Couldn't reach the machine", action: 'retry' });
  assert.deepEqual(signinStatus(view({ state: 'failed', reason: 'no_page' }), 'Codex'), {
    text: "Codex didn't open a sign-in page",
    action: 'retry',
  });
  assert.deepEqual(signinStatus(view({ state: 'failed', error: 'Please migrate to the Antigravity suite' }), 'Gemini'), {
    text: 'Google ended this sign-in for personal accounts',
    action: 'api-key',
    details: 'Please migrate to the Antigravity suite',
  });
  assert.deepEqual(signinStatus(view({ state: 'failed', error: 'odd' }), 'Codex'), {
    text: "Couldn't sign in to Codex",
    action: 'retry',
    details: 'odd',
  });
  assert.deepEqual(signinStatus(view({ state: 'failed' }), 'Codex'), { text: "Couldn't sign in to Codex", action: 'retry' });
  // nothing to say before one starts, after Cancel, or for a state the words do not know
  for (const state of ['idle', 'cancelled', 'something-new']) assert.equal(signinStatus(view({ state }), 'Codex'), null, state);
});

test('the labels, the running states and what waits for a pasted code', () => {
  assert.deepEqual(ACTION_LABEL, { retry: 'Try again', 'api-key': 'Use an API key', cancel: 'Cancel' });
  assert.deepEqual(SIGNIN_WORDS, {
    signIn: 'Sign in',
    newCode: 'Get a new code',
    openPage: 'Open page',
    cancel: 'Cancel',
    send: 'Send',
    codeField: 'Code from the page',
    ended: 'That sign-in has ended. Start it again.',
    openFailed: "Couldn't open the page.",
  });
  assert.deepEqual(RUNNING_STATES, ['starting', 'waiting']);
  assert.equal(startLabel('expired'), 'Get a new code');
  assert.equal(startLabel('failed'), 'Sign in');
  assert.equal(startLabel(undefined), 'Sign in');
  assert.equal(wantsCode(undefined), false);
  assert.equal(wantsCode(view({ link: true })), true);
  assert.equal(wantsCode(view({ link: true, codes: ['A'] })), false, 'a code of its own needs none typed back');
  assert.equal(wantsCode(view()), false, 'no page was opened');
  assert.equal(wantsCode(view({ state: 'failed', link: true })), false);
});

test('the Mac’s copy file is the shared words: its status and labels are the same ones', () => {
  const v = { hostId: 'h', harness: 'codex', url: null, ...view({ codes: ['ABCD-1234'] }) } as any;
  assert.deepEqual(macCopy.signinStatus(v, 'Codex'), signinStatus(v, 'Codex'));
  assert.equal(macCopy.ACTION_LABEL, ACTION_LABEL);
  assert.equal(macCopy.signinStatus(undefined, 'Codex'), null);
});

test('only a plain https page is opened: no other scheme, no embedded login, no oversize link', () => {
  assert.equal(openable('https://chatgpt.com/device?x=1'), 'https://chatgpt.com/device?x=1');
  for (const bad of [
    'http://chatgpt.com',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'https://u:p@chatgpt.com/',
    'https://u@chatgpt.com/',
    'x',
    '',
    null,
    7,
  ])
    assert.equal(openable(bad), null, String(bad));
  assert.equal(openable(`https://chatgpt.com/${'a'.repeat(MAX_URL)}`), null);
});

test('a vendor’s sign-in stays on its own site; an agent with no listed site is limited to https alone', () => {
  assert.equal(onVendorSite('codex', 'https://chatgpt.com/x'), true);
  assert.equal(onVendorSite('codex', 'https://auth.openai.com/x'), true);
  assert.equal(onVendorSite('codex', 'https://CHATGPT.com/x'), true);
  assert.equal(onVendorSite('codex', 'https://notchatgpt.com/x'), false);
  assert.equal(onVendorSite('codex', 'https://claude.ai/x'), false);
  assert.equal(onVendorSite('claude', 'https://claude.ai/x'), true);
  assert.equal(onVendorSite('gemini', 'https://accounts.example.org/x'), true);
  assert.equal(onVendorSite('constructor', 'https://anywhere.example/x'), true, 'a name every object has is not a vendor');
  assert.deepEqual(Object.keys(VENDOR_SITES), ['claude', 'codex']);
});

test('the Mac’s sign-in service applies the same link rules', () => {
  const mac = require('../electron/host/signin.cjs');
  assert.equal(mac.openable, openable);
  assert.equal(mac.onVendorSite, onVendorSite);
});
