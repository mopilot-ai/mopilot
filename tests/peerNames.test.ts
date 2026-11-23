// A message from another chat says who sent it by name everywhere (#3364 follow-up): main keeps both titles with the
// message, so the transcript, queue row, card, notification and the receiving agent's prompt never fall back to a raw id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { peerPrompt } from '../shared/peerPrompt.mjs';
import { isUserQueued, peerQueued, queuedLabel } from '../src/lib/queued.ts';
import { userQueued } from '../src/harness/switchPlan.ts';

const require = createRequire(import.meta.url);
const { PeerRuntime } = require('../electron/session/peerRuntime.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { createPeerNotices } = require('../electron/app/peerNotices.cjs');

function setup(t: any, titles?: () => Promise<Map<string, string>>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-names-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sent: any[] = [];
  const runtime = new PeerRuntime({
    file: path.join(dir, 'journal.json'),
    controller: {
      rt: () => ({ token: null }),
      state: { get: () => ({ turn: 'idle' }) },
      send: (id: string, item: any) => sent.push([id, item]),
      peerCapabilities: () => ({ messaging: true, read: true, steer: false }),
    },
    chats: {
      records: new Map([
        ['A', { segments: [{ kind: 'claude', nativeId: 'a' }], meta: {} }],
        ['B', { segments: [{ kind: 'codex', nativeId: 'b' }], meta: {} }],
      ]),
    },
    registry: new Registry(),
    sourceWindow: () => null,
    gate: () => null,
    read: () => ({}),
    ...(titles ? { titles } : {}),
  });
  return { runtime, sent };
}
const ask = { targetChatId: 'B', requestId: 'r1', body: 'Which screens first?' };

test('a message keeps both chats’ titles, and its queued item and prompt say who sent it', async (t) => {
  const { runtime, sent } = setup(
    t,
    async () =>
      new Map([
        ['A', 'MoMo开发'],
        ['B', 'iOS redesign'],
      ]),
  );
  const m = await runtime.service.send('A', ask);
  assert.equal(m.sourceTitle, 'MoMo开发');
  assert.equal(m.targetTitle, 'iOS redesign');
  assert.deepEqual(sent[0][1].peer, { messageId: m.id, sourceChatId: 'A', sourceTitle: 'MoMo开发', body: ask.body });
  assert.match(sent[0][1].text, /"sourceTitle":"MoMo开发"/);
});

test('with no title known, or the lists failing, the message still goes, and its prompt names no title', async (t) => {
  for (const titles of [undefined, async () => Promise.reject(new Error('lists down'))]) {
    const { runtime, sent } = setup(t, titles);
    const m = await runtime.service.send('A', ask);
    assert.equal(m.sourceTitle, null);
    assert.doesNotMatch(peerPrompt(m), /sourceTitle/);
    assert.equal(sent.length, 1);
  }
});

test('one read of the titles per send, and a list that never answers holds a send for at most a moment', async (t) => {
  let reads = 0;
  const { runtime } = setup(t, async () => (reads++, new Map([['A', 'Named']])));
  assert.equal((await runtime.service.send('A', ask)).sourceTitle, 'Named');
  assert.equal(reads, 1);
  const stalled = setup(t, () => new Promise(() => {}));
  const started = Date.now();
  const m = await stalled.runtime.service.send('A', ask);
  assert.equal(m.sourceTitle, null);
  assert.equal(m.delivery, 'queued');
  assert.ok(Date.now() - started < 5000);
});

test('the queue row reads who sent it, never the prompt, and is not the user’s to edit', () => {
  const peer = { messageId: 'm', sourceChatId: 'A', sourceTitle: 'Kept title', body: 'Hello' };
  const q: any = { id: 'm', text: 'A message from another MoPilot chat follows…', attachments: [], opts: {}, peer };
  // what the window calls it now, else the title kept with the message, else no id
  assert.deepEqual(peerQueued(peer, 'Live title'), { label: 'Received message from Live title', body: 'Hello' });
  assert.equal(peerQueued(peer, null).label, 'Received message from Kept title');
  const bare = { messageId: 'm', sourceChatId: 'A' };
  assert.deepEqual(peerQueued(bare, null), { label: 'Received message from another session', body: '' });
  assert.equal(queuedLabel(q, null, peerQueued(peer, null)), 'Received message from Kept title');
  assert.equal(isUserQueued(q), false);
  assert.equal(isUserQueued({ id: 'x' } as any), true);
  // a harness switch gives back the user's own messages only: this one stays queued, not as raw prompt in the composer
  assert.deepEqual(userQueued([q, { id: 'x' } as any]), [{ id: 'x' }]);
});

test('a notification uses the kept titles, for a sender on any harness', () => {
  const notes: any[] = [];
  const notices = createPeerNotices({
    broadcastAll: () => {},
    chatInView: () => true,
    chats: { records: new Map() },
    notifier: () => ({ notify: (_k: string, _id: string, n: any) => notes.push([n.title, n.chatTitle]) }),
    chatName: () => null,
  });
  notices.start({ messages: [] });
  const m = {
    id: 'm',
    sourceChatId: 'A',
    targetChatId: 'B',
    body: 'Hi',
    delivery: 'delivered',
    sourceTitle: 'MoMo开发',
    targetTitle: 'iOS',
  };
  notices.publish({ messages: [m] });
  assert.deepEqual(notes, [['Message from MoMo开发', 'iOS']]);
});
