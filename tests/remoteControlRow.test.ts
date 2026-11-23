// The Remote Control switch's projection of a chat's link (src/session/remoteControlRow.ts): position, whether it can be pressed, the line under it and the page it opens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexRemoteControlRow, remoteControlRow } from '../src/session/remoteControlRow.ts';

const rc = (state: string, extra: object = {}) => ({ state, url: null, error: null, wanted: true, ...extra }) as any;

test('a harness or login that cannot link is off and disabled with its reason, whatever the link says', () => {
  for (const view of [null, rc('on', { url: 'https://claude.ai/code/s' })])
    assert.deepEqual(remoteControlRow(view, 'Not available for this chat', true), {
      on: false,
      disabled: true,
      note: 'Not available for this chat',
      url: null,
    });
});

test('a chat that has not run a turn has no session to link', () => {
  for (const view of [null, rc('off')])
    assert.deepEqual(remoteControlRow(view, null, false), { on: false, disabled: true, note: 'Send a message first', url: null });
});

test('a chat that has run but was never linked can be linked: main reports nothing until the first link', () => {
  assert.deepEqual(remoteControlRow(null, null, true), { on: false, disabled: false, note: null, url: null });
});

test('an unavailable link is disabled with the error main gave, else a plain line', () => {
  assert.deepEqual(remoteControlRow(rc('unavailable', { error: 'Turned off by your organization' }), null, true), {
    on: false,
    disabled: true,
    note: 'Turned off by your organization',
    url: null,
  });
  assert.equal(remoteControlRow(rc('unavailable'), null, true).note, 'Not available');
});

test('a failed link is off but can be tried again, saying what failed', () => {
  assert.deepEqual(remoteControlRow(rc('error', { error: 'Network error' }), null, true), {
    on: false,
    disabled: false,
    note: 'Network error',
    url: null,
  });
  assert.equal(remoteControlRow(rc('error'), null, true).note, "Couldn't connect");
});

test('a link that is up is on and opens its page', () => {
  assert.deepEqual(remoteControlRow(rc('on', { url: 'https://claude.ai/code/s' }), null, true), {
    on: true,
    disabled: false,
    note: 'Linked to claude.ai',
    url: 'https://claude.ai/code/s',
  });
});

test('a link that is wanted but not up stays on and says what it waits for, with no page to open', () => {
  for (const [state, note] of [
    ['connecting', 'Connecting…'],
    ['offline', 'Reconnecting to claude.ai'],
    ['signin', 'Sign in again to reconnect'],
  ])
    assert.deepEqual(remoteControlRow(rc(state, { url: 'https://claude.ai/code/old' }), null, true), {
      on: true,
      disabled: false,
      note,
      url: null,
    });
});

test('an off link is an enabled, quiet switch', () => {
  assert.deepEqual(remoteControlRow(rc('off', { wanted: false }), null, true), { on: false, disabled: false, note: null, url: null });
});

const codex = (status: string, error: string | null = null, extra: object = {}) =>
  ({ status, environmentId: null, error, ...extra }) as any;

test("Codex's switch is the computer's: it needs no turn, is inert until read, and is greyed with the login's reason", () => {
  assert.deepEqual(codexRemoteControlRow(null, null), { on: false, disabled: true, note: null, url: null });
  const why = 'Remote Control needs a signed-in ChatGPT account. Choose one in Accounts.';
  assert.deepEqual(codexRemoteControlRow(codex('connected'), why), { on: false, disabled: true, note: why, url: null });
});

test('Codex: the link that is coming up or up is on, a failed one off with its words, and an off one says what it covers', () => {
  assert.deepEqual(codexRemoteControlRow(codex('connecting'), null), { on: true, disabled: false, note: 'Connecting…', url: null });
  assert.deepEqual(codexRemoteControlRow(codex('connected'), null), {
    on: true,
    disabled: false,
    note: 'Connected · this computer',
    url: null,
  });
  assert.equal(
    codexRemoteControlRow(codex('errored', 'Sign in with ChatGPT to use Remote Control.'), null).note,
    'Sign in with ChatGPT to use Remote Control.',
  );
  assert.equal(codexRemoteControlRow(codex('errored'), null).note, "Couldn't connect");
  assert.deepEqual(codexRemoteControlRow(codex('disabled'), null), {
    on: false,
    disabled: false,
    note: 'Applies to this computer',
    url: null,
  });
  assert.equal(codexRemoteControlRow(codex('disabled', 'not reachable'), null).note, 'not reachable');
});

test("Codex's switch stays on while the app-server retries, with the last reason; a refusal turns it off with the detail", () => {
  assert.deepEqual(codexRemoteControlRow(codex('errored', 'Nope.', { retrying: true, detail: '503' }), null), {
    on: true,
    disabled: false,
    note: 'Reconnecting… Nope. · 503',
    url: null,
  });
  assert.equal(codexRemoteControlRow(codex('connecting', 'Nope.', { retrying: true }), null).note, 'Reconnecting… Nope.');
  assert.equal(codexRemoteControlRow(codex('errored', 'Nope.', { detail: '503' }), null).note, 'Nope. · 503');
  assert.equal(codexRemoteControlRow(codex('errored'), null).note, "Couldn't connect");
});
