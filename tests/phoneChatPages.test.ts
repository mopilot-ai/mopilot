// The recent-chats pages the phone reads and joins: what a Mac's answer must look like, and how a next page lands on the chats shown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// a variable path keeps the phone's React Native typings out of the root TypeScript program
const chatPagesPath = '../mobile/src/chatPages.ts';
const { appendChats, CHAT_PAGE, chatPage } = await import(chatPagesPath);

test('a page is a list of chats with ids; `more` is true only when the Mac says true', () => {
  assert.equal(CHAT_PAGE, 50);
  assert.deepEqual(chatPage({ chats: [{ id: 'a' }], more: true }), { chats: [{ id: 'a' }], more: true });
  for (const more of [undefined, false, 1, 'yes', null]) assert.equal(chatPage({ chats: [], more }).more, false, `more ${String(more)}`);
  for (const bad of [null, undefined, 'x', {}, { chats: 'a' }, { chats: [null] }, { chats: [{ title: 'no id' }] }, { chats: [{ id: 7 }] }])
    assert.throws(() => chatPage(bad), /Could not read chats\./, JSON.stringify(bad));
});

test('the next page joins the chats shown: a chat in both keeps its first place and its newest data, and a cleared list starts over', () => {
  const a = { id: 'a', title: 'A' };
  const b = { id: 'b', title: 'B' };
  const b2 = { id: 'b', title: 'B renamed' };
  const c = { id: 'c', title: 'C' };
  assert.deepEqual(appendChats([a, b], [b2, c]), [a, b2, c]);
  assert.deepEqual(appendChats([a], []), [a]);
  assert.deepEqual(appendChats(null, [c]), [c]);
  const shown = [a, b];
  appendChats(shown, [c]);
  assert.deepEqual(shown, [a, b], 'the list shown is not changed in place');
});
