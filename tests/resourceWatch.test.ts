// watchResources blames a left-running resource on the code under a root only when that code created it (#5223).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { watchResources } from './support/resourceWatch.ts';

const require = createRequire(import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-watch-'));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
const file = path.join(root, 'wiring.cjs');
fs.writeFileSync(
  file,
  `module.exports = {
  deferred: () => setImmediate(() => {}),
  repeating: () => setInterval(() => {}, 1e6).unref(),
};\n`,
);
const wiring = require(file);

test('an Immediate or a timer the code under the root starts is named with its type and file', () => {
  const watch = watchResources([root]);
  void Promise.resolve();
  wiring.deferred();
  wiring.repeating();
  const { opened } = watch.stop();
  assert.equal(opened.length, 2, opened.join());
  assert.match(opened[0], /^Immediate at .*wiring\.cjs/);
  assert.match(opened[1], /^Timeout at .*wiring\.cjs/);
});

test('an Immediate started by anyone else in the same turn is not blamed on the code under the root', () => {
  const watch = watchResources([root]);
  const other = setImmediate(() => {});
  const { opened, ambient } = watch.stop();
  assert.deepEqual(opened, []);
  assert.match(ambient.join(), /^Immediate at node or the test runner/);
  clearImmediate(other);
});
