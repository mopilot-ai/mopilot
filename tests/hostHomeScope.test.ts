// Who sees a chat a MoMo home started on this Host (host/src/chatScope.mjs): the owner's own devices see it in the chat list and its events like any chat, with the home's name on the row only for a client that reads names; the home itself sees only what it started, and a client of a kind this Host does not name sees none of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { chatScopeOf } from '../host/src/chatScope.mjs';

const who = (kind: string, fingerprint: string) => ({ principal: () => ({ kind, fingerprint, name: kind }) });
const row = { byFp: 'h'.repeat(64) };

test('a chat a home started: the owner devices see it, the home sees only its own, any other kind sees none', () => {
  const scope = (kind: string, fp: string) => chatScopeOf(undefined)(who(kind, fp));
  for (const owner of ['desktop', 'phone', 'cli']) assert.equal(scope(owner, 'o'.repeat(64)).sees('claude:t1', row), true, owner);
  // the home reads its own rows and no other
  assert.equal(scope('home', 'h'.repeat(64)).sees('claude:t1', row), true);
  assert.equal(scope('home', 'x'.repeat(64)).sees('claude:t1', row), false);
  assert.equal(scope('home', 'h'.repeat(64)).sees('claude:owner-chat', { byFp: 'o'.repeat(64) }), false);
  assert.equal(scope('home', 'h'.repeat(64)).sees('claude:owner-chat'), false);
  assert.equal(scope('robot', 'r'.repeat(64)).sees('claude:t1', row), false);
  // whose name a row carries: a desktop or the CLI reads every name, a phone only its own, a home only its own
  assert.equal(scope('desktop', 'o'.repeat(64)).names(row), true);
  assert.equal(scope('phone', 'o'.repeat(64)).names(row), false);
  assert.equal(scope('home', 'h'.repeat(64)).names(row), true);
  assert.equal(scope('home', 'x'.repeat(64)).names(row), false);
});
