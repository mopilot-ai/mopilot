// Approval display origin is authoritative, sanitized, and independent of current selection or legacy chat-shaped params.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalHarness, publishApproval } from '../shared/approvalOrigin.mjs';

test('public source, native owner and host hint precede a current fallback', () => {
  for (const kind of ['codex', 'claude', 'acp:kimi'] as const) {
    assert.equal(approvalHarness({ sourceHarness: kind, source: { kind: 'claude' }, params: { harness: 'codex' } }, 'acp:gemini'), kind);
    assert.equal(approvalHarness({ source: { kind } }, 'acp:gemini'), kind);
    assert.equal(approvalHarness({ params: { harness: kind } }, 'acp:gemini'), kind);
  }
  assert.equal(approvalHarness({ source: { kind: 'acp', key: 'acp:opencode:opaque:id' } }), 'acp:opencode');
  assert.equal(approvalHarness(null, 'claude'), 'claude');
  assert.equal(approvalHarness(undefined), undefined);
  assert.equal(approvalHarness({ params: null }), undefined);
});

test('an explicit unidentified source never silently becomes the current harness', () => {
  for (const bad of [null, '', 42, 'unknown', 'acp:']) {
    assert.equal(approvalHarness({ sourceHarness: bad }, 'codex'), null);
    assert.equal(approvalHarness({ params: { harness: bad } }, 'codex'), null);
  }
  assert.equal(approvalHarness({ source: { kind: 'unknown', key: 'opaque' } }, 'codex'), null);
  assert.equal(approvalHarness({ source: { kind: 'unknown' }, params: { harness: 'claude' } }), 'claude');
});

test('publication retains answer ownership privately and emits only a display kind', () => {
  const source = { kind: 'acp', key: 'acp:kimi:native', privateRouting: { token: 'fixture' } };
  const params = { toolCall: { title: 'Act' } };
  const result = publishApproval({ id: 'a', method: 'acp/permission', source, params });
  assert.equal(result.source, source);
  assert.deepEqual(result.approval, { id: 'a', method: 'acp/permission', params, sourceHarness: 'acp:kimi' });
  assert.equal(result.approval.params, params);
  assert.deepEqual(publishApproval({ id: 'legacy', params: {} }).approval, { id: 'legacy', params: {} });
});
