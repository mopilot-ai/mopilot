// Diff comments as the official app's `# Diff comments:` section: written the same for every harness and read back for the echo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { diffCommentLines, formatDiffComments, parseDiffComments } from '../shared/diffComments.mjs';
import { withSelections } from '../shared/selections.mjs';
import { parseUserText } from '../shared/userText.mjs';
import { annotationAttachment, diffCommentAttachment, selectionAttachment } from '../src/lib/annotations.ts';

const require = createRequire(import.meta.url);
const { buildInput } = require('../electron/harness/codex.cjs');
const { buildClaudeMessage } = require('../electron/harness/claude/message.cjs');
const { acpBlocks } = require('../electron/harness/acpTurns.cjs');

const range = (extra = {}) => ({
  path: 'src/a.ts',
  workspace: '/repo',
  startSide: 'R' as const,
  startLine: 3,
  endSide: 'R' as const,
  endLine: 4,
  hunk: '+const a = 1;\n+const b = 2;',
  ...extra,
});

test('Lines: one line, a range in either order, and a range across sides', () => {
  assert.equal(diffCommentLines({ startSide: 'R', startLine: 7, endSide: 'R', endLine: 7 }), '7');
  assert.equal(diffCommentLines({ startSide: 'L', startLine: 9, endSide: 'L', endLine: 5 }), '5-9');
  assert.equal(diffCommentLines({ startSide: 'L', startLine: 5, endSide: 'R', endLine: 7 }), 'L5-R7');
});

test('comments are written in the official app format, numbered from the first', () => {
  assert.equal(formatDiffComments([]), '');
  assert.equal(
    formatDiffComments([{ diff: range(), annotation: 'Rename these' }]),
    '\n# Diff comments:\n\n## User Comment 1\nFile: src/a.ts\nWorkspace: /repo\nSide: R\nLines: 3-4\nDiff hunk:\n```diff\n+const a = 1;\n+const b = 2;\n```\nComment:\nRename these\n',
  );
  const crossing = formatDiffComments([{ diff: range({ workspace: undefined, startSide: 'L', startLine: 2, hunk: '  ' }) }]);
  assert.equal(crossing, '\n# Diff comments:\n\n## User Comment 1\nFile: src/a.ts\nSide: L-R\nLines: L2-R4\nComment:\n\n');
});

