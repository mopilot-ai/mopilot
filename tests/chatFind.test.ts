// Find in the chat: which prompts and replies a term is found in, read from the turns of any harness, and the folding
// both the turns' text and the rendered text share.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { foldText, foldTerm, occurrences, shownText, chatFindMatches, firstMatch, stepMatch } = await import('../src/session/chatFind.ts');
const { navigationItems } = await import('../src/session/threadNavigation.ts');

const user = (id: string, text: string) => ({ id, type: 'userMessage', content: [{ type: 'text', text }] });
const reply = (id: string, text: string, phase?: string) => ({ id, type: 'agentMessage', text, phase });
const turn = (id: string, items: any[], extra = {}) => ({ id, items, status: 'completed', ...extra }) as any;

test('folding lowers case, makes each run of space one, and maps every folded character back to its source', () => {
  assert.deepEqual(foldText('A  b\n\tC'), { text: 'a b c', at: [0, 1, 3, 4, 6] });
  // a character that lowers to two units keeps pointing at itself for both
  assert.deepEqual(foldText('İx'), { text: 'i̇x', at: [0, 0, 1] });
  // a character outside the basic plane is one step of the source and both of its units
  assert.deepEqual(foldText('a😀b'), { text: 'a😀b', at: [0, 1, 1, 3] });
  assert.equal(foldTerm('  Hello   World '), 'hello world');
  assert.equal(foldTerm(' \n '), '');
});

test('occurrences never overlap and an empty term finds nothing', () => {
  assert.deepEqual(occurrences('aaaa', 'aa'), [0, 2]);
  assert.deepEqual(occurrences('abcabc', 'bc'), [1, 4]);
  assert.deepEqual(occurrences('abc', 'x'), []);
  assert.deepEqual(occurrences('abc', ''), []);
});

test("a reply's Markdown counts as the reply draws it", () => {
  assert.equal(
    shownText('# Title\n> quote\n- item\n2. [x] done\n**bold** `code` ~~gone~~ __u__'),
    'Title\nquote\nitem\ndone\nbold code gone u',
  );
  assert.equal(shownText('see [the docs](https://x.test/a) and ![a chart](c.png)'), 'see the docs and a chart');
  assert.equal(shownText('```ts\nconst a = 1;\n```\n~~~\nb\n~~~'), 'const a = 1;\nb');
  // single emphasis stays: it is also how snake_case and globs are written
  assert.equal(shownText('a_b_c *.ts'), 'a_b_c *.ts');
});

test('the entries keep the words the user typed apart from the plan and reply drawn as Markdown', () => {
  const [only] = navigationItems([turn('t', [user('u', 'Fix **it**'), reply('a', 'Done `x`', 'final_answer')])]);
  assert.deepEqual(only.find, { said: 'Fix **it**', replies: ['Done `x`'] });
  // an ending plan draws before any reply, and both are found
  const [planned] = navigationItems([turn('t', [user('u', 'Plan'), reply('a', 'Notes'), { id: 'p', type: 'plan', text: 'Step one' }])]);
  assert.deepEqual(planned.find, { said: 'Plan', replies: ['Step one', 'Notes'] });
  // a review card draws its findings, not its text
  const [reviewed] = navigationItems([turn('t', [user('u', 'Review'), { id: 'r', type: 'exitedReviewMode', review: 'All good' }])]);
  assert.deepEqual(reviewed.find, { said: 'Review', replies: [] });
  // an earlier follow-up's reply is folded into the work, so only the last prompt carries the reply
  const follow = navigationItems([turn('t', [user('u1', 'One'), reply('a1', 'First'), user('u2', 'Two'), reply('a2', 'Last')])]);
  assert.deepEqual(
    follow.map((e) => e.find),
    [
      { said: 'One', replies: [] },
      { said: 'Two', replies: ['Last'] },
    ],
  );
  // a turn with no reply yet finds none: "Working…" is the rail's placeholder, not a reply
  const [running] = navigationItems([{ ...turn('t', [user('u', 'Go')]), status: 'inProgress' }]);
  assert.deepEqual(running.find, { said: 'Go', replies: [] });
});

test("matches run oldest first across turns, each with its turn's jump entry and its place in that turn", () => {
  const turns = [
    turn('t1', [user('u1', 'Where is the cache?'), reply('a1', 'The **Cache** lives in `cache.ts`; cache it.', 'final_answer')]),
    turn('t2', [user('u2', 'thanks')]),
    turn('t3', [user('u3', 'And the  CACHE key?'), user('u4', 'cache'), reply('a3', 'cache')]),
    // a turn no one typed in has no prompt to jump to: nothing in it is found
    turn('t4', [reply('a4', 'cache')]),
  ];
  const matches = chatFindMatches(turns, '  Cache ');
  const [first] = navigationItems([turns[0]]);
  const [third] = navigationItems([turns[2]]);
  assert.deepEqual(matches, [
    { turnId: 't1', entryId: first.id, ordinal: 0 },
    { turnId: 't1', entryId: first.id, ordinal: 1 },
    { turnId: 't1', entryId: first.id, ordinal: 2 },
    { turnId: 't1', entryId: first.id, ordinal: 3 },
    { turnId: 't3', entryId: third.id, ordinal: 0 },
    { turnId: 't3', entryId: third.id, ordinal: 1 },
    { turnId: 't3', entryId: third.id, ordinal: 2 },
  ]);
  // runs of space match across a line break in the reply
  assert.equal(chatFindMatches([turn('t', [user('u', 'q'), reply('a', 'cache\nkey')])], 'cache key').length, 1);
  assert.deepEqual(chatFindMatches(turns, '   '), []);
  assert.deepEqual(chatFindMatches(turns, 'nowhere'), []);
});

test('the first match is the newest, and stepping goes round at either end', () => {
  const three = [{}, {}, {}] as any[];
  assert.equal(firstMatch(three), 2);
  assert.equal(firstMatch([]), -1);
  assert.equal(stepMatch(3, 2, 1), 0);
  assert.equal(stepMatch(3, 0, -1), 2);
  assert.equal(stepMatch(3, 1, 1), 2);
  assert.equal(stepMatch(0, 0, 1), -1);
});

test('a turn on screen counts what it draws, a wake counts only drawn, and a turn is recounted only when it changes', () => {
  const typed = turn('t1', [user('u1', 'cache'), reply('a1', 'cache')]);
  const wake = turn('w', [reply('a2', 'cache cache')]);
  assert.equal(chatFindMatches([typed, wake], 'cache').length, 2);
  const drawn = chatFindMatches(
    [typed, wake],
    'cache',
    new Map([
      ['t1', 1],
      ['w', 2],
    ]),
  );
  assert.deepEqual(drawn, [
    { turnId: 't1', entryId: navigationItems([typed])[0].id, ordinal: 0 },
    { turnId: 'w', entryId: null, ordinal: 0 },
    { turnId: 'w', entryId: null, ordinal: 1 },
  ]);
  // a streamed delta is a new turn object: only it is counted again
  const streamed = { ...typed, items: [typed.items[0], reply('a1', 'cache, cache')] };
  assert.equal(chatFindMatches([streamed, wake], 'cache').length, 3);
  assert.equal(chatFindMatches([typed], 'cach').length, 2);
});
