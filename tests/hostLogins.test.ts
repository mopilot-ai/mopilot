// The Host's logins and credential choice on the wire (shared/host/logins.mjs): the choice a chat start carries and the gate that refuses an older Host, what an agent reports read defensively, and what the Mac's registry keeps of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { effectiveLogins, loginsOf, normalizeHarness, credentialOf, LOGINS_FEATURE, REFUSALS } from '../shared/host/logins.mjs';
const require = createRequire(import.meta.url);
const S = require('../shared/host/schema.mjs');
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useFakeClock as installFakeClock } from './support/ports/clock.ts';
const { createRegistry } = require('../electron/host/registry.cjs');

const start = { chatId: 'claude:abc', epoch: 3, key: 'req-0000001', harness: 'claude', text: 'go', projectId: null };
const bad = (m: string) => new Error(m);

test('a chat start may carry where its model access comes from; absent keeps the Host’s own order', () => {
  assert.equal('credential' in S.parseParams('chat.start', start), false);
  assert.deepEqual(S.parseParams('chat.start', { ...start, credential: { source: 'key' } }).credential, { source: 'key' });
  assert.deepEqual(S.parseParams('chat.start', { ...start, credential: { source: 'own', login: 'work' } }).credential, {
    source: 'own',
    login: 'work',
  });
  for (const credential of [
    { source: 'cloud' },
    'own',
    { source: 'key', login: 'work' },
    { source: 'own', login: 'bad id!' },
    { source: 'own', login: 7 },
    {},
  ])
    assert.throws(() => S.parseParams('chat.start', { ...start, credential }), /Pick|not a login|login/, JSON.stringify(credential));
  assert.throws(() => credentialOf(null, bad));
});

test('a Host without the feature is refused a start that carries a choice, never silently served; one without a choice is unaffected', () => {
  const have = { features: ['epoch', 'dedupe', 'isolation'] };
  assert.doesNotThrow(() => S.requireFeatures('chat.start', have, {}));
  assert.throws(
    () => S.requireFeatures('chat.start', have, { credential: { source: 'own' } }),
    (e: any) => e.code === 'feature_missing' && e.missing.includes(LOGINS_FEATURE),
  );
  assert.doesNotThrow(() =>
    S.requireFeatures('chat.start', { features: [...have.features, LOGINS_FEATURE] }, { credential: { source: 'own' } }),
  );
  assert.equal(S.FEATURES.includes(LOGINS_FEATURE), true, 'the build that keeps and enforces the choice declares the feature');
});

test('reported logins are read defensively: bad rows dropped, unknown words quieted, usage bounded', () => {
  const rows = loginsOf([
    {
      id: 'work',
      label: ' Work ',
      state: 'ok',
      active: true,
      billing: 'subscription',
      usage: [
        { label: '5h', usedPercent: 40, resetsAt: 9 },
        { label: '', usedPercent: 1 },
        { label: 'x', usedPercent: 400 },
      ],
    },
    { id: 'old', state: 'weird', limited: true, limitedUntil: 5, billing: 'apiKey' },
    { id: 'work' },
    { id: 'bad id!' },
    null,
    { label: 'no id' },
  ])!;
  assert.deepEqual(
    rows.map((r) => [r.id, r.label, r.state, r.limited, r.billing, r.active]),
    [
      ['work', 'Work', 'ok', false, 'subscription', true],
      ['old', 'old', 'signedOut', true, 'apiKey', false],
    ],
  );
  assert.deepEqual(rows[0].usage, [{ label: '5h', usedPercent: 40, resetsAt: 9 }]);
  assert.equal(rows[1].limitedUntil, 5);
  assert.equal('usage' in rows[1], false);
  assert.equal(loginsOf('x'), undefined);
});

test('a harness record keeps its login fields only when the Host sent sound ones; an older Host’s record is unchanged', () => {
  const old = { id: 'claude', detected: true, signedIn: true, reason: 'x' };
  assert.deepEqual(normalizeHarness(old), old);
  const sent = normalizeHarness({ ...old, logins: [{ id: 'a' }], sources: { own: true, key: 'yes' }, using: 'key', loginsSupported: true });
  assert.deepEqual(
    [sent.sources, sent.using, sent.loginsSupported, sent.logins.length],
    [{ own: true, key: false, org: false }, 'key', true, 1],
  );
  const junk = normalizeHarness({ ...old, sources: 'all', using: 'cloud', loginsSupported: 'yes' });
  assert.deepEqual(junk, old);
});

test('without a list an agent has the one login its signed-in flag stands for, and none when it is not installed', () => {
  assert.deepEqual(
    effectiveLogins({ detected: true, signedIn: true }).map((l: any) => [l.id, l.state]),
    [['default', 'ok']],
  );
  assert.equal(effectiveLogins({ detected: true, signedIn: false })[0].state, 'signedOut');
  assert.deepEqual(effectiveLogins({ detected: false, signedIn: false }), []);
  assert.deepEqual(effectiveLogins({ detected: true, signedIn: false, logins: [] }), []);
  assert.ok(Object.values(REFUSALS).every((m) => /\.$/.test(m)));
});

test('a machine’s record keeps the logins, sources and choice its Host reported, and an older Host’s record stays as it was', async (t) => {
  const sent = {
    capabilities: { iab: false, cu: false, bu: false, shell: true },
    harnesses: [
      {
        id: 'claude',
        detected: true,
        signedIn: true,
        sources: { own: true, key: true, org: false },
        using: 'own',
        logins: [{ id: 'work', label: 'Work', state: 'ok' }, { id: '!!' }],
      },
      { id: 'codex', detected: true, signedIn: true },
    ],
  };
  installFakeClock(t, 1_000_000);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const registry = createRegistry({ file: path.join(d, 'hosts.json'), status: async () => sent, report: () => undefined });
  t.after(() => registry.dispose());
  registry.add({ id: 'h1', name: 'Build box', address: 'me@build.example' });
  await registry.check();
  const [claude, codex] = registry.list()[0].harnesses;
  assert.deepEqual(
    [claude.using, claude.sources, claude.logins.map((l: any) => l.id)],
    ['own', { own: true, key: true, org: false }, ['work']],
  );
  assert.deepEqual(codex, { id: 'codex', detected: true, signedIn: true });
});
