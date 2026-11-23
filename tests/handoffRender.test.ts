import { withSelections } from '../shared/selections.mjs';
// shared/handoff.mjs and shared/userText.mjs: rendering every kind of thread step and user-message context.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderConversation, goalAgain } from '../shared/handoff.mjs';
import { extractReplyQuotes, parseUserText, prettyCommand } from '../shared/userText.mjs';
import { defined } from './support/defined.ts';

const user = (text: string) => ({ type: 'userMessage', content: [{ type: 'text', text }, { type: 'image' }] });

test('a full turn lists every kind of tool step', () => {
  const turn = {
    items: [
      { type: 'userMessage' },
      {
        type: 'commandExecution',
        commandActions: [
          { type: 'read', name: 'a.ts' },
          { type: 'read', path: '/r/b.ts' },
          { type: 'search', command: 'rg x' },
          { type: 'search', query: 'foo', path: 'src' },
          { type: 'listFiles' },
          { type: 'listFiles', path: 'lib' },
        ],
      },
      {
        type: 'commandExecution',
        command: '/bin/zsh -lc "npm test"',
        exitCode: 1,
        aggregatedOutput: Array.from({ length: 15 }, (_, i) => `line ${i}`).join('\n') + '\n',
      },
      { type: 'commandExecution', status: 'declined', aggregatedOutput: 'short\n' },
      { type: 'commandExecution', commandActions: [{ type: 'unknown' }], command: 'make', aggregatedOutput: '   ' },
      {
        type: 'fileChange',
        changes: [
          { path: 'new.ts', kind: { type: 'add' }, diff: '--- /dev/null\n+++ b/new.ts\n+a\n+b' },
          { path: 'old.ts', kind: { type: 'delete' }, diff: '--- a/old.ts\n+++ /dev/null\n-x' },
          { path: 'mid.ts', kind: { type: 'update' }, diff: '+a\n-b\n ctx' },
          { path: 'raw.ts' },
        ],
      },
      { type: 'fileChange', status: 'declined', changes: [{ path: 'no.ts', diff: '' }] },
      { type: 'fileChange' },
      { type: 'webSearch', query: 'node test' },
      { type: 'webSearch', action: { url: 'https://x.dev' } },
      { type: 'webSearch' },
      { type: 'mcpToolCall', server: 'fs', tool: 'read' },
      { type: 'mcpToolCall', tool: 'only' },
      { type: 'collabAgentToolCall', prompt: 'look around' },
      { type: 'collabAgentToolCall', tool: 'spawn' },
      { type: 'statusNote', kind: 'task', text: 'task started' },
      { type: 'statusNote', kind: 'info', text: 'ignored' },
      { type: 'reasoning' },
    ],
  };
  const { text } = renderConversation([turn as any], 1e6);
  assert.equal(
    text,
    [
      '### Turn 1',
      'User: (no message; the agent continued on its own)',
      'Steps:',
      '- Read a.ts',
      '- Read /r/b.ts',
      '- Searched for rg x',
      '- Searched for foo in src',
      '- Listed files',
      '- Listed lib',
      '- Ran `npm test` → exit 1',
      '    …',
      ...Array.from({ length: 12 }, (_, i) => `    line ${i + 3}`),
      '- Ran `` (declined by user)',
      '    short',
      '- Ran `make`',
      '- Created new.ts (+2 −0)',
      '- Deleted old.ts (+0 −1)',
      '- Edited mid.ts (+1 −1)',
      '- Edited raw.ts (+0 −0)',
      '- Declined edit to no.ts (+0 −0)',
      '- Web: node test',
      '- Web: https://x.dev',
      '- Web: search',
      '- Tool fs · read',
      '- Tool only',
      '- Sub-agent: look around',
      '- Sub-agent: spawn',
      '- (task started)',
      'Assistant: (no reply)',
    ].join('\n'),
  );
});

