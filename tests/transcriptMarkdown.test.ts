// Share/Copy Markdown (src/session/transcript.ts): every item kind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transcriptMarkdown } from '../src/session/transcript.ts';

test('every item kind renders, with a default label that names no harness', () => {
  const md = transcriptMarkdown('T', [
    {
      id: '1',
      items: [
        { type: 'userMessage' },
        {
          type: 'userMessage',
          content: [{ type: 'image' }, { type: 'text', text: 'before\n<!-- reply 1 -->\n> first\nnote\n<!-- reply 2 -->\n> second\nask' }],
        },
        { type: 'agentMessage', text: '   ' },
        { type: 'agentMessage', phase: 'commentary', text: 'thinking' },
        { type: 'agentMessage', phase: 'final_answer', text: 'done' },
        { type: 'commandExecution', command: 'ls', aggregatedOutput: 'a\n' },
        { type: 'commandExecution', command: 'pwd' },
        { type: 'fileChange', changes: [{ path: 'a.ts', diff: '+x' }, { path: 'b.ts' }] },
        { type: 'fileChange' },
        { type: 'statusNote', kind: 'account', text: 'hidden' },
      ],
    },
  ] as any);
  assert.equal(
    md,
    [
      '# T',
      '',
      '## User',
      '',
      '## User',
      '',
      '> first',
      '',
      'note',
      '',
      '> second',
      '',
      'before\n\nask',
      '',
      '### Assistant (progress)',
      '',
      'thinking',
      '',
      '## Assistant',
      '',
      'done',
      '',
      '```sh',
      '$ ls',
      'a',
      '```',
      '',
      '```sh',
      '$ pwd',
      '',
      '```',
      '',
      'Edited `a.ts`',
      '',
      '```diff',
      '+x',
      '```',
      '',
      'Edited `b.ts`',
      '',
      '```diff',
      '',
      '```',
      '',
    ].join('\n'),
  );
});

test('output and diffs that contain fences stay inside their own code block', async () => {
  const { fromMarkdown } = await import('mdast-util-from-markdown');
  const output = 'README:\n```js\nx\n```\n````\ndone';
  const diff = ' # Title\n ```sh\n-old\n+new\n ```';
  const md = transcriptMarkdown('T', [
    {
      id: '1',
      items: [
        { type: 'commandExecution', command: 'cat README.md', aggregatedOutput: output },
        { type: 'fileChange', changes: [{ path: 'README.md', diff }] },
        { type: 'agentMessage', phase: 'final_answer', text: 'after' },
      ],
    },
  ] as any);
  const blocks = fromMarkdown(md).children.filter((n: any) => n.type === 'code') as any[];
  assert.deepEqual(
    blocks.map((b) => [b.lang, b.value]),
    [
      ['sh', `$ cat README.md\n${output}`],
      ['diff', diff],
    ],
  );
  assert.match(md, /\n## Assistant\n\nafter\n$/);
});
