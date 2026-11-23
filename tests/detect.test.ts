import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { detectBin, resolveBasic } = require('../electron/harness/detect.cjs');

const has =
  (...paths: string[]) =>
  (p: string) =>
    paths.includes(p);

test('a manual path that exists wins over the login shell PATH', () => {
  const r = detectBin({ names: ['kimi'], manual: '/m/kimi', which: () => '/usr/bin/kimi', exists: has('/m/kimi') });
  assert.deepEqual(r, { path: '/m/kimi', source: 'manual' });
});

test('a manual path that is gone is ignored', () => {
  const r = detectBin({ names: ['kimi'], manual: '/m/kimi', which: () => '/usr/bin/kimi', exists: has() });
  assert.deepEqual(r, { path: '/usr/bin/kimi', source: 'path' });
});

test('the PATH is tried name by name, then the known folders', () => {
  assert.equal(detectBin({ names: ['a', 'b'], which: (n: string) => (n === 'b' ? '/x/b' : null) }).path, '/x/b');
  const r = detectBin({ names: ['kimi'], which: () => null, known: ['/h/.local/bin'], exists: has('/h/.local/bin/kimi') });
  assert.deepEqual(r, { path: '/h/.local/bin/kimi', source: 'known' });
  assert.equal(detectBin({ names: ['kimi'], which: () => null }), null);
});

test('resolveBasic: manual path, then SAGE_ACP_BINS, then the quirks file bins on PATH', () => {
  const which = (n: string) => `/usr/bin/${n}`;
  const env = { SAGE_ACP_BINS: '{"kimi":"/fake/kimi"}' };
  assert.equal(resolveBasic('kimi', { env, which, manual: '/m/kimi', exists: has('/m/kimi') }), '/m/kimi');
  assert.equal(resolveBasic('kimi', { env, which }), '/fake/kimi');
  // the override replaces the search: a harness it doesn't list is not found
  assert.equal(resolveBasic('goose', { env, which }), null);
  assert.equal(resolveBasic('dsh', { env: {}, which }), '/usr/bin/dsh');
});

test('resolveBasic: with no folders given, the user-tool folders every detector shares (an ACP harness under bun)', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-home-'));
  const saved = process.env.HOME;
  process.env.HOME = home;
  t.after(() => (process.env.HOME = saved));
  require('../electron/platform/userTools.cjs').forgetTool();
  const bin = path.join(home, '.bun', 'bin', 'kimi');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '');
  assert.equal(resolveBasic('kimi', { env: {}, which: () => null }), bin);
  // folders given replace the shared ones; nothing found anywhere is none
  assert.equal(resolveBasic('kimi', { env: {}, which: () => null, known: [path.dirname(bin)] }), bin);
  assert.equal(resolveBasic('kimi', { env: {}, which: () => null, known: [] }), null);
  assert.equal(resolveBasic('no-such-harness', { env: {}, which: () => '/x', known: [] }), null, 'no quirks: no names to look for');
});
