// scripts/raw-coverage.mjs: raw V8 coverage packed by a CI test shard and unpacked by the job that merges every shard's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tempDir } from './support/scripts-shared-cli.ts';

const { ownScripts, packRaw, unpackRaw } = await import('../scripts/raw-coverage.mjs');

const LINUX = '/home/runner/work/release/release';
const MAC = '/Users/runner/work/release/release';
const url = (root: string, file: string) => `${pathToFileURL(root).href}/${file}`;

test("a shard keeps only the repository's own scripts, and their source maps without the source text", () => {
  const map = { version: 3, sources: [`${LINUX}/src/a.tsx`], mappings: 'AAAA', names: ['secretName'], sourcesContent: ['code'] };
  const data = {
    timestamp: 7,
    result: [
      { url: url(LINUX, 'src/a.tsx'), functions: [1] },
      { url: url(LINUX, 'web/node_modules/react/index.js'), functions: [] },
      { url: url(`${LINUX}-other`, 'src/b.ts'), functions: [] },
      { url: 'node:fs', functions: [] },
      { url: url(LINUX, 'src/plain.ts'), functions: [] },
    ],
    'source-map-cache': {
      [url(LINUX, 'src/a.tsx')]: { lineLengths: [3], data: map },
      [url(LINUX, 'src/plain.ts')]: { lineLengths: [1], data: null },
      [url(LINUX, 'web/node_modules/react/index.js')]: { lineLengths: [1], data: map },
    },
  };
  assert.deepEqual(ownScripts(data, LINUX), {
    timestamp: 7,
    result: [
      { url: url(LINUX, 'src/a.tsx'), functions: [1] },
      { url: url(LINUX, 'src/plain.ts'), functions: [] },
    ],
    'source-map-cache': {
      [url(LINUX, 'src/a.tsx')]: { lineLengths: [3], data: { version: 3, sources: [`${LINUX}/src/a.tsx`], mappings: 'AAAA' } },
      [url(LINUX, 'src/plain.ts')]: { lineLengths: [1], data: null },
    },
  });
  // a process that loaded no source map has no cache to trim
  assert.deepEqual(ownScripts({ result: [{ url: 'node:fs' }, { url: url(LINUX, 'src/c.js') }] }, `${LINUX}/`), {
    result: [{ url: url(LINUX, 'src/c.js') }],
  });
});

test('coverage packed on one runner is unpacked under another checkout path, with no file overwriting another', () => {
  const dir = tempDir('raw-coverage-');
  const raw = path.join(dir, 'raw');
  mkdirSync(raw);
  const entry = (root: string) => ({
    result: [{ url: url(root, 'src/a.tsx'), functions: [] }],
    'source-map-cache': {
      [url(root, 'src/a.tsx')]: { lineLengths: [1], data: { version: 3, sources: [`${root}/src/a.tsx`], mappings: '' } },
    },
  });
  writeFileSync(path.join(raw, 'coverage-1-2-0.json'), JSON.stringify(entry(MAC)));
  writeFileSync(path.join(raw, 'notes.txt'), 'not coverage');
  const packed = path.join(dir, 'packed');
  // two shards whose processes happened to get the same pid and time
  assert.equal(packRaw(raw, packed, MAC), 1);
  assert.equal(packRaw(raw, packed, MAC), 1);
  const names = readdirSync(packed);
  assert.equal(names.length, 2);
  assert.ok(names.every((name) => name.endsWith('-coverage-1-2-0.json')));
  const text = readFileSync(path.join(packed, names[0]), 'utf8');
  assert.equal(text.includes(MAC), false);
  assert.deepEqual(JSON.parse(text).result, [{ url: '@REPO_URL@/src/a.tsx', functions: [] }]);
  writeFileSync(path.join(packed, 'notes.txt'), 'not coverage');
  const temp = path.join(dir, 'coverage/unit/tmp');
  assert.equal(unpackRaw(packed, temp, LINUX), 2);
  assert.deepEqual(readdirSync(temp).sort(), names.map((name) => `coverage-${name}`).sort());
  assert.deepEqual(JSON.parse(readFileSync(path.join(temp, `coverage-${names[0]}`), 'utf8')), entry(LINUX));
});

test('the merge refuses two compilations of one file, which c8 cannot merge into real functions', () => {
  const dir = tempDir('raw-coverage-compiled-');
  const packed = path.join(dir, 'packed');
  mkdirSync(packed);
  const entry = (lineLengths: number[], mappings = 'AAAA') =>
    JSON.stringify({
      result: [{ url: '@REPO_URL@/src/a.tsx', functions: [] }],
      'source-map-cache': { '@REPO_URL@/src/a.tsx': { lineLengths, data: { version: 3, sources: [], mappings } } },
    });
  writeFileSync(path.join(packed, 'a.json'), entry([10, 20]));
  writeFileSync(path.join(packed, 'b.json'), entry([10, 20]));
  // the same compilation in two processes merges, and a file without source maps has nothing to compare
  writeFileSync(path.join(packed, 'c.json'), JSON.stringify({ result: [{ url: '@REPO_URL@/src/b.ts', functions: [] }] }));
  assert.equal(unpackRaw(packed, path.join(dir, 'ok'), LINUX), 3);
  // rolldown in one shard, esbuild in another; or code whose lines happen to keep their lengths but not their columns
  const refused = /^Error: src\/a\.tsx was compiled differently in two test processes; their coverage cannot be merged\.$/;
  writeFileSync(path.join(packed, 'd.json'), entry([10, 21]));
  assert.throws(() => unpackRaw(packed, path.join(dir, 'bad'), LINUX), refused);
  writeFileSync(path.join(packed, 'd.json'), entry([10, 20], 'AACA'));
  assert.throws(() => unpackRaw(packed, path.join(dir, 'bad'), LINUX), refused);
});
