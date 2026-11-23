// Drafts belong to the account, computer and chat, and late sends cannot erase a newer edit.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { draftKey, writeDraft, clearAcceptedDraft } from '../mobile/src/presentation/drafts';
test('only the accepted draft is cleared, independently across owners', () => {
  const a = draftKey('account', 'computer', 'chat');
  const b = draftKey('account', 'computer2', 'chat');
  const c = draftKey('account2', 'computer', 'chat');
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  let drafts = writeDraft({}, a, 'first');
  drafts = writeDraft(drafts, b, 'other');
  drafts = writeDraft(drafts, a, 'edited while sending');
  assert.equal(clearAcceptedDraft(drafts, a, 'first'), drafts);
  drafts = clearAcceptedDraft(drafts, a, 'edited while sending');
  assert.equal(drafts[a], '');
  assert.equal(drafts[b], 'other');
});
