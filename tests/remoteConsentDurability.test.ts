// Mobile Remote consent only succeeds after a durable write on supported state.
import { test, mock } from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { patchPrefsSync, readUiState } = require('../electron/platform/chats.cjs');
const { createConsent } = require('../electron/remote/consent.cjs');

test('the consent acknowledgment follows both actual filesystem sync barriers', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'remote-consent-barriers-'));
  const file = join(dir, 'state.json');
  const sync = fs.fsyncSync;
  const observed: string[] = [];
  t.mock.method(fs, 'fsyncSync', (fd: number) => {
    observed.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file');
    return sync(fd);
  });
  try {
    patchPrefsSync(file, { mobileRemoteOwner: 'owner' });
    assert.deepEqual(observed, ['file', 'directory']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('consent waits for durable state, refuses newer schemas and recovers after failed writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'remote-consent-'));
  const file = join(dir, 'state.json');
  const live = { mopilot: { creds: { user: { id: 'u' }, deviceId: 'd' } } };
  const consent = createConsent(
    live,
    () => readUiState(file),
    patchPrefsSync,
    () => file,
  );
  try {
    consent.set(true);
    assert.equal(consent.enabled(), true);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).prefs.mobileRemoteOwner, consent.scope());
    consent.set(false);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).prefs.mobileRemoteOwner, null);
    writeFileSync(file, JSON.stringify({ stateVersion: 999999, prefs: { mobileRemoteOwner: consent.scope() } }));
    assert.equal(consent.enabled(), false);
    assert.throws(() => consent.set(true));
    assert.equal(consent.enabled(), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('failed retirement blocks the same returning owner and an explicit retry recovers', () => {
  const owner = { user: { id: 'u' }, deviceId: 'd' };
  const live: any = { mopilot: { creds: owner } };
  let prefs: any = { mobileRemoteOwner: JSON.stringify(['u', 'd']) };
  let fail = true;
  const consent = createConsent(
    live,
    () => ({ prefs }),
    (_file: string, delta: object) => {
      if (fail) throw new Error('disk unavailable');
      return Object.assign(prefs, delta);
    },
    () => 'x',
  );
  assert.equal(consent.enabled(), true);
  live.mopilot.creds = null;
  assert.throws(() => consent.set(false), /disk unavailable/);
  live.mopilot.creds = owner;
  assert.equal(consent.enabled(), false);
  assert.equal(consent.warning, true);
  fail = false;
  consent.set(true);
  assert.equal(consent.enabled(), true);
  assert.equal(consent.warning, false);
});

test('real state writer reports disk failure and retries without restoring a failed opt-in', () => {
  const dir = mkdtempSync(join(tmpdir(), 'remote-consent-failure-'));
  const file = join(dir, 'state.json');
  const live = { mopilot: { creds: { user: { id: 'u' }, deviceId: 'd' } } };
  const consent = createConsent(
    live,
    () => readUiState(file),
    patchPrefsSync,
    () => file,
  );
  try {
    const rename = mock.method(fs, 'renameSync', () => {
      throw new Error('disk unavailable');
    });
    assert.throws(() => consent.set(true));
    assert.equal(consent.enabled(), false);
    assert.equal(consent.warning, true);
    rename.mock.restore();
    consent.set(false);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).prefs.mobileRemoteOwner, null);
    consent.set(true);
    assert.equal(consent.enabled(), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retirement refuses a newer file replacing a pending snapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'remote-schema-'));
  const file = join(dir, 'state.json');
  const { patchPrefs } = require('../electron/platform/chats.cjs');
  try {
    patchPrefs(file, { theme: 'dark' });
    writeFileSync(file, JSON.stringify({ stateVersion: 999999, prefs: { extra: true } }));
    assert.throws(() => patchPrefsSync(file, { mobileRemoteOwner: null }));
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).prefs.extra, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing identity and null receipts never grant consent', () => {
  const live: any = { mopilot: { creds: null } };
  const consent = createConsent(
    live,
    () => ({}),
    () => null,
    () => 'x',
  );
  assert.throws(() => consent.set(true), /Sign in/);
  live.mopilot.creds = { user: { id: 'u' }, deviceId: 'd' };
  assert.throws(() => consent.set(true), /not saved/);
  assert.equal(consent.enabled(), false);
  assert.equal(consent.warning, true);
});

test('a directory sync failure after rename stays blocked and reports uncertainty until retry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'remote-consent-sync-'));
  const file = join(dir, 'state.json');
  const live = { mopilot: { creds: { user: { id: 'u' }, deviceId: 'd' } } };
  const consent = createConsent(
    live,
    () => readUiState(file),
    patchPrefsSync,
    () => file,
  );
  try {
    consent.set(true);
    const sync = fs.fsyncSync;
    let n = 0;
    const failure = mock.method(fs, 'fsyncSync', (fd: number) => {
      if (++n === 2) throw new Error('directory sync failed');
      return sync(fd);
    });
    assert.throws(() => consent.set(false));
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).prefs.mobileRemoteOwner, null);
    assert.equal(consent.enabled(), false);
    assert.equal(consent.warning, true);
    failure.mock.restore();
    consent.set(true);
    assert.equal(consent.enabled(), true);
    assert.equal(consent.warning, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
