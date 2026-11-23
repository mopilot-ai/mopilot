// Audio transfer and queued-input ownership survive GC, chat creation and restart without automatically replaying a native task.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { encodeWav } from '../src/lib/dictation.ts';
import { setup, selectSegment } from './support/controller/fixture.ts';
const require = createRequire(import.meta.url);
const { createAudioPending } = require('../electron/platform/audioPending.cjs');
const { createAudioDispatch } = require('../electron/platform/audioDispatch.cjs');
const { createAudioAssets } = require('../electron/platform/audioAssets.cjs');
const { createAudioOwnership } = require('../electron/platform/audioOwnership.cjs');
function world(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-pending-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let time = 10_000_000;
  const pending = createAudioPending(
    () => dir,
    () => time,
  );
  const journal = createAudioDispatch(() => path.join(dir, 'dispatch'));
  return {
    dir,
    pending,
    journal,
    advance: () => {
      time += 3_600_001;
    },
  };
}

test('a one-day-old audio draft transfers before clearing, survives slow chat creation and recovers after restart', async (t) => {
  const w = world(t);
  const assets = createAudioAssets(() => path.join(w.dir, 'assets'));
  const a = assets.save(encodeWav(new Float32Array(16), 16000));
  fs.utimesSync(a.path, 0, 0);
  const host = { audioPending: w.pending, audioDispatch: w.journal, items: { listAsync: async () => [], audioRefs: async () => [] } };
  const own = createAudioOwnership(() => w.dir, assets, host, { all: () => [] });
  const draft = { text: 'Process this', attachments: [a] };
  own.set('home', draft);
  const transfer = w.pending.hold('home', draft);
  own.set('home', { text: '', attachments: [] });
  await own.collect();
  assert.equal(fs.existsSync(a.path), true);
  const restarted = createAudioPending(() => w.dir);
  restarted.recover({ state: { get: () => ({ queue: [] }), patch() {} } }, w.journal);
  assert.equal(restarted.recovered(0)[0].draft.text, 'Process this');
  w.pending.finishTransfer('missing');
  w.pending.finishTransfer(transfer);
  w.advance();
  await own.collect();
  assert.equal(fs.existsSync(a.path), false, 'abandoned prepared transfers expire after a protected handoff interval');
});

test('queued audio is durable before receipt, restores for explicit review, and hands off exactly once to the dispatch journal', async (t) => {
  const w = world(t),
    c = setup();
  selectSegment(c.c, c.chats, 'chat', [['acp:fake', 'native']]);
  c.c.audioPending = w.pending;
  c.state.patch('chat', { turn: 'running' });
  const attachments = [{ kind: 'audio', path: '/saved.wav', name: 'Audio message' }];
  const transfer = w.pending.hold('home', { text: 'Listen', attachments });
  const receipt = await c.c.send('chat', { text: 'Listen', attachments, opts: { audioTransfer: transfer } }, 1, true);
  assert.equal(receipt.action, 'queued');
  w.pending.finishTransfer(transfer);
  assert.equal(w.pending.list()[0].phase, 'queued');
  assert.equal(c.c.sendNow('chat', receipt.id, 1, true).status, 'queued');
  assert.equal(w.pending.list()[0].phase, 'queued', 'Send now on busy ACP keeps its durable owner');
  const restarted = setup();
  selectSegment(restarted.c, restarted.chats, 'chat', [['acp:fake', 'native']]);
  const restored = createAudioPending(() => w.dir);
  restarted.c.audioPending = restored;
  restored.recover(restarted.c, w.journal);
  restored.recover(restarted.c, w.journal);
  assert.equal(restarted.s('chat').queue.length, 1);
  assert.equal(restarted.s('chat').queue[0].waitingFor, 'audioRecovery');
  restarted.c.drain('chat');
  assert.equal(restarted.execs.length, 0);
  const item = restarted.s('chat').queue[0];
  restarted.c.removeQueued('chat', item.id);
  assert.equal(restored.list()[0].phase, 'released');
  restored.admit('chat', item);
  assert.equal(restored.list()[0].phase, 'queued');
  w.journal.begin('native', item.id, [], 1);
  restored.recover(restarted.c, w.journal);
  assert.equal(restored.list().length, 0, 'a dispatched intent belongs to history, not the recoverable queue');
  restored.dispatched('missing');
  assert.throws(() => restored.admit('chat', { id: 'new', attachments, opts: { audioTransfer: transfer } }), /expired/);
  restored.admit('chat', { id: 'background', text: 'Listen', attachments, opts: {} });
  restored.delete('chat');
  assert.equal(restored.list().length, 0);
  restored.admit('chat', { id: 'text', attachments: [], opts: {} });
  assert.throws(() => restored.hold('home', { attachments: [] }), /No audio/);
});

