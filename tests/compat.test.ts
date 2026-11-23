// The version policy the harness pages apply (src/harness/compat.ts) and its generated data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { defined } from './support/defined.ts';

const require = createRequire(import.meta.url);
const main = require('../electron/harness/versions.cjs');
const { compareVersions, compatStatus, versionWarning, MATRIX } = await import('../src/harness/compat.ts');
const { REGISTRY } = await import('../src/harness/registry.ts');
const { SEMANTICS } = await import('../src/harness/adapter.ts');

test("the window's version compare agrees with main's", () => {
  const vs = ['0.162.0-alpha.17.2', '0.162.0-alpha.9', '0.162.0', '0.163.0', '2.1.295', 'v2.2.0', '2.1.300', '1.0.0-rc.1', '1.0.0'];
  for (const a of vs) for (const b of vs) assert.equal(compareVersions(a, b), main.compareVersions(a, b), `${a} vs ${b}`);
});

test('tested, unverified, too old and known bad', () => {
  const v = { min: '2.1.295', knownBad: ['2.1.400'], tested: ['2.1.295'] };
  assert.equal(compatStatus(v, '2.1.295'), 'tested');
  assert.equal(compatStatus(v, '2.1.350'), 'unverified');
  assert.equal(compatStatus(v, '2.1.100'), 'tooOld');
  assert.equal(compatStatus(v, '2.1.400'), 'knownBad');
  // equal as versions, as main has it
  assert.equal(compatStatus(v, 'v2.1.295'), 'tested');
  assert.equal(compatStatus(v, 'v2.1.400'), 'knownBad');
  // the same answer as main's table for the installed registry
  for (const kind of ['codex', 'claude']) {
    for (const ver of [REGISTRY[kind].versions.min, '99.0.0', '0.0.1']) {
      const s = compatStatus(REGISTRY[kind].versions, ver);
      assert.equal(s === 'tested' ? 'ok' : s, main.versionStatus(kind, ver));
    }
  }
});

test('the matrix lists every semantic, and a missing feature carries its reason', () => {
  assert.deepEqual(
    MATRIX.semantics.map((r: any) => r.semantic),
    [...SEMANTICS],
  );
  const row = (s: string) => MATRIX.semantics.find((r: any) => r.semantic === s);
  assert.deepEqual([defined(row('workflows')).codex.via, defined(row('workflows')).codex.why], ['none', "Codex doesn't support workflows"]);
  assert.deepEqual([defined(row('workflows')).claude.via, defined(row('workflows')).claude.source], ['passthrough', 'Claude Code']);
  assert.equal(defined(row('computerUse')).codex.source, 'MoPilot');
});

test('the page header warns only about a version that is too old or known to break, never about an untested one', () => {
  const v = { min: '1.0.0', knownBad: ['1.2.0'], tested: ['1.1.0'] };
  assert.equal(versionWarning(v, '1.1.0'), null);
  assert.equal(versionWarning(v, '1.5.0'), null);
  assert.equal(versionWarning(v, '0.9.0'), 'Version 0.9.0 is too old for MoPilot.');
  assert.equal(versionWarning(v, '1.2.0'), 'Version 1.2.0 has a known problem with MoPilot.');
  assert.equal(versionWarning(null, '1.1.0'), null);
  assert.equal(versionWarning(v, null), null);
});

test('the generated contract runs', () => {
  // the generated matrix carries the contract runs, an empty list until the VM has run one
  assert.ok(Array.isArray(MATRIX.contracts));
});
