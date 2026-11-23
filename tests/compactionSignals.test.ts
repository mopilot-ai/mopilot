// Compaction notification boundaries reject malformed data and preserve opaque native identities.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, codex } from './support/controller/fixture';
const require = createRequire(import.meta.url);
const { codexCompaction, claudeCompaction } = require('../electron/harness/compactionSignals.cjs');
const { observeCompaction } = require('../electron/session/compactionQueue.cjs');
test('protocol decoding fails closed without coercing opaque identity or assuming absent status means success', () => {
  for (const msg of [
    null,
    {},
    { method: 'other' },
    { method: 'item/started', params: [] },
    { method: 'item/started', params: { threadId: 1 } },
    { method: 'item/started', params: { threadId: 't', turnId: 1 } },
    { method: 'item/started', params: { threadId: 't', turnId: 'x', item: [] } },
    { method: 'item/started', params: { threadId: 't', turnId: 'x', item: { type: 'other', id: 'y' } } },
    { method: 'item/started', params: { threadId: 't', turnId: 'x', item: { type: 'contextCompaction', id: 1 } } },
  ])
    assert.equal(codexCompaction(msg), null);
  const opaque = '900719925474099300000/"\\';
  assert.equal(
    codexCompaction(codex('item/started', { threadId: opaque, turnId: opaque, item: { type: 'contextCompaction', id: opaque } })).id,
    opaque,
  );
  for (const e of [
    null,
    {},
    { kind: 'message', key: 1 },
    { kind: 'message', key: 'k', msg: [] },
    { kind: 'message', key: 'k', msg: { type: 'assistant' } },
    { kind: 'message', key: 'k', msg: { type: 'conversation_reset', session_id: 's', new_conversation_id: 1 } },
    { kind: 'message', key: 'k', msg: { type: 'system', session_id: 1 } },
    { kind: 'message', key: 'k', msg: { type: 'system', session_id: 's', subtype: 'other' } },
    { kind: 'message', key: 'k', msg: { type: 'system', session_id: 's', subtype: 'status', permissionMode: 'plan' } },
  ])
    assert.equal(claudeCompaction(e), null);
  const { c } = setup();
  observeCompaction(c, null);
});