test('Send now retains queued durability without a second write; failed Remove cannot consume its visible or durable input', async (t) => {
  const w = world(t),
    c = setup();
  selectSegment(c.c, c.chats, 'chat', [['acp:fake', 'native']]);
  c.c.audioPending = w.pending;
  c.state.patch('chat', { turn: 'running' });
  const receipt = await c.c.send('chat', { text: '', attachments: [{ kind: 'audio', path: '/saved.wav' }] }, 1, true);
  const fail = t.mock.method(fs, 'writeFileSync', () => {
    throw new Error('disk full');
  });
  assert.equal(c.c.sendNow('chat', receipt.id, 1, true).status, 'queued');
  assert.equal(fail.mock.callCount(), 0, 'dequeue-for-send retains the existing durable owner');
  assert.throws(() => c.c.removeQueued('chat', receipt.id), /disk full/);
  assert.equal(c.s('chat').queue.length, 1);
  assert.equal(w.pending.list()[0].phase, 'queued');
});

test('main refuses changed recipient/account/model claims before queue admission', (t) => {
  const w = world(t);
  let current = false;
  const pending = createAudioPending(
    () => w.dir,
    Date.now,
    () => current,
  );
  const attachments = [{ kind: 'audio', path: '/saved.wav' }];
  const id = pending.hold('home', { text: '', attachments }, { owner: 'original' });
  const item = { id: 'intent', text: '', attachments, opts: { audioTransfer: id } };
  assert.throws(() => pending.admit('replacement', item), /account, model or recipient changed/);
  assert.equal(pending.list()[0].phase, 'prepared');
  current = true;
  pending.admit('original', item);
  assert.equal(pending.list()[0].phase, 'queued');
});

test('retiring a document blocks its late transfer even when the recovery write fails, while preserving media ownership', (t) => {
  const w = world(t);
  const draft = { text: 'Review this recording', attachments: [{ kind: 'audio', path: '/keep.wav' }] };
  const transfer = w.pending.hold('chat', draft, null, 'retired-document');
  const fail = t.mock.method(fs, 'writeFileSync', () => {
    throw new Error('disk full');
  });
  assert.throws(() => w.pending.close('retired-document'), /disk full/);
  assert.equal(w.pending.list()[0].phase, 'recovered');
  assert.deepEqual(w.pending.recovered('replacement-document')[0].draft, draft);
  assert.throws(
    () => w.pending.admit('chat', { id: 'late', text: draft.text, attachments: draft.attachments, opts: { audioTransfer: transfer } }),
    /expired/,
  );
  fail.mock.restore();
  const restarted = createAudioPending(() => w.dir);
  restarted.recover({ state: {} }, w.journal);
  assert.deepEqual(restarted.recovered('new-document')[0].draft, draft);
});

test('a conditional Retry persists its main-retention option before audio queue ownership is written', async (t) => {
  const w = world(t),
    c = setup({ auto: false });
  selectSegment(c.c, c.chats, 'chat', [['acp:kimi', 'acp:kimi:native']]);
  c.c.acpTurns.audioInput = true;
  c.c.audioPending = w.pending;
  const attachments = [{ kind: 'audio', path: '/keep.wav', name: 'Audio' }];
  const transfer = w.pending.hold('home', { text: 'Retry', attachments });
  const sending = c.c.send(
    'chat',
    { text: 'Retry', attachments, opts: { audioTransfer: transfer, human: true }, retryAtRevision: c.s('chat').rev },
    1,
    true,
  );
  const saved = createAudioPending(() => w.dir).list()[0];
  assert.equal(saved.item.opts.retainInMain, true);
  assert.equal(saved.item.retryAtRevision, undefined);
  c.execs[0].done({ started: false, error: 'native admission refused' });
  assert.equal((await sending).action, 'queued');
  assert.equal(c.s('chat').queue[0].opts.retainInMain, true);
});
