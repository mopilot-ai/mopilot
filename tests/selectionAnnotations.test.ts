import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { withSelections } from '../shared/selections.mjs';
import { parseUserText } from '../shared/userText.mjs';
import { annotationAttachment, selectionAttachment, editSelection, removeSelection, updateAnnotation } from '../src/lib/annotations.ts';

const require = createRequire(import.meta.url);
const { buildInput } = require('../electron/harness/codex.cjs');
const { buildClaudeMessage } = require('../electron/harness/claude/message.cjs');
const { acpBlocks } = require('../electron/harness/acpTurns.cjs');

test('an unannotated prompt stays plain and snippets use framed JSON context', () => {
  assert.equal(withSelections('hello', []), 'hello');
  assert.equal(
    withSelections('fix it', ['chosen', { text: 'second' }]),
    '\n# Selected text:\n<selected-text>\n["chosen","second"]\n</selected-text>\n\n## My request:\nfix it\n',
  );
  assert.deepEqual(parseUserText(withSelections('', [{}])), { text: '', selections: [''], annotations: [], files: [] });
});

test('each numbered annotation keeps its own comment and blank optional comments remain valid', () => {
  const selections = [annotationAttachment('first point', undefined, '11'), annotationAttachment('second point')];
  const parsed = parseUserText(withSelections('Please fix both', selections));
  assert.deepEqual(parsed.annotations, [
    { text: 'first point', annotation: '11' },
    { text: 'second point', annotation: undefined },
  ]);
  assert.equal(parsed.text, 'Please fix both');
  assert.deepEqual(parsed.selections, []);
  assert.deepEqual(parseUserText(withSelections('', [{ annotation: 'comment' }])).annotations, []);
});

test('annotation JSON round trips Unicode, line breaks and embedded closing tags without leaking draft metadata', () => {
  const text = '中文 🙂\n</response-annotations>\n## My request:';
  const comment = '"quoted"\\path\n<response-annotations>hello';
  const attachment = annotationAttachment(text, { messageId: 'reply-1', start: 8, end: 42 }, comment);
  const body = withSelections('continue', [attachment]);
  assert.deepEqual(parseUserText(body).annotations, [{ text, annotation: comment }]);
  assert.equal(body.split('</response-annotations>').length, 2);
  assert.ok(!body.includes(attachment.annotationId!));
  assert.ok(!body.includes('reply-1'));
});

test('legacy selections and annotations can travel together without moving a comment into the request', () => {
  const parsed = parseUserText(withSelections('request', [selectionAttachment('shell output'), { text: 'quote', annotation: 'comment' }]));
  assert.deepEqual(parsed.selections, ['shell output']);
  assert.deepEqual(parsed.annotations, [{ text: 'quote', annotation: 'comment' }]);
  assert.equal(parsed.text, 'request');
});

test('editing and deleting by selection index preserves other attachments, order, source and stable IDs', () => {
  const file = { kind: 'file', name: 'a.ts', path: '/repo/a.ts' } as const;
  const first = annotationAttachment('one', { messageId: 'reply', start: 0, end: 3 }, 'old');
  const second = selectionAttachment('two');
  const items = [file, first, second];
  const edited = editSelection(items, 0, 'new');
  assert.equal(edited[0], file);
  assert.equal(edited[2], second);
  assert.equal(edited[1].annotation, 'new');
  assert.equal(edited[1].annotationId, first.annotationId);
  assert.equal(edited[1].source, first.source);
  assert.equal(first.annotation, 'old');
  assert.ok(editSelection(items, 1, '').at(-1)!.annotationId);
  assert.deepEqual(removeSelection(items, 0), [file, second]);
  assert.deepEqual(removeSelection(items, 99), items);
  assert.deepEqual(editSelection(items, 99, 'ignored'), items);
  assert.deepEqual(updateAnnotation(items, first.annotationId!, 'updated'), [file, { ...first, annotation: 'updated' }, second]);
  assert.deepEqual(updateAnnotation(items, 'missing', 'ignored'), items);
});

for (const harness of ['codex', 'claude', 'acp']) {
  test(`${harness} transmits per-selection comments and preserves chat references and file attachments`, async () => {
    const annotations = [annotationAttachment('first', undefined, '11'), annotationAttachment('second', undefined, '222')];
    const file = { kind: 'file', name: 'a.ts', path: '/repo/a.ts' };
    const reference = { kind: 'session', path: 'other-chat', name: 'Earlier chat', text: 'User: older request' };
    let body: string;
    if (harness === 'codex') {
      const input = buildInput('fix these', [...annotations, file, reference]);
      body = input[0].text;
      assert.deepEqual(input.slice(1), [{ type: 'mention', name: 'a.ts', path: '/repo/a.ts' }]);
    } else if (harness === 'claude') {
      body = buildClaudeMessage({ text: 'fix these', attachments: [...annotations, file, reference] }, () => null).content;
      assert.match(body, /@\/repo\/a.ts/);
    } else {
      const blocks = await acpBlocks('fix these', [...annotations, file, reference], async () => null);
      body = blocks[0].text;
      assert.deepEqual(blocks.slice(1), [{ type: 'resource_link', uri: 'file:///repo/a.ts', name: 'a.ts' }]);
    }
    assert.match(body, /"conversation":"User: older request"/);
    const parsed = parseUserText(body);
    assert.deepEqual(parsed.annotations, [
      { text: 'first', annotation: '11' },
      { text: 'second', annotation: '222' },
    ]);
    assert.match(parsed.text, /^fix these/);
  });
}

test('snippet framing round trips unfinished Markdown, headings, closing tags and multiple selections', () => {
  const values = ['```js\n## My request:\n## Selection 7\n</selected-text>', 'Use ` and finish later'];
  const body = withSelections('What is `foo`?', values);
  assert.deepEqual(parseUserText(body).selections, values);
  assert.equal(parseUserText(body).text, 'What is `foo`?');
  assert.equal(body.split('</selected-text>').length, 2);
  assert.deepEqual(parseUserText('# Selected text:\n## Selection 1\nold\n## My request:\nask').selections, ['old']);
  assert.equal(parseUserText('# Selected text:\n## Selection 1\n```js\nunfinished\n## My request:\nask').text, 'ask');
});

test('malformed framed snippets remain readable instead of being discarded', () => {
  for (const value of ['bad JSON', '42', '[null]', '[]']) {
    const wrapper = `<selected-text>${value}</selected-text>`;
    const parsed = parseUserText(`# Selected text:\n${wrapper}\n## My request:\nask`);
    assert.deepEqual(parsed.selections, value === '[]' ? [] : [wrapper]);
    assert.equal(parsed.text, 'ask');
  }
});

test('a framed request preserves indentation that makes transport-marker examples code', () => {
  const request = '    <image name=[Image #1]></image>';
  assert.equal(parseUserText(withSelections(request, ['example'])).text, request);
});
