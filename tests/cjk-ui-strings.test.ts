import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { treeFiles } from '../scripts/source-tree.mjs';
import { stripComments } from './support/source-strings.ts';

export const GUARDS = ['electron/', 'shared/', 'src/'];

const CJK = /[　-〿぀-ヿ一-鿿＀-￯]/;
const ROOTS = ['src', 'electron', 'shared'];
// Not UI: intent detection over what users and apps write. policy.cjs matches Chinese action words in the app
// a chat is about to click; sessionMentions.mjs matches Chinese request words ("ask", "tell") before a chat mention;
// userWords.cjs matches the Chinese words with which a user picks a harness ("use", "switch to").
const ALLOW = new Set(['electron/capabilities/contract/policy.cjs', 'shared/sessionMentions.mjs', 'electron/session/userWords.cjs']);
const EXT = /\.(ts|tsx|js|cjs|mjs)$/;

function cjkStrings(file: string, text: string): string[] {
  return stripComments(text)
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => CJK.test(line) && !/\bzh\s*:/.test(line))
    .map(({ line, n }) => `${file}:${n}: ${line.trim().slice(0, 80)}`);
}

test('no CJK characters in user-visible source strings', () => {
  const hits = ROOTS.flatMap((r) => treeFiles(r, EXT))
    .filter((f) => !ALLOW.has(f))
    .flatMap((f) => cjkStrings(f, fs.readFileSync(f, 'utf8')));
  assert.deepEqual(hits, []);
});

test('the scanner flags strings and JSX text but not comments or zh fields', () => {
  assert.equal(cjkStrings('a.ts', 'const a = "你好"; // 注释').length, 1);
  assert.equal(cjkStrings('a.ts', 'const a = "ok"; // 注释\n/* 注释 */').length, 0);
  assert.equal(cjkStrings('a.tsx', 'const a = <b>你好</b>;').length, 1);
  assert.equal(cjkStrings('a.ts', 'const a = { zh: "你好" };').length, 0);
});
