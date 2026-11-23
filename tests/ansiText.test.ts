// shared/ansiText.mjs: a CLI's output read without its colors, cursor moves and OSC titles or links.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripAnsi } from '../shared/ansiText.mjs';

test('stripAnsi drops color and cursor escapes and OSC sequences, and keeps the text', () => {
  assert.equal(stripAnsi('\u001b[1;32mready\u001b[0m in \u001b[2K42 ms'), 'ready in 42 ms');
  // an OSC title ended by BEL, and a link ended by ST: the link's text stays (a greedy match took it with the escapes)
  assert.equal(stripAnsi('\u001b]0;title\u0007\u001b]8;;http://x\u001b\\link\u001b]8;;\u001b\\'), 'link');
  assert.equal(
    stripAnsi('Local: \u001b]8;;http://localhost:5173/\u001b\\http://localhost:5173/\u001b]8;;\u001b\\'),
    'Local: http://localhost:5173/',
  );
  assert.equal(stripAnsi(42), '42');
});
