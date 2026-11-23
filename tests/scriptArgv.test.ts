// scripts/argv.mjs flagValue: the `--name value` reader of the build, package and release scripts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flagValue } from '../scripts/argv.mjs';

test('the argument after the flag, by bare or dashed name; the default only when the flag is absent', () => {
  const argv = ['--arch', 'x64', '--out', '/tmp/o', '--debug'];
  assert.equal(flagValue(argv, 'arch'), 'x64');
  assert.equal(flagValue(argv, '--out'), '/tmp/o');
  assert.equal(flagValue(argv, 'channel', 'stable'), 'stable');
  assert.equal(flagValue(argv, 'channel'), undefined);
  // a flag at the end has no value: nothing after it, whatever the default
  assert.equal(flagValue(argv, 'debug', 'x'), undefined);
});
