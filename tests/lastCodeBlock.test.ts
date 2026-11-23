// "Copy last code block" in a long thread: the last code block, whether its turn renders or is a placeholder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
const { lastCodeBlock } = await import('../src/lib/lastCodeBlock.ts');

/** A thread view with one slot per [turn id, rendered html | null for a placeholder]. */
function view(slots: [string, string | null][], extra = '') {
  const root = window.document.createElement('div');
  root.innerHTML =
    extra +
    slots.map(([id, html]) => `<div data-turn-slot="${id}"${html === null ? ' style="height: 400px"' : ''}>${html ?? ''}</div>`).join('');
  return root as unknown as HTMLElement;
}
const reply = (text: unknown) => ({ type: 'agentMessage', text });

test("a rendered turn's last code block wins over earlier turns", () => {
  const v = view([
    ['a', '<pre><code>first</code></pre>'],
    ['b', '<p>prose</p><pre><code>one</code></pre><pre><code>two</code></pre>'],
  ]);
  let read = 0;
  assert.equal(
    lastCodeBlock(v, () => (read++, [])),
    'two',
  );
  // the turns are read only to look into a placeholder
  assert.equal(read, 0);
});

test("a placeholder's code comes from its replies: the last fenced or indented block, the last reply first", () => {
  const turns = [
    { id: 'a', items: [reply('```ts\nconst a = 1;\n```')] },
    {
      id: 'b',
      items: [
        reply('```sh\necho one\n```\n\nthen\n\n    indented code'),
        reply('no code, only `inline`'),
        { type: 'commandExecution' },
        reply(7),
      ],
    },
  ];
  assert.equal(
    lastCodeBlock(
      view([
        ['a', null],
        ['b', null],
      ]),
      () => turns,
    ),
    'indented code',
  );
  // a rendered turn after it, with no code, is passed over
  assert.equal(
    lastCodeBlock(
      view([
        ['a', null],
        ['c', '<p>none</p>'],
      ]),
      () => turns,
    ),
    'const a = 1;',
  );
  // an empty fenced block is a block of its own
  assert.equal(
    lastCodeBlock(view([['e', null]]), () => [{ id: 'e', items: [reply('```\n```')] }]),
    '',
  );
});

test('no code anywhere, an unknown placeholder, or a view with no turn slots', () => {
  assert.equal(
    lastCodeBlock(view([['z', null]]), () => [{ id: 'z', items: [reply('just prose')] }]),
    null,
  );
  assert.equal(
    lastCodeBlock(
      view([
        ['x', null],
        ['y', '<p>text</p>'],
      ]),
      () => [{ id: 'y', items: [] }],
    ),
    null,
  );
  // a view without slots reads what it renders
  assert.equal(
    lastCodeBlock(view([], '<pre><code>plain</code></pre>'), () => []),
    'plain',
  );
  assert.equal(
    lastCodeBlock(view([]), () => []),
    null,
  );
});
