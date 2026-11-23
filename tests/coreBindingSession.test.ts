// The session routes through the built addon (core/crates/session): a store opens, a patch answers with its revision,
// changed keys and implied values or null, and a closed store refuses patches. scripts/rust-coverage.mjs runs this file
// against an instrumented build, so the routes are measured where JS calls them. Skipped without a built core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { corePath, loadCore, coreSyncCall } = require('../electron/platform/core.cjs');

const addon = loadCore(corePath());
const required = process.env.MOPILOT_CORE_REQUIRED === '1';

test('a session store opens, patches and closes through the addon', { skip: !addon && !required && 'no Rust core built' }, () => {
  const id = 7_000_001;
  const empty = { rev: 0, turn: 'idle', progressAt: null, runningElsewhere: false, plan: false };
  assert.equal(coreSyncCall(addon, 'session.open', { id, empty, client: ['plan'] }), null);
  assert.deepEqual(coreSyncCall(addon, 'session.patch', { id, chat: 'c', partial: { turn: 'running' }, now: 5 }), {
    rev: 1,
    keys: ['turn'],
    implied: {},
  });
  assert.equal(coreSyncCall(addon, 'session.patch', { id, chat: 'c', partial: { turn: 'running' }, now: 5 }), null);
  assert.equal(coreSyncCall(addon, 'session.close', id), null);
  // a closed store: the core refuses, and the call throws why (no JS takes over)
  assert.throws(() => coreSyncCall(addon, 'session.patch', { id, chat: 'c', partial: {}, now: 5 }), /no session store 7000001/);
});
