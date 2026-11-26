// The computer a chat is kept under (its rows, its saved history, its draft, the list): the connected one, else the last used, else the one being waited for, else the only one paired, so a chat opened at launch with its computer away finds what was saved for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// the path is a variable, so the root typecheck does not take the whole phone app in with this file
const listPath = '../mobile/src/useChatList';
const { chatPairOf, chatListKey } = await import(listPath);

const pair = (pairId: string) => ({ pairId });

test('the connected computer wins, then the last one used, then the one being waited for, then the only one paired, else none', () => {
  const two = [pair('p'), pair('q')];
  assert.equal(chatPairOf({ selectedPair: 'p', pairs: two, reconnect: { pairId: 'q' } }, 'q'), 'p');
  assert.equal(chatPairOf({ selectedPair: null, pairs: two, reconnect: { pairId: 'q' } }, 'p'), 'p');
  // a launch with the computer away: nothing was connected yet, so the one being waited for is where the chat was saved
  assert.equal(chatPairOf({ selectedPair: null, pairs: two, reconnect: { pairId: 'q' } }, null), 'q');
  assert.equal(chatPairOf({ selectedPair: null, pairs: [pair('p')], reconnect: null }, null), 'p');
  assert.equal(chatPairOf({ selectedPair: null, pairs: [pair('p')] }, null), 'p', 'a snapshot without reconnect');
  assert.equal(chatPairOf({ selectedPair: null, pairs: two, reconnect: null }, null), null, 'two computers and none known: no guess');
  assert.equal(chatPairOf({ selectedPair: null, pairs: [], reconnect: null }, null), null);
});

test('the list is kept under the same computer as its chats', () => {
  const state = { user: { id: 'u' }, selectedPair: null, pairs: [pair('p'), pair('q')], reconnect: { pairId: 'q' } };
  assert.equal(chatListKey(state, null), JSON.stringify(['u', 'q']));
  assert.equal(chatListKey({ ...state, user: null }, 'p'), JSON.stringify([undefined, 'p']));
});
