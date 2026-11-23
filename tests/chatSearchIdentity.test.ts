// Canonical search/mention identity: real rows preserve discovery; retained metadata cannot invent one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canSelectChatSearch, chatSearchOwners, mergeChatSearch } from '../src/lib/chatSearch.ts';
const row = (id: string, title = id, extra = {}) => ({ id, title, updatedAt: 1, ...extra });
const canonical = row('root', 'Canonical discussion');
const alias = row('claude:later', 'needle in later title');
const other = row('other', 'needle unrelated');
const segments = { root: [{ nativeId: 'root' }, { nativeId: alias.id }] };
const base = { local: [], titleOf: (t: ReturnType<typeof row>) => t.title, term: 'needle', limit: 20 };

test('orphan alias from retained metadata is omitted for every local and remote harness source', () => {
  for (const source of ['local', 'codex', 'claude', 'sage']) {
    const result = mergeChatSearch({ ...base, segments, [source]: [alias, other] });
    assert.deepEqual(
      result.map((t) => t.id),
      ['other'],
    );
  }
});
test('alias title and body matches resolve to actual known canonical row without requiring canonical title match', () => {
  for (const source of ['local', 'codex', 'claude', 'sage']) {
    const result = mergeChatSearch({ ...base, segments, knownChats: { root: canonical }, [source]: [alias] });
    assert.deepEqual(result, [canonical]);
  }
  assert.deepEqual(mergeChatSearch({ ...base, segments, knownChats: { root: canonical }, claude: [row(alias.id, 'body-only match')] }), [
    canonical,
  ]);
});
test('independent remote canonical hit supplies real row even when only alias matches locally', () => {
  const result = mergeChatSearch({ ...base, segments, local: [alias], codex: [canonical], claude: [alias] });
  assert.deepEqual(result, [canonical]);
  assert.equal(canSelectChatSearch('root', { segments }, [canonical, alias]), true);
});
test('canonical restrictions apply after mapping, and excluded active chat does not consume result limit', () => {
  for (const extra of [{ ephemeral: true }, { parentThreadId: 'parent' }]) {
    assert.deepEqual(mergeChatSearch({ ...base, segments, knownChats: { root: row('root', 'x', extra) }, claude: [alias] }), []);
  }
  for (const restriction of [{ archived: { root: 1 } }, { excluded: (id: string) => id === 'root' }]) {
    const result = mergeChatSearch({
      ...base,
      segments,
      knownChats: { root: canonical },
      claude: [alias, other],
      limit: 1,
      ...restriction,
    });
    assert.deepEqual(result, [other]);
  }
});
test('canonical deduplication happens before cap and preserves independent local matches', () => {
  const result = mergeChatSearch({
    ...base,
    segments,
    knownChats: { root: canonical },
    local: [other],
    codex: [alias, canonical],
    claude: [alias],
    limit: 2,
  });
  assert.equal(result.length, 2);
  assert.ok(result.includes(canonical));
  assert.ok(result.includes(other));
});
test('ambiguous alias ownership never selects arbitrary owner or hides either ordinary canonical row', () => {
  const competing = { ...segments, second: [{ nativeId: 'second' }, { nativeId: alias.id }] };
  const second = row('second', 'needle second');
  assert.equal(chatSearchOwners(competing).get(alias.id), null);
  const result = mergeChatSearch({ ...base, segments: competing, local: [row('root', 'needle root'), second], claude: [alias] });
  assert.deepEqual(
    result.map((t) => t.id),
    ['root', 'second'],
  );
  assert.equal(canSelectChatSearch(alias.id, { segments: competing }, [alias]), false);
});
test('repeated same-owner alias claims stay canonical and first own native is never hidden', () => {
  const repeated = { root: [...segments.root, { nativeId: alias.id }] };
  assert.equal(chatSearchOwners(repeated).has('root'), false);
  assert.equal(chatSearchOwners(repeated).get(alias.id), 'root');
  assert.deepEqual(mergeChatSearch({ ...base, segments: repeated, knownChats: { root: canonical }, claude: [alias] }), [canonical]);
});
test('selection requires latest owner and actual canonical row, and honors latest visibility', () => {
  assert.equal(canSelectChatSearch(alias.id, { segments }, [alias]), false);
  assert.equal(canSelectChatSearch('root', { segments }, [alias]), false);
  assert.equal(canSelectChatSearch('root', { segments, knownChats: { root: canonical } }, [alias]), true);
  assert.equal(canSelectChatSearch('root', { segments, knownChats: { root: canonical }, archived: { root: 1 } }, [alias]), false);
  assert.equal(canSelectChatSearch('root', { segments, knownChats: { root: canonical }, excluded: (id) => id === 'root' }, [alias]), false);
  assert.equal(canSelectChatSearch('other', {}, [other]), true);
  assert.equal(canSelectChatSearch('other', {}, []), false);
});
test('overlapping alias chains and cycles never produce an intermediate selectable chat', () => {
  for (const segments of [
    { root: [{ nativeId: 'root' }, { nativeId: 'middle' }], middle: [{ nativeId: 'middle' }, { nativeId: 'leaf' }] },
    { root: [{ nativeId: 'root' }, { nativeId: 'middle' }], middle: [{ nativeId: 'middle' }, { nativeId: 'root' }] },
  ]) {
    const knownChats = { root: canonical, middle: row('middle') };
    const result = mergeChatSearch({ ...base, segments, knownChats, claude: [row('leaf'), row('middle'), other] });
    // A leaf absent from the cyclic metadata is an ordinary native row, not a claimed alias.
    assert.equal(
      result.some((t) => t.id === 'middle'),
      false,
    );
    assert.ok(result.includes(other));
  }
});
