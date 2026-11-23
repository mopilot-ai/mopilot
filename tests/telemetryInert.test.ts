// electron/support/telemetry.cjs without its private service (the open-source edition): an inert reporter that sends,
// writes and listens for nothing but drains the window's usage channels, and the shared consent and identity helpers.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

mock.module('electron', { exports: {} });
const require = createRequire(import.meta.url);
mock.module(require.resolve('../electron/support/optionalAnalytics.cjs'), {
  exports: { optionalAnalytics: (_name: string, value: unknown) => value },
});
const api = require('../electron/support/telemetry.cjs');

test('without the private service every reporter call is inert and its report context is empty', async () => {
  const t = new api.Telemetry();
  for (const method of ['startCrashReporter', 'start', 'setConsent', 'identityChanged', 'track', 'rate', 'error', 'shareTurn', 'persist'])
    t[method]();
  assert.equal(t.consent, false);
  assert.equal(t.reportMigration(), false);
  assert.deepEqual(JSON.parse(JSON.stringify(await t.reportContext())), { channel: 'unknown', versions: null, fingerprints: [] });
  assert.equal(await t.flush(), undefined);
  for (const loc of [true, false, null, 'bad'])
    for (const acct of [true, false, null, undefined]) assert.equal(api.mergeConsent(loc, acct).value, loc !== false && acct !== false);
  assert.equal(api.harnessVersions(), null);
  assert.equal(api.REPORT_MARKER, '');
  assert.equal(typeof api.fingerprint('x'), 'string');
});

test("the window's usage channels still end in main, which drops what they carry", () => {
  const listeners = new Map<string, (...a: unknown[]) => unknown>();
  new api.Telemetry().register({ on: (channel: string, fn: (...a: unknown[]) => unknown) => listeners.set(channel, fn) });
  assert.deepEqual([...listeners.keys()].sort(), ['telemetry:error', 'telemetry:rate', 'telemetry:shareTurn', 'telemetry:track']);
  for (const fn of listeners.values()) assert.equal(fn({}, 'event', { prompt: 'secret' }), undefined);
});
