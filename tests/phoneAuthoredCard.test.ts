// A message MoPilot wrote into the chat shows on the phone as a one-line card that opens on a tap, never as a user bubble of envelope text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, click } from './support/phone/component-kit';
import { familyMessageText } from '../shared/sideSessions.mjs';
import { peerPrompt } from '../shared/peerPrompt.mjs';
const bubblePath = '../mobile/src/components/MessageBubble';
const cardPath = '../mobile/src/components/AuthoredCard';
const { MessageBubble } = await import(bubblePath);
const { authoredCardOf } = await import(cardPath);

async function render(role: string, text: string) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MessageBubble, { role, text })));
  return {
    host,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('a family message is a one-line card; a tap shows its text and no envelope text ever shows', async () => {
  const text = familyMessageText({
    fromName: 'fix-build',
    fromId: 'c1',
    relation: 'child',
    body: 'All green.',
  });
  const { host, done } = await render('user', text);
  assert.match(host.textContent ?? '', /Received message from fix-build/);
  assert.doesNotMatch(host.textContent ?? '', /mopilot-side-session-message|All green/);
  await click('MoPilot: Received message from fix-build');
  assert.match(host.textContent ?? '', /All green\./);
  assert.doesNotMatch(host.textContent ?? '', /mopilot-side-session-message/);
  await done();
});

test('a peer message and a live (not yet saved) one are cards; a card with no body has nothing to open', async () => {
  const peer = peerPrompt({
    id: 'm',
    sourceChatId: 's',
    sourceTitle: 'Docs',
    replyTo: null,
    body: 'ping',
    reply: 'none',
  });
  const a = await render('liveUser', peer);
  assert.match(a.host.textContent ?? '', /Received message from Docs/);
  await a.done();
  const b = await render('user', "The user hasn't heard from you in a while — say in a few words what you're doing, then continue.");
  assert.match(b.host.textContent ?? '', /Progress check/);
  await b.done();
});

test('a person’s words, and the assistant’s, keep their bubble', async () => {
  assert.equal(authoredCardOf('please fix the build'), null);
  const mine = await render('user', 'please fix the build');
  assert.match(mine.host.textContent ?? '', /please fix the build/);
  await mine.done();
  const reply = await render(
    'assistant',
    familyMessageText({
      fromName: 'x',
      fromId: 'y',
      relation: 'parent',
      body: 'z',
    }),
  );
  assert.doesNotMatch(reply.host.textContent ?? '', /Received message/);
  await reply.done();
});
