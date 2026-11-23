// scripts/core-check.mjs: rustfmt then clippy inside core/, stopping at the first that fails, and a clear word when
// cargo is not installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECKS, coreCheck } from '../scripts/core-check.mjs';
import { runScript } from './support/scripts-shared-cli.ts';

test('every check passes: rustfmt, then clippy, both in core/', () => {
  const calls: [string, string[], string][] = [];
  assert.equal(coreCheck({ run: (cmd, args, cwd) => (calls.push([cmd, args, cwd]), { status: 0 }), log: () => {}, cwd: '/r/core' }), 0);
  assert.deepEqual(
    calls,
    CHECKS.map(([args]) => ['cargo', args, '/r/core']),
  );
  assert.deepEqual(calls[0][1], ['fmt', '--check']);
});

test('a failing check stops the rest and says how to fix it', () => {
  const logs: string[] = [];
  let runs = 0;
  assert.equal(coreCheck({ run: () => (runs++, { status: 1 }), log: (m) => logs.push(m) }), 1);
  assert.equal(runs, 1);
  assert.match(logs[0], /cargo fmt --check` failed\. Format the core with `cargo fmt`/);
});

test('cargo that does not start is named, with how to install it', () => {
  const logs: string[] = [];
  assert.equal(coreCheck({ run: () => ({ status: null, error: new Error('spawn cargo ENOENT') }), log: (m) => logs.push(m) }), 1);
  assert.match(logs[0], /cargo did not start \(spawn cargo ENOENT\)\. Install the Rust toolchain with rustup/);
});

test('the command runs the real cargo, and says how to install it when there is none', () => {
  const run = runScript('scripts/core-check.mjs', [], { PATH: '/usr/bin:/bin' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /core-check: cargo did not start/);
});
