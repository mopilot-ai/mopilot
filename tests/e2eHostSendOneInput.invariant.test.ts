// An E2E spec counts a Host chat's message as one input by its key, not as one request: a lost reply resends it under the same key (#3256).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { treeFiles } from '../scripts/source-tree.mjs';

export const GUARDS = ['tests/e2e/'];

/** A count of the fake Host's chat.send or chat.start requests held to an exact number, on one line or wrapped. */
const EXACT_SENDS = /calls\(\)\.filter\([^;]*?['"]chat\.(?:send|start)['"][^;]*?\)(?:\s*,?\s*\)\.toHaveLength\(|\.length\)\s*\.toBe\()/g;

/**
 * The lines of `source` that hold the requests for a Host chat's message to an exact count. The outbox sends a message
 * again under its key when the reply did not come back (the connection dropped as the Host took it), and the Host
 * replays the first answer, so a correct app can make two requests for one input; count distinct keys instead.
 */
export function exactSendCounts(source: string): number[] {
  return [...source.matchAll(EXACT_SENDS)].map((m) => source.slice(0, m.index).split('\n').length);
}

test('the check finds an exact count of chat.send or chat.start requests and passes a count of keys', () => {
  const exact = [
    'const x = 1;',
    "expect(calls().filter((c) => c.method === 'chat.send' && c.params.text === 'hi')).toHaveLength(1);",
    'expect(calls().filter((c) => c.method === "chat.start")).toHaveLength(2);',
    "expect(calls().filter((c) => c.method === 'chat.send').length).toBe(1);",
    // wrapped by the formatter: reported at the line the count starts on
    'expect(',
    "  calls().filter((c) => c.method === 'chat.send' && c.params.text === 'a long message that makes the line wrap'),",
    ').toHaveLength(1);',
  ];
  assert.deepEqual(exactSendCounts(exact.join('\n')), [2, 3, 4, 6]);
  const keyed = [
    "const sends = calls().filter((c) => c.method === 'chat.send');",
    'expect(new Set(sends.map((c) => c.params.key)).size).toBe(1);',
    // a request the app never sends again is not a message to the chat
    "expect(calls().filter((c) => c.method === 'chat.prepareContinue')).toHaveLength(1);",
  ];
  assert.deepEqual(exactSendCounts(keyed.join('\n')), []);
});

test('no E2E spec holds a Host chat message to an exact number of requests', () => {
  const hits = treeFiles('tests/e2e', /\.spec\.ts$/).flatMap((f: string) =>
    exactSendCounts(fs.readFileSync(f, 'utf8')).map((line) => `${f}:${line}`),
  );
  assert.deepEqual(hits, []);
});
