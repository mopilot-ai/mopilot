// Window-generation audio draft fragments recover independently and retain durable bytes across failed writes and transfers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createAudioOwnership } = require('../electron/platform/audioOwnership.cjs');
const { createAudioPending } = require('../electron/platform/audioPending.cjs');

function world(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = 10_000_000;
  const pending = createAudioPending(
    () => root,
    () => now,
  );
  const collected: any[] = [];
  const host: any = {
    audioPending: pending,
    audioDispatch: { list: () => [], remove() {} },
    items: { listAsync: async () => [], audioRefs: async () => [] },
  };
  const own = createAudioOwnership(
    () => root,
    { collect: (...args: any[]) => collected.push(args) },
    host,
    { all: () => [] },
    () => now,
  );
  return {
    root,
    pending,
    own,
    host,
    collected,
    advance: () => {
      now += 3_600_001;
    },
  };
}
const draft = (text: string, file = '/audio.wav', goal = false) => ({
  text,
  attachments: [{ kind: 'audio', path: file }],
  ...(goal ? { goal } : {}),
});

test('live pages keep separate drafts; old-generation closure cannot orphan a replacement page’s fragments', async (t) => {
  const w = world(t);
  w.own.set('chat', draft('First'), 'old-document');
  w.own.set('chat', draft('Second', '/second.wav'), 'other-window');
  assert.deepEqual(w.own.drafts('replacement-document'), {});
  assert.equal(w.own.drafts('other-window').chat.text, 'Second');
  w.own.close('old-document');
  assert.equal(w.own.drafts('replacement-document').chat.text, 'First');
  w.own.set('chat', draft('Replacement'), 'replacement-document');
  w.own.close('old-document');
  assert.deepEqual(w.own.drafts('third-window'), {});
  assert.equal(w.own.drafts('replacement-document').chat.text, 'Replacement');
  await w.own.collect();
  assert.match(JSON.stringify(w.collected), /second.wav/);
});

test('preserved transfers recover once as editable input; close and restart merge exact distinct fragments', (t) => {
  const w = world(t);
  const transfer = w.pending.hold('chat', draft('Recorded', '/clip.wav', true), null, 'old');
  w.pending.finishTransfer(transfer, true);
  assert.deepEqual(w.own.drafts('other'), {});
  w.own.close('old');
  w.own.set('chat', draft('Existing'), 'other');
  const recovered = w.own.drafts('other').chat;
  assert.equal(recovered.text, 'Existing\n\nRecorded');
  assert.equal(recovered.goal, true);
  assert.equal(recovered.attachments.length, 2);
  assert.equal(w.pending.list()[0].phase, 'released');
  assert.deepEqual(w.own.drafts('other').chat, recovered);
  w.own.set('chat', recovered, 'second');
  const restarted = createAudioOwnership(() => w.root, {}, { ...w.host, audioPending: undefined }, {});
  assert.equal(restarted.drafts('new').chat.text, 'Existing\n\nRecorded');
  assert.equal(restarted.drafts('new').chat.attachments.length, 2);
  w.advance();
  w.pending.prune();
  assert.equal(w.pending.list().length, 0);
});

test('failed clear/write retains both persisted and in-memory audio references; retry replaces the correct fragment', async (t) => {
  const w = world(t);
  w.own.set('chat', draft('Persisted', '/old.wav'), 'page');
  const fail = t.mock.method(fs, 'writeFileSync', () => {
    throw new Error('disk full');
  });
  assert.throws(() => w.own.set('chat', draft('Unsaved', '/new.wav'), 'page'), /disk full/);
  await w.own.collect();
  assert.match(JSON.stringify(w.collected), /old.wav/);
  assert.match(JSON.stringify(w.collected), /new.wav/);
  assert.throws(() => w.own.set('chat', { text: '', attachments: [] }, 'page'), /disk full/);
  await w.own.collect();
  assert.match(JSON.stringify(w.collected.at(-1)), /old.wav/);
  fail.mock.restore();
  w.own.set('chat', draft('Retry', '/retry.wav'), 'page');
  assert.equal(w.own.drafts('page').chat.text, 'Retry');
  assert.throws(() => w.own.set('', draft('bad')), /Invalid audio/);
  assert.throws(() => w.own.set('chat', null), /Invalid audio/);
});

test('unknown file versions remain unchanged and cannot be overwritten or collected', async (t) => {
  const w = world(t);
  for (const name of ['audio-drafts.json', 'audio-pending.json']) fs.writeFileSync(path.join(w.root, name), '{"version":42}');
  const own = createAudioOwnership(() => w.root, {}, w.host, {});
  assert.throws(() => own.drafts(), /newer version/);
  assert.throws(() => own.set('chat', draft('unsaved')), /newer version/);
  assert.throws(() => own.delete('chat', []), /newer version/);
  await assert.rejects(own.collect(), /newer version/);
  const pending = createAudioPending(() => w.root);
  assert.throws(() => pending.list(), /newer version/);
  assert.throws(() => pending.hold('chat', draft('unsaved')), /newer version/);
  for (const name of ['audio-drafts.json', 'audio-pending.json'])
    assert.equal(fs.readFileSync(path.join(w.root, name), 'utf8'), '{"version":42}');
});

test('restart does not recover released transfers as prompts or drafts', (t) => {
  const w = world(t);
  const id = w.pending.hold('chat', draft('Discarded'));
  w.pending.finishTransfer(id);
  w.pending.recover({ state: {} }, w.host.audioDispatch);
  assert.deepEqual(w.pending.recovered('new'), []);
});

test('certified chat deletion removes prepared audio by draft key while retaining an unrelated transfer', (t) => {
  const w = world(t);
  w.pending.hold('chat', draft('Delete'));
  w.pending.hold('other', draft('Keep'));
  w.own.set('chat', draft('Delete'));
  w.own.delete('chat', ['native']);
  assert.equal(w.pending.list().length, 1);
  assert.equal(w.pending.list()[0].key, 'other');
  assert.deepEqual(w.own.drafts(), {});
});
