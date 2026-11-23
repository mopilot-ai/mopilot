// Computer History never keeps excluded apps, excluded sites or secure fields (#1363), even when the saved allow list names them: every built-in exclusion goes through the real sample gate (policy.cjs admitSample), the real recorder and encrypted store (recorder.cjs, store.cjs) and the real read path (digest.cjs memoriesOf), with settings forced to allow it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeSafe, manualTimers } from './support/computerHistory.ts';

const require = createRequire(import.meta.url);
const { DEFAULT_SETTINGS, admitSample } = require('../electron/computerHistory/policy.cjs');
const { NEVER_APPS, HEALTH_DOMAINS } = require('../electron/computerHistory/exclusions.cjs');
const { memoriesOf } = require('../electron/computerHistory/digest.cjs');
const risk = require('../electron/capabilities/browser/siteRisk.json');
const { Recorder } = require('../electron/computerHistory/recorder.cjs');
const { HistoryStore } = require('../electron/computerHistory/store.cjs');
const { SAMPLE_MS } = require('../electron/computerHistory/segments.cjs');

/** A concrete bundle id for a pattern: "com.example.*" -> "com.example" and "com.example.app". */
const idsOf = (pattern: string) => (pattern.endsWith('.*') ? [pattern.slice(0, -2), `${pattern.slice(0, -2)}.app`] : [pattern]);
const excludedApps = NEVER_APPS.flatMap((r: { pattern: string }) => idsOf(r.pattern));
const excludedSites = [
  ...Object.keys(risk.domains),
  ...risk.pages.map((p: { host: string; path: string }) => `${p.host}${p.path}`),
  ...HEALTH_DOMAINS,
  'mopilot.ai',
  'accounts.google.com',
  'auth.openai.com',
  'login.example.com',
  'mybank.example',
  'patient.example.org',
];

/** Settings that, if the gate trusted them, would record everything below. */
const forced = {
  ...DEFAULT_SETTINGS,
  enabled: true,
  apps: [...excludedApps, 'com.google.Chrome', 'com.apple.Notes'].map((bundleId) => ({ bundleId, name: bundleId })),
  sites: excludedSites.map((s) => s.split('/')[0]),
};

test('the allow list cannot make Computer History record an excluded app', () => {
  assert.ok(excludedApps.length >= 15);
  for (const bundleId of excludedApps) {
    const r = admitSample({ bundleId, name: 'x', title: 'Vault — secret', secure: false }, forced);
    assert.equal(r.activity, undefined, bundleId);
    assert.equal(r.drop, 'excluded app', bundleId);
  }
  assert.equal(
    admitSample({ bundleId: 'com.apple.Notes', name: 'Notes', title: 'x', secure: false }, forced, { userDeny: ['com.apple.*'] }).drop,
    'excluded app',
    "the user's computer-use deny list is honored",
  );
});

test('the allow list cannot make Computer History record an excluded site', () => {
  assert.ok(excludedSites.length >= 100);
  for (const site of excludedSites) {
    const r = admitSample(
      { bundleId: 'com.google.Chrome', name: 'Chrome', title: 'Account', secure: false, url: `https://${site}` },
      forced,
    );
    assert.equal(r.activity, undefined, site);
    assert.equal(r.drop, 'excluded site', site);
  }
});

test('a secure field in focus drops the whole sample in every allowed app and site', () => {
  for (const s of [
    { bundleId: 'com.apple.Notes', name: 'Notes', title: 'Sign in', secure: true },
    { bundleId: 'com.google.Chrome', name: 'Chrome', title: 'Sign in', secure: true, url: 'https://example.com/' },
  ]) {
    assert.deepEqual(admitSample(s, { ...forced, sites: ['example.com'] }), { drop: 'secure field' });
  }
});

test('entries of excluded apps and sites on disk are never read back as memories', () => {
  const onDisk = [
    ...excludedApps.map((bundleId: string) => ({ bundleId, app: bundleId, title: 'x', start: 1, end: 2 })),
    ...excludedSites.map((s) => ({
      bundleId: 'com.google.Chrome',
      app: 'Chrome',
      title: 'x',
      site: s.split('/')[0],
      path: `/${s.split('/').slice(1).join('/')}`,
      start: 1,
      end: 2,
    })),
  ];
  assert.deepEqual(memoriesOf(onDisk), []);
});

test('the real recorder and store write nothing for excluded apps, excluded sites and secure fields', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-never-'));
  try {
    const store = new HistoryStore({ dir, safeStorage: fakeSafe() });
    // what a saved file could say if it were edited by hand: the store reads it back as it is
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(forced));
    const samples = [
      ...excludedApps.map((bundleId: string) => ({ bundleId, name: bundleId, title: 'Vault — secret', secure: false })),
      ...excludedSites.map((site) => ({
        bundleId: 'com.google.Chrome',
        name: 'Chrome',
        title: 'Account',
        secure: false,
        url: `https://${site}`,
      })),
      { bundleId: 'com.apple.Notes', name: 'Notes', title: 'Password: hunter2', secure: true },
    ];
    let now = new Date(2026, 9, 18, 9).getTime();
    const timers = manualTimers();
    const rec = new Recorder({ store, sample: async () => samples.shift(), idleSeconds: async () => 0, now: () => now, timers });
    assert.equal(rec.status, 'recording');
    assert.ok(!rec.settings.apps.some((a: { bundleId: string }) => excludedApps.includes(a.bundleId)), 'reading the file back drops them');
    // and if they reached the recorder anyway, its gate still drops every one
    rec.settings = forced;
    while (samples.length) {
      now += SAMPLE_MS;
      await rec.tick();
    }
    rec.dispose();
    assert.equal(rec.open, null);
    assert.deepEqual(store.listDays(), [], 'no day file was even created');
    assert.equal(fs.existsSync(store.days), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