test('condensed turns summarize the request and reply, or say the agent continued', () => {
  const turns = [
    { items: [{ type: 'agentMessage', text: 'did it' }] },
    { items: [user('do it')] },
    { items: [user('x'.repeat(4000)), { type: 'agentMessage', text: 'done' }] },
  ];
  const { text, condensed } = renderConversation(turns as any, 600);
  assert.equal(condensed, 2);
  assert.match(text, /- Turn 1: continued on its own → did it/);
  assert.match(text, /- Turn 2: user asked "do it"\n/);
  assert.match(text, /### Turn 3\nUser: x+\nAssistant: done/);
});

test('the goal is set again as a command for Claude Code and as an option for Codex', () => {
  assert.deepEqual(goalAgain('claude', 'ship'), { text: '/goal ship', opts: {} });
  assert.deepEqual(goalAgain('codex', 'ship'), { text: 'ship', opts: { goal: 'ship' } });
  // a switch only goes to a first-tier harness: anything else is refused, not set as Codex's option
  assert.throws(() => goalAgain('acp:kimi' as never, 'ship'), /no way to set a goal again on acp:kimi/);
  assert.throws(() => goalAgain('constructor' as never, 'ship'), /constructor/);
});

test('prettyCommand unwraps shell wrappers and leaves plain commands', () => {
  assert.equal(prettyCommand(`bash -lc 'echo \\"hi\\" \\\\ there'`), 'echo "hi" \\ there');
  assert.equal(prettyCommand('ls -la'), 'ls -la');
});

test('reply markers become annotations with their comments', () => {
  assert.equal(extractReplyQuotes('> plain quote'), null);
  const raw = 'intro\n<!-- reply 1 -->\n> first\n> more\nabout first\n<!-- reply 2 -->\n>second\n<!-- reply 3 -->\n\nthe message';
  assert.deepEqual(extractReplyQuotes(raw), {
    text: 'intro\n\nthe message',
    annotations: [
      { text: 'first\nmore', annotation: 'about first' },
      { text: 'second', annotation: undefined },
    ],
  });
  assert.deepEqual(parseUserText('<!-- reply 1 -->\n> q\nanswer'), {
    text: 'answer',
    annotations: [{ text: 'q', annotation: undefined }],
    files: [],
    selections: [],
  });
  assert.deepEqual(extractReplyQuotes('<!-- reply 1 -->'), { text: '', annotations: [] });
  assert.deepEqual(defined(extractReplyQuotes('<!-- reply 1 -->\n> a\n<!-- reply 2 -->\n> b\nmsg')).annotations, [
    { text: 'a', annotation: undefined },
    { text: 'b', annotation: undefined },
  ]);
});

test('context preambles yield annotations, files and selections', () => {
  const raw = [
    '# Response annotations:',
    '<response-annotations>[{"text":"a","annotation":"note"},{"text":"b"},{"annotation":"none"},null]</response-annotations>',
    '# Files mentioned by the user:',
    '## app.ts: /repo/app.ts',
    '## win.ts: C:\\repo\\win.ts',
    '## bad: relative/path',
    '# Selected text:',
    '## Selection 1',
    'picked',
    '## My request:',
    'Fix it <image name=[Image #1] src="x"></image>',
  ].join('\n');
  assert.deepEqual(parseUserText(raw), {
    text: 'Fix it',
    annotations: [
      { text: 'a', annotation: 'note' },
      { text: 'b', annotation: undefined },
    ],
    files: [
      { name: 'app.ts', path: '/repo/app.ts' },
      { name: 'win.ts', path: 'C:\\repo\\win.ts' },
    ],
    selections: ['picked'],
  });
  const bad = parseUserText('# Response annotations:\n<response-annotations>[oops</response-annotations>\n## My request:\nhi');
  assert.deepEqual(bad, { text: 'hi', annotations: [], files: [], selections: [] });
  // valid JSON that is not a list reads the same as malformed
  const notList = parseUserText('# Response annotations:\n<response-annotations>{"text":"a"}</response-annotations>\n## My request:\nhi');
  assert.deepEqual(notList.annotations, []);
});

test('older ambient context blocks are stripped; other text is kept', () => {
  assert.equal(parseUserText('<ide-context>x</ide-context>\n<os-context a="1">y</os-context>\n# My request:\nhello').text, 'hello');
  assert.equal(parseUserText('just text').text, 'just text');
  assert.equal(parseUserText('preamble\n## My request:\nhi').text, 'preamble\n## My request:\nhi');
});

test('literal reply and question markers in fenced examples survive user-message parsing', () => {
  const question = '<send_user_message_question_reply>[{"question":"example","answer":"value"}]</send_user_message_question_reply>';
  for (const fence of ['```markdown', '~~~~']) {
    const closing = fence[0].repeat(fence.startsWith('~') ? 4 : 3);
    const raw = `Explain this fixture:\n${fence}\n<!-- reply 1 -->\n> quoted example\n${question}\n${closing}\nKeep it literal.`;
    assert.deepEqual(parseUserText(raw), { text: raw, annotations: [], files: [], selections: [] });
    assert.equal(extractReplyQuotes(raw), null);
  }
  const inline = `Explain \`${question}\` literally.`;
  assert.equal(parseUserText(inline).text, inline);
});

test('real reply markers after a fenced example still become annotations', () => {
  const example = '```markdown\n<!-- reply 1 -->\n> literal\n```';
  assert.deepEqual(extractReplyQuotes(`${example}\n<!-- reply 2 -->\n> actual\nanswer`), {
    text: `${example}\n\nanswer`,
    annotations: [{ text: 'actual', annotation: undefined }],
  });
});

test('context headers inside selected fenced code do not split the actual request or its snippets', () => {
  const selection =
    '```markdown\n## My request:\nexample\n## Selection 9\n# Files mentioned by the user:\n## fake: /tmp/fake\n# Response annotations:\n```';
  const raw = `# Selected text:\n## Selection 1\n${selection}\n\n## My request:\nActual request`;
  assert.deepEqual(parseUserText(raw), { text: 'Actual request', annotations: [], files: [], selections: [selection] });
});

test('literal image and annotation wrappers stay code while actual metadata is decoded', () => {
  const code = '```xml\n<response-annotations>[{"text":"example"}]</response-annotations>\n```';
  const image = '`<image name=[Image #1] src="example"></image>`';
  const raw = `# Selected text:\n## Selection 1\n${code}\n# Response annotations:\n<response-annotations>[{"text":"actual"}]</response-annotations>\n## My request:\nExplain ${image}`;
  assert.deepEqual(parseUserText(raw), {
    text: `Explain ${image}`,
    annotations: [{ text: 'actual', annotation: undefined }],
    files: [],
    selections: [code],
  });
});

test('indented image and question examples stay literal; code in file metadata is not a file', () => {
  const question = '<send_user_message_question_reply>[{"question":"example","answer":"value"}]</send_user_message_question_reply>';
  const request = `    <image name=[Image #1]></image>\n\t${question}`;
  assert.equal(parseUserText(request).text, request);
  const files = '# Files mentioned by the user:\n```\n## example: /tmp/fake\n```\n## actual: /tmp/real\n## My request:\nExplain';
  assert.deepEqual(parseUserText(files).files, [{ name: 'actual', path: '/tmp/real' }]);
});

test('unfinished Markdown in generated metadata cannot hide its request separator', () => {
  assert.deepEqual(parseUserText(withSelections('What is `foo`?', [{ text: 'Use `', annotationId: 'a' }])), {
    text: 'What is `foo`?',
    annotations: [{ text: 'Use `', annotation: undefined }],
    files: [],
    selections: [],
  });
  const selected = '```js\nconst a = 1';
  assert.deepEqual(parseUserText(withSelections('Please finish this example', [selected])), {
    text: 'Please finish this example',
    annotations: [],
    files: [],
    selections: [selected],
  });
});

test('a message sent from Chrome’s side panel: what was typed and the tab apart, the tab still in the handoff and the export', async () => {
  const sent = 'Can I cancel for free?\n\n[Chrome tab: https://www.expedia.com/trips/x]';
  assert.deepEqual(
    [parseUserText(sent).text, parseUserText(sent).chromeTab],
    ['Can I cancel for free?', 'https://www.expedia.com/trips/x'],
  );
  // the next harness after a switch knows the page the user meant
  const text = renderConversation([{ items: [user(sent), { type: 'agentMessage', text: 'Yes.' }] }] as any, 1_000_000).text;
  assert.match(text, /Can I cancel for free\?\n\[Chrome tab: https:\/\/www\.expedia\.com\/trips\/x\]/);
  // only a line at the end, after a blank line, is the panel's
  assert.equal(parseUserText('see [Chrome tab: https://a.example/]').chromeTab, undefined);
  const { transcriptMarkdown } = await import('../src/session/transcript.ts');
  const md = transcriptMarkdown('T', [{ id: '1', items: [user(sent)] }] as any);
  assert.match(md, /Can I cancel for free\?\n\n_Chrome tab: https:\/\/www\.expedia\.com\/trips\/x_/);
  assert.doesNotMatch(md, /\[Chrome tab:/);
});

test('the side panel’s tab line before the lines Claude Code adds for attachments is still the tab, and those lines stay', () => {
  const p = parseUserText("Read this\n\n[Chrome tab: https://a.example/x]\n@/tmp/a.pdf\n[b.png couldn't be attached]");
  assert.deepEqual([p.text, p.chromeTab], ["Read this\n@/tmp/a.pdf\n[b.png couldn't be attached]", 'https://a.example/x']);
  // any other line after it: the user's own text, left as it is
  assert.equal(parseUserText('a\n\n[Chrome tab: https://a.example/x]\nmore').chromeTab, undefined);
});
