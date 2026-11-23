// Structured refusals of the browser_* tools (electron/capabilities/browser/refusals.cjs): a stable
// reason, retryable and a next step for every security refusal, with the ToolError code kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { explainRefusal, explained, refusalOf, NO_WORKAROUND } = require('../electron/capabilities/browser/refusals.cjs');
const { ToolError } = require('../electron/capabilities/contract/registry.cjs');

const CASES: Array<[string, string, string, boolean]> = [
  ['blocked', 'This site is blocked. https://x.example/', 'site_blocked', false],
  ['denied', 'The user did not allow this action (delete) on https://a.example.', 'sensitive_action_declined', false],
  ['denied', 'The user did not allow this action on https://a.example.', 'action_declined', false],
  ['denied', "The user didn't sign in on t1. Ask them how to continue.", 'signin_cancelled', false],
  ['denied', 'The user did not allow this.', 'user_declined', false],
  ['denied', 'The user did not allow https://a.example in this chat.', 'site_permission_denied', false],
  ['read_only', 'This chat is in a read-only mode: browser control can only look.', 'chat_read_only', false],
  ['read_only', 'https://a.example is read only for this chat.', 'site_read_only', false],
  ['password_field', 'This field is a password field.', 'password_field', false],
  [
    'disabled',
    "Actions on https://a.example need the user's confirmation, which this chat can't ask for.",
    'confirmation_unavailable',
    false,
  ],
  ['disabled', 'JavaScript is turned off for this chat.', 'tool_disabled', false],
  ['disabled', 'File upload is turned off.', 'tool_disabled', false],
  ['disabled', 'Browser control is turned off.', 'browser_control_disabled', false],
  ['bad_url', 'Only http and https pages can be opened: file:///etc/hosts', 'scheme_blocked', false],
  ['bad_args', 'Only files inside /u can be uploaded: /etc/passwd', 'upload_outside_folder', true],
  ['limit', 'This chat already has 8 tabs. Close one with browser_tabs_close first.', 'tab_limit', true],
  ['taken_over', 'The user took over t1.', 'user_took_over', false],
  ['signin_pending', 'The user is signing in on t1.', 'signin_pending', true],
  ['unavailable', "Couldn't ask the user about https://a.example: no window. Try again.", 'consent_unavailable', true],
  ['wrong_browser', "This chat's browser is Your Chrome.", 'credentials_unavailable', false],
];

test('every security refusal gets a reason, retryable and a next step, keeping its code and message', () => {
  for (const [code, message, reason, retryable] of CASES) {
    const e = explainRefusal(new ToolError(message, code));
    assert.equal(e.code, code);
    assert.equal(e.reason, reason, message);
    assert.equal(e.retryable, retryable);
    assert.ok(e.next.length > 10);
    const tail = retryable ? '' : `\n${NO_WORKAROUND}`;
    assert.equal(e.message, `${message}\n<refusal reason="${reason}" retryable="${retryable}">\nnext: ${e.next}${tail}\n</refusal>`);
  }
});

test('a file outside the upload folder: the agent saves or copies it there itself, not the user (#1381)', () => {
  const e = explainRefusal(new ToolError('Only files inside /u can be uploaded: /Users/me/Documents/Declaration.pdf', 'bad_args'));
  assert.equal(e.reason, 'upload_outside_folder');
  assert.equal(e.retryable, true);
  assert.match(e.next, /^Save or copy the file into this chat's upload folder/);
  // only files the task made or the user asked for; anything else stays the user's call
  assert.match(e.next, /ask the user about any other file/);
  assert.ok(!e.message.includes(NO_WORKAROUND), 'copying the file in is the intended path, not a workaround');
});

test('anything else is not a refusal and stays as it is; explaining twice adds nothing', () => {
  for (const e of [
    new ToolError('Not a valid URL: x', 'bad_url'),
    new ToolError('missing argument: url', 'bad_args'),
    new ToolError('A script can return at most 10 screenshots.', 'limit'),
    new ToolError('took too long', 'timeout'),
  ]) {
    assert.equal(refusalOf(e), null);
    const before = e.message;
    assert.equal(explainRefusal(e), e);
    assert.equal(e.message, before);
    assert.equal(e.reason, undefined);
  }
  assert.equal(refusalOf(new Error('x')), null);
  assert.equal(explainRefusal('plain'), 'plain');
  const e = explainRefusal(new ToolError('The user did not allow this.', 'denied'));
  const once = e.message;
  assert.equal(explainRefusal(e).message, once);
});

test('a ToolError that names its own reason keeps it', () => {
  const e: any = new ToolError('Custom stop.', 'denied');
  e.reason = 'custom_reason';
  e.retryable = true;
  e.next = 'Do the other thing.';
  assert.deepEqual(refusalOf(e), { reason: 'custom_reason', retryable: true, next: 'Do the other thing.' });
  explainRefusal(e);
  assert.equal(e.message, 'Custom stop.\n<refusal reason="custom_reason" retryable="true">\nnext: Do the other thing.\n</refusal>');
  const bare: any = new ToolError('Bare.', 'x');
  bare.reason = 'bare_reason';
  assert.deepEqual(refusalOf(bare), { reason: 'bare_reason', retryable: false, next: '' });
});

test('explained() passes values through and explains a rejection', async () => {
  assert.equal(await explained(Promise.resolve(7)), 7);
  assert.equal(await explained(7), 7);
  await assert.rejects(
    explained(Promise.reject(new ToolError('Tab limit. This chat already has 8 tabs. Close one', 'limit'))),
    (e: any) => {
      assert.equal(e.reason, 'tab_limit');
      return true;
    },
  );
});
