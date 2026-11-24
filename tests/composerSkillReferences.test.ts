import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  composerPopup,
  composerSlashItems,
  applyComposerSlashItem,
  slashCommandPresentation,
  slashPickRest,
  type ComposerSlashItem,
} from '../src/lib/composerSkills.ts';

test('slash commands are available at the start, while inline slash references show only skills', () => {
  assert.deepEqual(composerPopup('/', 1), { kind: 'slash', query: '', start: 0, skillsOnly: false });
  assert.deepEqual(composerPopup('/model', 6), { kind: 'slash', query: 'model', start: 0, skillsOnly: false });
  for (const prefix of ['Use ', 'Use\n', 'Use\t', '请使用 ']) {
    const value = prefix + '/my-skill';
    assert.deepEqual(composerPopup(value, value.length), { kind: 'slash', query: 'my-skill', start: prefix.length, skillsOnly: true });
  }
});

test('dollar references work at the start and within prose, including plugin-qualified names', () => {
  for (const prefix of ['', 'Use ', 'Use\n']) {
    for (const query of ['', 'my_skill', 'plugin:my.skill-2']) {
      const value = prefix + '$' + query;
      assert.deepEqual(composerPopup(value, value.length), { kind: 'slash', query, start: prefix.length, skillsOnly: true });
    }
  }
});

test('the active reference follows the caret and does not consume the rest of the prompt', () => {
  assert.deepEqual(composerPopup('Use $pdf then summarize', 8), { kind: 'slash', query: 'pdf', start: 4, skillsOnly: true });
  assert.deepEqual(composerPopup('Use $pdf and /review', 20), { kind: 'slash', query: 'review', start: 13, skillsOnly: true });
});

test('paths, URLs, embedded markers, and completed references do not open the menu', () => {
  for (const value of ['', 'hello', 'file/path', 'https://example.com', 'foo$bar', '$pdf ', '/tmp/file', '$foo!', 'Use\nplain']) {
    assert.equal(composerPopup(value, value.length), null, value);
  }
});

test('file and conversation mentions keep their existing multiword queries', () => {
  for (const [value, query, start] of [
    ['@', '', 0],
    ['Use @My chat', 'My chat', 4],
    ['Use\n@path/file', 'path/file', 4],
  ] as const) {
    assert.deepEqual(composerPopup(value, value.length), { kind: 'mention', query, start });
  }
  assert.equal(composerPopup('email@example.com', 17), null);
});

test('a file mention the list inserted opens nothing while it is intact, wherever it moved; an edited one or a new @ does', () => {
  const applied = ['@/home/a.ts ', '@/home/b.ts '];
  const value = 'see @/home/a.ts ';
  assert.equal(composerPopup(value, value.length, applied), null);
  assert.equal(composerPopup(value, 9, applied), null);
  // without it, the same text is a multiword query again (what reopened the list)
  assert.deepEqual(composerPopup(value, value.length), { kind: 'mention', query: '/home/a.ts ', start: 4 });
  // text typed before it moved it
  const moved = `Please ${value}`;
  assert.equal(composerPopup(moved, moved.length, applied), null);
  // the caret after the first of two inserted mentions
  const two = 'see @/home/a.ts and @/home/b.ts ';
  assert.equal(composerPopup(two, 20, applied), null);
  assert.equal(composerPopup(two, two.length, applied), null);
  // the inserted text was changed: it is a query again
  assert.deepEqual(composerPopup('see @/home/c', 12, applied), { kind: 'mention', query: '/home/c', start: 4 });
  // a new @ after it
  assert.deepEqual(composerPopup(`${value}and @x`, value.length + 6, applied), { kind: 'mention', query: 'x', start: value.length + 4 });
  // a path holding an @ (node_modules/@types) never opens the list on its inner @
  assert.equal(composerPopup('see @node_modules/@types/node ', 30), null);
});

test('skill-only menus exclude commands and keep both attachment and native skills', () => {
  const items = [
    { skill: true, id: 'pdf' },
    { id: 'model' },
    { skill: false, id: 'review' },
    { skill: true, completion: { text: '/native', keepTrigger: true }, id: 'native' },
  ];
  assert.deepEqual(composerSlashItems(items, composerPopup('$', 1)!), [items[0], items[3]]);
  assert.deepEqual(composerSlashItems(items, composerPopup('Use /', 5)!), [items[0], items[3]]);
  assert.equal(composerSlashItems(items, composerPopup('/', 1)!), items);
  assert.deepEqual(composerSlashItems([], composerPopup('$', 1)!), []);
});

function pick(text: string, caret: number, item: ComposerSlashItem) {
  const events: unknown[] = [];
  applyComposerSlashItem(text, composerPopup(text, caret)!, item, {
    setText: (value) => events.push(['text', value]),
    close: () => events.push('close'),
    focus: () => events.push('focus'),
    restoreCaret: (position) => events.push(['caret', position]),
  });
  return events;
}

