// A test that loads modules through a require bound to another folder by createRequire is selected for a change to them (#4354).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { referencesOf } from '../scripts/related-tests.mjs';

function repo(t: { after: (fn: () => void) => void }) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'related-create-require-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const file of [
    'mobile/package.json',
    'mobile/app.config.js',
    'mobile/config/ids.js',
    'mobile/plugins/x.js',
    'tests/app.config.js',
  ]) {
    mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(dir, file), '');
  }
  return dir;
}

test("a require bound to mobile/package.json resolves its specifiers from mobile/, not from the test's folder", (t) => {
  const dir = repo(t);
  const text = [
    "const require = createRequire(new URL('../mobile/package.json', import.meta.url));",
    "const appConfig = require('./app.config.js');",
    "const { ids } = require('./config/ids.js');",
    "const where = require.resolve('./plugins/x.js');",
    "const xcode = require('xcode');",
  ].join('\n');
  const refs = referencesOf('tests/phone.test.ts', text, dir);
  for (const f of ['mobile/app.config.js', 'mobile/config/ids.js', 'mobile/plugins/x.js', 'mobile/package.json']) assert.ok(refs.has(f), f);
  // the plain specifier scan still reads it from the test's folder too: an extra edge only selects an extra test
  assert.equal(refs.has('tests/app.config.js'), true);
});

test('a require bound to a folder URL resolves from inside it; other names and member calls are not that require', (t) => {
  const dir = repo(t);
  const text = [
    "const mobile$ = createRequire(new URL('../mobile/', import.meta.url));",
    "mobile$('./app.config.js');",
    "other.mobile$('./config/ids.js');",
    "xmobile$('./plugins/x.js');",
  ].join('\n');
  const refs = referencesOf('tests/phone.test.ts', text, dir);
  assert.equal(refs.has('mobile/app.config.js'), true);
  assert.equal(refs.has('mobile/config/ids.js'), false);
  assert.equal(refs.has('mobile/plugins/x.js'), false);
});

test('a cache-busting query on the bound URL is ignored, and a missing module is not a reference', (t) => {
  const dir = repo(t);
  const text = "const r = createRequire(new URL('../mobile/package.json?v=1', import.meta.url));\nr('./app.config.js');\nr('./gone.js');";
  const refs = referencesOf('tests/phone.test.ts', text, dir);
  assert.equal(refs.has('mobile/app.config.js'), true);
  assert.equal(
    [...refs].some((f) => f.includes('gone')),
    false,
  );
});
