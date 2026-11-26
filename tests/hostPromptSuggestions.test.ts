// The remote Host's predictions are live state and survive reconnects within the current Host process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chatStateOf } from '../host/src/chatState.mjs';
import { createSessionJournal } from '../host/src/sessionJournal.mjs';
import { createStreamHub } from '../host/src/stream.mjs';
import { CHAT, FakeItems, createRemoteChats, end, fakeHost, start, text } from './support/host/remoteChatsKit.ts';
import { waitFor } from './support/waitFor.ts';
import { deferred } from './support/async-scenarios.ts';

test('a Host sends the current suggestion through the state lane, and a reconnect clears an offer from the old Host', async () => {
  const current = chatStateOf({ kind: 'state', chatId: 'claude:c1', patch: { promptSuggestion: 'Check the patch.' } });
  const offered = { t: 'state', patch: current?.patch };
  assert.deepEqual(offered.patch, { promptSuggestion: 'Check the patch.' });
  assert.equal(chatStateOf({ kind: 'state', chatId: 'c', patch: { promptSuggestion: [] } }), null);
  const items = new FakeItems();
  const host = fakeHost();
  const session = { promptSuggestion: null as string | null };
  const chats = createRemoteChats({
    items,
    hostFor: () => host,
    ownerOf: () => ({ hostId: 'm1', folder: '/srv/work' }),
    emit: () => undefined,
    state: () => ({ has: () => true, get: () => session, patch: (_id: string, patch: object) => Object.assign(session, patch) }),
    report: () => undefined,
  });
  const reply = { snapshot: { rev: 0, items: [] }, patches: null, generation: 'g1', inflight: [] };
  host.reply = { ...reply, chatState: offered.patch };
  try {
    await chats.follow(CHAT);
    await chats.settled(CHAT);
    assert.equal(session.promptSuggestion, 'Check the patch.');
    host.fire.resync(CHAT, reply.snapshot);
    await chats.settled(CHAT);
    assert.equal(session.promptSuggestion, 'Check the patch.', 'a journal-only resync leaves the independent state lane alone');
    host.fire.frame(CHAT, { t: 'state', patch: { promptSuggestion: [] } });
    await chats.settled(CHAT);
    assert.equal(session.promptSuggestion, 'Check the patch.');
    host.fire.frame(CHAT, { t: 'state', patch: { promptSuggestion: null } });
    await chats.settled(CHAT);
    assert.equal(session.promptSuggestion, null);
    host.fire.frame(CHAT, offered);
    await chats.settled(CHAT);
    assert.equal(session.promptSuggestion, 'Check the patch.');
    host.reply = { ...reply, generation: 'restarted' };
    host.fire.state('offline');
    assert.equal(session.promptSuggestion, null, 'the offer is withdrawn before reconnect starts');
    host.fire.frame(CHAT, offered);
    const oldReply = deferred<unknown>();
    host.reply = oldReply.promise;
    const subscriptions = host.asked.length;
    host.fire.state('online');
    await waitFor(() => host.asked.length > subscriptions, 'the subscribe is in flight');
    assert.equal(session.promptSuggestion, null, 'a frame received offline cannot restore the offer after reconnect begins');
    host.fire.closed(CHAT, 'session_journal_budget');
    oldReply.resolve({
      ...reply,
      snapshot: { rev: 3, items: [start(), text('Saved response before the fault.'), end()] },
      chatState: offered.patch,
    });
    await chats.settled(CHAT);
    assert.equal(session.promptSuggestion, null, 'the late subscribe answer cannot restore an offer after the stream closes');
    assert.match(JSON.stringify(items.records), /Saved response before the fault/, 'the same answer still applies committed history');
    host.reply = { ...reply, generation: 'restarted' };
    host.fire.state('offline');
    host.fire.state('online');
    await chats.settled(CHAT);
    assert.equal(session.promptSuggestion, null);
    host.fire.frame(CHAT, offered);
    await chats.settled(CHAT);
    assert.equal(session.promptSuggestion, 'Check the patch.');
    host.fire.frame(CHAT, offered);
    host.fire.closed(CHAT, 'session_journal_deleted');
    assert.equal(session.promptSuggestion, null, 'the chat stream can close without disconnecting the Host');
    host.fire.frame(CHAT, offered);
    await chats.settled(CHAT);
    assert.equal(session.promptSuggestion, null, 'queued or subsequent frames for the closed subscription are ignored');
    assert.equal(JSON.stringify(items.records).includes('Check the patch.'), false);

    const disposedReply = deferred<unknown>();
    host.reply = disposedReply.promise;
    const beforeDisposal = host.asked.length;
    host.fire.state('offline');
    host.fire.state('online');
    await waitFor(() => host.asked.length > beforeDisposal, 'the last subscribe is in flight');
    const pending = chats.settled(CHAT);
    chats.dispose();
    disposedReply.resolve({
      ...reply,
      snapshot: { rev: 3, items: [start(), text('Response after disposal.'), end()] },
      chatState: offered.patch,
    });
    await pending;
    assert.doesNotMatch(JSON.stringify(items.records), /Response after disposal/);
    assert.equal(session.promptSuggestion, null);
  } finally {
    chats.dispose();
  }
});

test('the Host keeps predictions in Hello while live and excludes them from journal recovery', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-journal-'));
  const make = () => createStreamHub({ storage: createSessionJournal({ dataDir }), snapshot: () => ({ rev: 0 }), epoch: () => 1 });
  const hub = make();
  hub.state('c', { promptSuggestion: 'Review the result.' });
  hub.state('c', { promptSuggestion: 'Run the test.', plan: false });
  assert.deepEqual(hub.current('c'), { promptSuggestion: 'Run the test.', plan: false });
  assert.deepEqual(make().current('c'), { plan: false });
});