test('selecting a Codex skill attaches it once and preserves the prefix, suffix, and caret', () => {
  let attached = 0;
  const item = {
    skill: true,
    run: () => {
      attached++;
    },
  };
  assert.deepEqual(pick('Use $pdf then summarize', 8, item), [['text', 'Use  then summarize'], ['caret', 4], 'close']);
  assert.equal(attached, 1);
  assert.deepEqual(pick('Use\n/pdf', 8, item), [['text', 'Use\n'], ['caret', 4], 'close']);
  assert.equal(attached, 2);
  assert.deepEqual(pick('/pdf keep this', 4, item), [['text', ' keep this'], ['caret', 0], 'close']);
  assert.equal(attached, 3);
});

test('native skill selection retains the trigger and leaves the rest of the draft intact', () => {
  const item = { skill: true, completion: { text: '/pdf', keepTrigger: true }, run: () => assert.fail('completion has no action') };
  assert.deepEqual(pick('Use $p then summarize', 6, item), [['text', 'Use $pdf then summarize'], ['caret', 9], 'close']);
  assert.deepEqual(pick('/p', 2, item), [['text', '/pdf '], ['caret', 5], 'close']);
  assert.deepEqual(pick('Use /p', 6, item), [['text', 'Use /pdf '], ['caret', 9], 'close']);
});

test('only available command tokens are highlighted and only a bare leading command shows argument guidance', () => {
  const items = [
    { completion: { text: '/review', hint: '[focus]' }, aliases: ['rev'] },
    { completion: { text: '/team:notes', keepTrigger: true, hint: '<topic>' }, skill: true },
    { completion: { text: '/offline', hint: '<text>' }, disabled: 'Unavailable' },
  ];
  assert.deepEqual(slashCommandPresentation('/review ', items), { ranges: [{ start: 0, end: 7 }], hint: '[focus]' });
  assert.deepEqual(slashCommandPresentation('/review', items), { ranges: [{ start: 0, end: 7 }], hint: '[focus]' });
  assert.deepEqual(slashCommandPresentation('/review\u00a0', items), { ranges: [{ start: 0, end: 7 }], hint: '[focus]' });
  assert.deepEqual(slashCommandPresentation('/rev ', items), { ranges: [{ start: 0, end: 4 }], hint: '[focus]' });
  assert.deepEqual(slashCommandPresentation('/review src', items), { ranges: [{ start: 0, end: 7 }], hint: undefined });
  assert.deepEqual(slashCommandPresentation('/review\n', items), { ranges: [{ start: 0, end: 7 }], hint: undefined });
  assert.deepEqual(slashCommandPresentation('/team:notes ', items), { ranges: [{ start: 0, end: 11 }], hint: '<topic>' });
  assert.deepEqual(slashCommandPresentation('$team:notes ', items), { ranges: [{ start: 0, end: 11 }], hint: undefined });
  assert.deepEqual(slashCommandPresentation('Use $team:notes then /team:notes', items), {
    ranges: [
      { start: 4, end: 15 },
      { start: 21, end: 32 },
    ],
    hint: undefined,
  });
  for (const value of ['Use /review', ' /review ', '/offline ', '/reviewed ', '/review/file', 'file/review', '$rev ', '']) {
    assert.deepEqual(slashCommandPresentation(value, items), { ranges: [], hint: undefined }, value);
  }
});

test('a command picked in front of a draft takes only its /name, and the draft stays without its separator', () => {
  assert.deepEqual(pick('/planfix the bug', 5, { run: () => {} }), [['text', 'fix the bug'], 'focus', 'close']);
  assert.deepEqual(pick('/plan \nfix the bug', 5, {}), [['text', 'fix the bug'], 'focus', 'close']);
  // the next line's indentation (a code block) is the user's
  assert.deepEqual(pick('/plan\n    def f():', 5, {}), [['text', '    def f():'], 'focus', 'close']);
  // an inline reference keeps the text on both sides as it stands
  assert.equal(slashPickRest('Use /pdf then', composerPopup('Use /pdf then', 8)!), 'Use  then');
});

test('a command alone leaves an empty box before dispatch, then focuses and closes the menu', () => {
  const events: unknown[] = [];
  applyComposerSlashItem(
    '/model',
    composerPopup('/model', 6)!,
    { run: () => events.push('run') },
    {
      setText: (value) => events.push(['text', value]),
      close: () => events.push('close'),
      focus: () => events.push('focus'),
      restoreCaret: () => assert.fail('commands do not restore a skill caret'),
    },
  );
  assert.deepEqual(events, [['text', ''], 'run', 'focus', 'close']);
});

test('entries without an action still close safely and restore the appropriate focus', () => {
  assert.deepEqual(pick('$pdf', 4, { skill: true }), [['text', ''], ['caret', 0], 'close']);
  assert.deepEqual(pick('/model', 6, {}), [['text', ''], 'focus', 'close']);
});

test('a picked file mention keeps the list closed beside it, also once the space after it is deleted (#4581)', () => {
  const applied = ['@docs/a.md '];
  assert.equal(composerPopup('read @docs/a.md and', 19, applied), null);
  assert.equal(composerPopup('read @docs/a.md', 15, applied), null);
  // a different mention typed after it still opens the list
  assert.deepEqual(composerPopup('read @docs/a.md @b', 18, applied), { kind: 'mention', query: 'b', start: 16 });
});
