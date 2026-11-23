// Window deep links: the chat id travels URI-encoded in the hash (see src/lib/deepLink.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentFromHash, agentHash, threadFromHash, threadHash } from '../src/lib/deepLink.ts';

test('ids round-trip, including reserved characters', () => {
  for (const id of ['019a-b', 'claude:abc', 'acp:kimi:s/1?x=1&y=2#z', 'a b%c']) {
    assert.equal(threadFromHash('#' + threadHash(id)), id);
  }
});

test('plain and prefixed hashes parse', () => {
  assert.equal(threadFromHash('#thread=abc'), 'abc');
  assert.equal(threadFromHash('thread=abc&x=1'), 'abc');
  assert.equal(threadFromHash('#x=1&thread=acp%3Akimi%3A1'), 'acp:kimi:1');
});

test('no thread, empty or undecodable hashes give null', () => {
  assert.equal(threadFromHash(''), null);
  assert.equal(threadFromHash('#mini'), null);
  assert.equal(threadFromHash('#thread='), null);
  assert.equal(threadFromHash('#thread=%E0%A4%A'), null);
});

test('only an exact thread parameter can select a chat', () => {
  for (const hash of ['#notthread=abc', '#return=thread=abc', '#x=1&mythread=abc', 'otherthread=abc']) {
    assert.equal(threadFromHash(hash), null, hash);
  }
  assert.equal(threadFromHash('#notthread=wrong&thread=right'), 'right');
});

test('a sub-agent window hash names the chat, the agent and its title, and round-trips reserved characters', () => {
  const hash = agentHash('claude:abc', 'toolu_01/x?y&z', 'Track A: fix #1');
  assert.equal(threadFromHash(`#${hash}`), 'claude:abc');
  assert.deepEqual(agentFromHash(`#${hash}`), { key: 'toolu_01/x?y&z', title: 'Track A: fix #1' });
  // a window for a chat alone names no agent; a missing title reads Agent; an undecodable key is no agent
  assert.equal(agentFromHash(`#${threadHash('abc')}`), null);
  assert.deepEqual(agentFromHash('#thread=abc&agent=k1'), { key: 'k1', title: 'Agent' });
  assert.equal(agentFromHash('#thread=abc&agent=%E0%A4%A'), null);
  assert.equal(agentFromHash('#thread=abc&notagent=k1'), null);
});

test('an agent title with unpaired UTF-16 units cannot prevent opening its window', () => {
  const hash = agentHash('acp:kimi:chat', 'agent-key', 'Track \ud800/\udfff 😺');
  assert.equal(threadFromHash(hash), 'acp:kimi:chat');
  assert.deepEqual(agentFromHash(hash), { key: 'agent-key', title: 'Track �/� 😺' });
});
