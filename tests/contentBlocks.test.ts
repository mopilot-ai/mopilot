// Message block boundaries preserve valid records and their original transcript indices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentBlocks, contentBlockEntries } from '../shared/contentBlocks.mjs';

test('record blocks retain their objects, order and original positions', () => {
  const text = { type: 'text', text: 'Kept' };
  const tool = { type: 'tool_result', content: 'Done' };
  const content = [null, 42, [], false, 'text', text, tool];
  assert.deepEqual(contentBlocks(content), [text, tool]);
  assert.deepEqual(contentBlockEntries(content), [
    [5, text],
    [6, tool],
  ]);
  assert.equal(contentBlocks(content)[0], text);
  assert.equal(content.length, 7);
});

test('a non-array container and empty content have no record blocks', () => {
  for (const content of [undefined, null, '', 42, false, {}, { type: 'text' }, []]) {
    assert.deepEqual(contentBlocks(content), []);
    assert.deepEqual(contentBlockEntries(content), []);
  }
});

test('text and thinking fields reject non-string values without dropping valid neighbors', () => {
  for (const [type, field] of [
    ['text', 'text'],
    ['thinking', 'thinking'],
    ['redacted_thinking', 'thinking'],
  ]) {
    const kept = { type, [field]: 'Kept' };
    for (const value of [42, false, [], {}, ['looks like text']]) {
      const bad = { type, [field]: value };
      assert.deepEqual(contentBlocks([bad, kept]), [kept]);
      assert.deepEqual(contentBlockEntries([bad, kept]), [[1, kept]]);
    }
  }
});

test('absent text fields keep their empty-text meaning without mutating the source', () => {
  for (const [type, field] of [
    ['text', 'text'],
    ['thinking', 'thinking'],
    ['redacted_thinking', 'thinking'],
  ]) {
    for (const block of [{ type }, { type, [field]: null }]) {
      assert.deepEqual(contentBlocks([block]), [{ ...block, [field]: '' }]);
      assert.notEqual(contentBlocks([block])[0], block);
      assert.notEqual(block[field], '');
    }
  }
});
