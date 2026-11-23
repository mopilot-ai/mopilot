// electron/support/usageConsent.cjs and src/session/ratings.ts: the account's sharing choice merged at sign-in (the
// stricter side wins) and the Claude reply-rating event (D-80). What the private telemetry does with them is in
// tests/telemetryEvents.private.test.ts.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ratingEvent } from '../src/session/ratings.ts';

// Telemetry helpers need no native APIs; keep this unit test out of Electron's binary installer.
mock.module('electron', { exports: {} });
const require = createRequire(import.meta.url);
const { mergeConsent } = require('../electron/support/telemetry.cjs');

test('consent merge: either side off means off; an answer given before sign-in reaches the account', () => {
  // the web turned sharing off: this Mac follows and doesn't write the account back
  assert.deepEqual(mergeConsent(true, false), { value: false, put: false, write: true });
  // this Mac said no: the account is told, this Mac keeps it
  assert.deepEqual(mergeConsent(false, true), { value: false, put: true, write: false });
  assert.deepEqual(mergeConsent(false, false), { value: false, put: false, write: false });
  assert.deepEqual(mergeConsent(true, true), { value: true, put: false, write: false });
  // answered here before the account had a value
  assert.deepEqual(mergeConsent(true, null), { value: true, put: true, write: false });
  assert.deepEqual(mergeConsent(false, undefined), { value: false, put: true, write: false });
  // not answered here: off in the account is taken, on or unanswered defaults on
  assert.deepEqual(mergeConsent(null, false), { value: false, put: false, write: true });
  assert.deepEqual(mergeConsent(null, true), { value: true, put: false, write: true });
  assert.deepEqual(mergeConsent(null, null), { value: true, put: true, write: true });
});

test('reply rating: an event for every harness but Codex, whatever the sharing choice (the click is consent)', () => {
  assert.deepEqual(ratingEvent('claude', 'claude', 'good'), { harness: 'claude', rating: 'good' });
  assert.deepEqual(ratingEvent('claude', 'claude', 'bad'), { harness: 'claude', rating: 'bad' });
  assert.equal(ratingEvent('codex', 'codex', 'good'), null);
  // a basic harness's rating is counted the same way, under the kind its turns name; Codex's goes to its own upload
  assert.deepEqual(ratingEvent('acp', 'acp:kimi', 'good'), { harness: 'acp:kimi', rating: 'good' });
});
