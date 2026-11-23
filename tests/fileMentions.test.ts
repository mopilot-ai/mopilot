// src/lib/fileMentions.ts: which `@word` in prompt text names a file, by Claude Desktop's rules — at a word start, trailing
// punctuation (CJK too) trimmed, an extension required, a bare name only with a known type, never inside a markdown link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileMentions, fileMentionPath } from '../src/lib/fileMentions.ts';

const paths = (text: string) => fileMentions(text).map((m) => m.path);

test('the @ menu pick in a Chinese sentence: the whole name, its span and token, the sentence after it left out', () => {
  const text = '@Design1_MenggeWang.pdf 看看这个';
  assert.deepEqual(fileMentions(text), [{ start: 0, end: 23, token: '@Design1_MenggeWang.pdf', path: 'Design1_MenggeWang.pdf' }]);
  assert.equal(text.slice(0, 23), '@Design1_MenggeWang.pdf');
});

test('paths with folders, dotfiles, folders the menu inserts and Windows separators are mentions', () => {
  assert.deepEqual(paths('see @src/a.ts and @.env and @docs/ and @src\\b.tsx'), ['src/a.ts', '.env', 'docs/', 'src\\b.tsx']);
  // a line location stays on the path, for the opener to read
  assert.deepEqual(paths('@src/a.ts:12'), ['src/a.ts:12']);
});

test('punctuation that ends the sentence is trimmed, an unopened ) too, an opened one kept', () => {
  assert.deepEqual(paths('看 @notes.md。还有 @a/b.ts，@c.json!'), ['notes.md', 'a/b.ts', 'c.json']);
  assert.deepEqual(paths('(read @src/a.ts)'), ['src/a.ts']);
  assert.deepEqual(paths('(read @src/a.ts).'), ['src/a.ts']);
  assert.deepEqual(paths('@src/f(1).ts'), ['src/f(1).ts']);
});

test('names, mail, versions, URLs and words inside a word are not files', () => {
  for (const text of [
    'ask @john.doe',
    'mail me@example.com',
    '@v1.2 is out',
    '@3.5',
    '@someone',
    '@',
    '@/',
    'x@a.ts',
    '@https://x.test/a.pdf',
    '`@a.ts`',
    '@README',
  ])
    assert.deepEqual(paths(text), [], text);
});

test('known types make a bare name a file: documents, media, code and plain text', () => {
  assert.deepEqual(paths('@a.pdf @b.png @c.ts @d.md @e.txt @f.docx @g.mp4 @h.csv'), [
    'a.pdf',
    'b.png',
    'c.ts',
    'd.md',
    'e.txt',
    'f.docx',
    'g.mp4',
    'h.csv',
  ]);
});

test('an @ inside a markdown link (a tab or chat token, a pasted link) belongs to the link', () => {
  assert.deepEqual(paths('[see @a.ts](mopilot-tab://app?tabId=1) then @b.ts'), ['b.ts']);
  assert.deepEqual(paths('[t](x) @c.ts'), ['c.ts']);
});

test('a path past 1024 characters is not one, and a text stops at 256 mentions', () => {
  assert.equal(fileMentionPath(`a/${'x'.repeat(1030)}.ts`), false);
  assert.equal(fileMentions(Array.from({ length: 300 }, (_, i) => `@f${i}.ts`).join(' ')).length, 256);
  assert.deepEqual(fileMentions('no at sign'), []);
});
