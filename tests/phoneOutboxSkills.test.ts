// A message's skills (a Codex chat's / menu) wait with the message, go with it, are read back after the app closed as names the computer would take, and are copied into the snapshot the screens see.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOutbox, restoreItems, type QueuedSend } from '../mobile/src/outbox.ts';
import { phoneSnapshot } from '../mobile/src/snapshot.ts';

const now = 1_000_000;
const saved = (extra: object) => ({
  id: 'send-0001',
  pairId: 'p1',
  chatId: 'c1',
  text: 'hi',
  attachments: [],
  at: now - 1000,
  status: 'queued',
  error: null,
  ...extra,
});

test('a message keeps its skills until the computer takes it, and has none when none were picked', async () => {
  const sent: QueuedSend[] = [];
  const changes: QueuedSend[][] = [];
  const box = createOutbox({
    online: () => false,
    send: async (item) => void sent.push(item),
    lost: () => false,
    idempotent: () => true,
    ready: async () => true,
    newId: () => `send-${changes.length}-id`,
    now: () => now,
    onChange: (items) => changes.push(items),
  });
  box.add({ pairId: 'p1', chatId: 'c1', text: 'with', attachments: [], skills: ['pdf'] });
  box.add({ pairId: 'p1', chatId: 'c1', text: 'without', attachments: [] });
  const [withSkills, without] = changes.at(-1)!;
  assert.deepEqual(withSkills.skills, ['pdf']);
  assert.equal('skills' in without, false);
});

test('skills read back after the app closed are the names the computer takes, at most ten, and the message is still waiting', () => {
  const pairs = new Set(['p1']);
  const names = Array.from({ length: 12 }, (_, i) => `skill-${i}`);
  const [kept, junk, none, many] = restoreItems(
    [
      saved({ skills: ['pdf', 'frontend-design'] }),
      saved({ id: 'send-0002', skills: ['ok', 7, '', 'has space', 'x'.repeat(101), null] }),
      saved({ id: 'send-0003', skills: 'pdf' }),
      saved({ id: 'send-0004', skills: names }),
    ],
    { now, pairs },
  );
  assert.deepEqual(kept.skills, ['pdf', 'frontend-design']);
  assert.equal(kept.status, 'queued');
  assert.deepEqual(junk.skills, ['ok']);
  assert.equal('skills' in none, false);
  assert.deepEqual(many.skills, names.slice(0, 10));
  assert.equal('skills' in restoreItems([saved({})], { now, pairs })[0], false);
});

test('the snapshot copies a message’s skills, so a screen cannot change the queue', () => {
  const item: QueuedSend = {
    id: 'i',
    pairId: 'p',
    chatId: 'c',
    text: 't',
    attachments: [],
    skills: ['pdf'],
    at: 1,
    status: 'queued',
    error: null,
  };
  const state: any = {
    phase: 'online',
    user: null,
    pairs: [],
    presence: {},
    reconnect: null,
    outbox: [item, { ...item, id: 'j', skills: undefined }],
    safetyNumber: null,
  };
  const shown = phoneSnapshot(state).outbox;
  assert.deepEqual(shown[0].skills, ['pdf']);
  assert.notEqual(shown[0].skills, item.skills);
  assert.equal(shown[1].skills, undefined);
});
