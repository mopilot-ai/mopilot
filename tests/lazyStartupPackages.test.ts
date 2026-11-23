// Packages main's startup does not load (docs/architecture/rust-core.md §2, startup's cheap wins): legacyOffice.cjs loads
// cfb and word-extractor with the first .doc or .ppt, routeReader.cjs js-yaml with the first YAML route file, and
// passkeyRequest.cjs tldts with the first passkey request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PACKAGES = /[\\/]node_modules[\\/](cfb|word-extractor|js-yaml|tldts)[\\/]/;

/** Those packages a fresh Node has loaded after requiring `file` (as `o`) and running `then`. */
function loadedAfter(file: string, then = '') {
  // the file comes as an argument: a templated require() would read to the related-test scan as one of every file
  const script = `const o = require(require('node:path').resolve(process.argv[1])); ${then}; console.log(JSON.stringify(Object.keys(require.cache).filter((k) => ${PACKAGES}.test(k)).map((k) => k.match(${PACKAGES})[1])));`;
  const r = spawnSync(process.execPath, ['-e', script, file], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return [...new Set(JSON.parse(r.stdout.trim().split('\n').at(-1)!))].sort();
}

test('requiring legacyOffice.cjs loads neither reader; reading a .ppt loads cfb', () => {
  assert.deepEqual(loadedAfter('electron/platform/legacyOffice.cjs'), []);
  assert.deepEqual(
    loadedAfter('electron/platform/legacyOffice.cjs', "try { o.powerPointText(Buffer.from('not a compound file')) } catch {}"),
    ['cfb'],
  );
});

test('requiring routeReader.cjs loads no YAML parser, and requiring passkeyRequest.cjs no domain list', () => {
  assert.deepEqual(loadedAfter('electron/harness/routeReader.cjs'), []);
  assert.deepEqual(loadedAfter('electron/capabilities/browser/passkeyRequest.cjs'), []);
});