test('a hunk with backtick runs gets a longer fence, and a comment cannot open a heading or a fence', () => {
  const hunk = ' ```js\n+````\n-x';
  const comment = '## My request:\n# Selected text:\n```\n  ~~~\n\\#kept\nplain';
  const body = withSelections('do it', [diffCommentAttachment(range({ hunk }), comment)]);
  assert.match(body, /^`````diff$/m);
  assert.match(body, /^\\## My request:$/m);
  const parsed = parseUserText(body);
  assert.equal(parsed.text, 'do it');
  assert.deepEqual(parsed.annotations, [{ text: hunk, annotation: comment, file: { path: 'src/a.ts', lines: '3-4', side: 'R' } }]);
});

test('reading back: fields, a missing hunk or comment, the official unnumbered heading, and a comment without a file', () => {
  assert.deepEqual(parseDiffComments('\n## Comment 2\nFile: b.ts\nComment:\nhi\n\n## User Comment 3\nSide: R\nComment:\nno file\n'), [
    { text: '', annotation: 'hi', file: { path: 'b.ts', lines: '', side: 'R' } },
  ]);
  assert.deepEqual(parseDiffComments('\n## User Comment 1\nFile: c.ts\nSide: L\nLines: 4\n'), [
    { text: '', annotation: undefined, file: { path: 'c.ts', lines: '4', side: 'L' } },
  ]);
  // a field after the comment marker is comment text, not a field
  assert.deepEqual(parseDiffComments('\n## User Comment 1\nComment:\nFile: not-a-field\n'), []);
});

test('diff comments travel with response annotations and selected text, each in its own section', () => {
  const selections = [
    annotationAttachment('reply text', undefined, 'why?'),
    diffCommentAttachment(range(), 'fix'),
    selectionAttachment('log line'),
  ];
  const body = withSelections('go', selections);
  assert.ok(body.indexOf('# Response annotations:') < body.indexOf('# Diff comments:'));
  assert.ok(body.indexOf('# Diff comments:') < body.indexOf('# Selected text:'));
  const parsed = parseUserText(body);
  assert.deepEqual(parsed.annotations, [
    { text: 'reply text', annotation: 'why?' },
    { text: range().hunk, annotation: 'fix', file: { path: 'src/a.ts', lines: '3-4', side: 'R' } },
  ]);
  assert.deepEqual(parsed.selections, ['log line']);
  assert.equal(parsed.text, 'go');
  // a message of diff comments alone is still recognised as context
  assert.equal(parseUserText(withSelections('only', [diffCommentAttachment(range(), 'x')])).text, 'only');
});

test('the attachment keeps its range and quotes the hunk, without leaking draft ids into the message', () => {
  const a = diffCommentAttachment(range(), 'note');
  assert.equal(a.kind, 'selection');
  assert.equal(a.name, 'Diff comment');
  assert.equal(a.text, range().hunk);
  assert.equal(a.annotation, 'note');
  assert.deepEqual(a.diff, range());
  assert.ok(!withSelections('x', [a]).includes(a.annotationId!));
});

for (const harness of ['codex', 'claude', 'acp']) {
  test(`${harness} sends diff comments in the shared section beside other attachments`, async () => {
    const attachments = [diffCommentAttachment(range(), 'Use a constant'), { kind: 'file', name: 'b.ts', path: '/repo/b.ts' }];
    let body: string;
    if (harness === 'codex') {
      const input = buildInput('please', attachments);
      body = input[0].text;
      assert.deepEqual(input.slice(1), [{ type: 'mention', name: 'b.ts', path: '/repo/b.ts' }]);
    } else if (harness === 'claude') {
      body = buildClaudeMessage({ text: 'please', attachments }, () => null).content;
    } else {
      const blocks = await acpBlocks('please', attachments, async () => null);
      body = blocks[0].text;
      assert.deepEqual(blocks.slice(1), [{ type: 'resource_link', uri: 'file:///repo/b.ts', name: 'b.ts' }]);
    }
    assert.ok(body.includes(formatDiffComments([{ diff: range(), annotation: 'Use a constant' }])));
    assert.deepEqual(parseUserText(body).annotations, [
      { text: range().hunk, annotation: 'Use a constant', file: { path: 'src/a.ts', lines: '3-4', side: 'R' } },
    ]);
  });
}

test('a truncated or malformed message shows as text, and a hunk fence left open keeps its comment', () => {
  const body = withSelections('go', [diffCommentAttachment(range(), 'keep me')]);
  // cut inside the hunk: no request header is found, so the raw text shows rather than a wrong split
  const cut = parseUserText(body.slice(0, body.indexOf('+const b')));
  assert.deepEqual(cut.annotations, []);
  assert.ok(cut.text.startsWith('\n# Diff comments:'));
  // the hunk's closing fence missing: the comment is still read, without a hunk
  const open = parseUserText(body.replace('+const b = 2;\n```\n', '+const b = 2;\n'));
  assert.equal(open.text, 'go');
  assert.deepEqual(open.annotations, [{ text: '', annotation: 'keep me', file: { path: 'src/a.ts', lines: '3-4', side: 'R' } }]);
});

test('a path with a line break or a leading quote is written as JSON and read back exactly', () => {
  for (const path of ['a\nLines: 99.ts', '"quoted".ts']) {
    const body = withSelections('go', [diffCommentAttachment(range({ path }), 'c')]);
    assert.ok(body.includes(`File: ${JSON.stringify(path)}\n`));
    assert.equal(parseUserText(body).annotations[0].file!.path, path);
    assert.equal(parseUserText(body).annotations[0].file!.lines, '3-4');
  }
  // a quoted value that is not valid JSON stays as written
  assert.equal(parseDiffComments('\n## User Comment 1\nFile: "broken\nComment:\nx\n')[0].file.path, '"broken');
  assert.equal(parseDiffComments('\n## User Comment 1\nFile: "a"b\nComment:\nx\n')[0].file.path, '"a"b');
});
