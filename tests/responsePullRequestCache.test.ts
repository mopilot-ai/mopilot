// A thread's pull request is read again on every refresh: each finished reply is parsed once, not on every read.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const real = await import('mdast-util-from-markdown');
let parses = 0;
mock.module('mdast-util-from-markdown', {
  exports: { ...real, fromMarkdown: (...args: Parameters<typeof real.fromMarkdown>) => (parses++, real.fromMarkdown(...args)) },
});
const { responsePullRequest } = await import('../src/lib/responsePullRequest.ts');

const url = 'https://github.com/org/repo/pull/42';
const reply = (text: string) => ({ status: 'completed', items: [{ type: 'agentMessage', text, phase: 'final_answer' }] });

test('a long thread re-read on every refresh parses each reply once; a new reply parses only itself', () => {
  const history = Array.from({ length: 50 }, (_, i) => reply(`Step ${i} done.`));
  const opened = reply(`Opened [PR #42](${url}). It is not merged yet.`);
  const turns = [...history, opened];
  assert.deepEqual(responsePullRequest(turns), { url, number: 42, state: 'open', source: 'response' });
  assert.equal(parses, 51);
  // the store keeps finished turns' objects: a refresh after the next reply parses that reply alone
  const merged = reply('PR #42 was merged.');
  assert.deepEqual(responsePullRequest([...turns, merged]), { url, number: 42, state: 'merged', source: 'response' });
  assert.equal(parses, 52);
  // a reply read again from history (new objects) is parsed again, with the same answer
  assert.deepEqual(responsePullRequest([reply(`Opened [PR #42](${url}). It is not merged yet.`)]), {
    url,
    number: 42,
    state: 'open',
    source: 'response',
  });
  assert.equal(parses, 53);
  // a reply whose text changed in place is parsed again, so its new words count
  merged.items[0].text = `Opened [PR #42](${url}). It is not merged yet.`;
  assert.equal(responsePullRequest([...turns, merged])?.state, 'open');
  assert.equal(parses, 54);
});
