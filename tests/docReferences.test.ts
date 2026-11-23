// Markdown reference discovery: relative link targets outside code, `npm run` names with their package, owning manifests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownLinks, npmRunScripts, owningManifest, pathExists, withoutCode, withoutLineCode } from '../scripts/doc-references.mjs';

test('links resolve against their file, keep URLs and anchors unresolved, and ignore code', () => {
  const text = [
    'See [the guide](../guide.md#setup "Setup") and ![logo](./img/logo.png).',
    'Root [notes](/NOTES.md), a [folder](../../examples/), [spaced](<my file.md>), [encoded](a%20b.md?raw=1).',
    'External [site](https://mopilot.ai), [mail](mailto:a@example.invalid), [here](#anchor), [proto](//cdn.example/x).',
    'Inline `[not](a-link.md)` and ``[also](not.md)`` stay code.',
    '```md',
    '[fenced](nope.md)',
    '```',
    '~~~',
    '[tilde](nope2.md)',
    '~~~',
    'An [escaped \\] label](x.md).',
  ].join('\n');
  const links = markdownLinks('docs/sub/page.md', text);
  assert.deepEqual(
    links.map((link) => [link.target, link.resolved, link.image]),
    [
      ['../guide.md#setup', 'docs/guide.md', false],
      ['./img/logo.png', 'docs/sub/img/logo.png', true],
      ['/NOTES.md', 'NOTES.md', false],
      ['../../examples/', 'examples', false],
      ['my file.md', 'docs/sub/my file.md', false],
      ['a%20b.md?raw=1', 'docs/sub/a b.md', false],
      ['https://mopilot.ai', null, false],
      ['mailto:a@example.invalid', null, false],
      ['#anchor', null, false],
      ['//cdn.example/x', null, false],
      ['x.md', 'docs/sub/x.md', false],
    ],
  );
  const [first, picture] = links;
  assert.equal(text.slice(first.start, first.end), '[the guide](../guide.md#setup "Setup")');
  assert.equal(text.slice(first.labelStart, first.labelEnd), 'the guide');
  assert.equal(text.slice(picture.labelStart, picture.labelEnd), 'logo');
  const coded = 'A [`code` label](x.md).';
  const [link] = markdownLinks('a.md', coded);
  assert.equal(coded.slice(link.labelStart, link.labelEnd), '`code` label', 'label offsets read the original text');
  assert.equal(markdownLinks('a.md', '[bad](100%.md)')[0].resolved, '100%.md', 'a lone % stays as written');
  assert.equal(markdownLinks('a.md', '[cut](%E0%A4.md)')[0].resolved, '\uFFFD.md', 'an invalid sequence cannot throw');
  assert.equal(markdownLinks('a.md', '[cjk](%E6%96%87.md)')[0].resolved, '文.md');
  assert.equal(markdownLinks('docs/a.md', '[up](..)')[0].resolved, '', 'the repository root');
  assert.equal(withoutCode('a `b` c').length, 'a `b` c'.length, 'blanking keeps offsets');
  assert.deepEqual(
    markdownLinks('a.md', '~~~\n[in](unclosed.md)\n').map((link) => link.target),
    [],
    'an unclosed fence runs to the end of the file',
  );
  assert.equal(withoutLineCode('`a\n<!-- m -->\nb`'), '`a\n<!-- m -->\nb`', 'a span across lines is not one-line code');
  assert.equal(withoutLineCode('~~~\nopen').includes('open'), true, 'an unclosed fence is not code for markers');
  assert.equal(withoutLineCode('x `y` z'), 'x     z');
});

test('reference definitions sit at the top level or in quotes and list items; autolinks stand alone', () => {
  const text = [
    '[a]: one.md',
    '> [b]: two.md "Two"',
    '- [c]: <three.md>',
    '1. [d]: four.md',
    'See <https://mopilot.ai> and [e](<https://x.example/>).',
  ].join('\n');
  assert.deepEqual(
    markdownLinks('docs/x.md', text).map((link) => [link.kind, link.target, link.resolved]),
    [
      ['definition', 'one.md', 'docs/one.md'],
      ['definition', 'two.md', 'docs/two.md'],
      ['definition', 'three.md', 'docs/three.md'],
      ['definition', 'four.md', 'docs/four.md'],
      ['autolink', 'https://mopilot.ai', null],
      ['link', 'https://x.example/', null],
    ],
  );
});

test('a path exists as a file or as a folder holding one', () => {
  const files = new Set(['docs/a.md', 'lib/x.ts']);
  assert.equal(pathExists(files, 'docs/a.md'), true);
  assert.equal(pathExists(files, 'lib'), true);
  assert.equal(pathExists(files, 'li'), false, 'a prefix of a name is not a folder');
  assert.equal(pathExists(files, ''), true);
  assert.equal(pathExists(files, 'docs/b.md'), false);
});

test('npm run names carry the package a prefix or a cd on their line names', () => {
  const text = [
    'Run `npm run lint` and `npm run test:coverage -- --changed`.',
    '    npm run screenshots --prefix phone -- --wda x',
    'Then `npm run release:bump --prefix=phone/` and `cd site && npm run db:migrate`.',
    'Not a command: `npm run <script>`. Again: npm run lint.',
  ].join('\n');
  assert.deepEqual(npmRunScripts(text), [
    { name: 'lint', prefix: null },
    { name: 'test:coverage', prefix: null },
    { name: 'screenshots', prefix: 'phone' },
    { name: 'release:bump', prefix: 'phone' },
    { name: 'db:migrate', prefix: 'site' },
  ]);
});

test('the owning manifest is the nearest package.json at or above the file', () => {
  const files = new Set(['package.json', 'phone/package.json', 'phone/README.md', 'docs/a.md']);
  assert.equal(owningManifest(files, 'phone/guides/README.md'), 'phone/package.json');
  assert.equal(owningManifest(files, 'docs/deep/a.md'), 'package.json');
  assert.equal(owningManifest(files, 'NOTES.md'), 'package.json');
  assert.equal(owningManifest(new Set(['x/package.json']), 'docs/a.md'), null);
});
