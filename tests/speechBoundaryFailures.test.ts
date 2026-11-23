// Speech storage and native-adapter failure boundaries preserve input, report uncertainty and refuse unsupported dispatch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setup, selectSegment } from './support/controller/fixture.ts';
const require = createRequire(import.meta.url);
const { createAudioAssets } = require('../electron/platform/audioAssets.cjs');
const { createAudioDispatch } = require('../electron/platform/audioDispatch.cjs');
const { createAudioOwnership } = require('../electron/platform/audioOwnership.cjs');
const { audioEnd } = require('../electron/harness/acp/audio.cjs');
const { acpBlocks } = require('../electron/harness/acp/blocks.cjs');
const { AcpTurns } = require('../electron/harness/acpTurns.cjs');

test('storage collection preserves unrelated files and reports unreadable directories instead of assuming they are empty', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-boundary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'keep');
  const assets = createAudioAssets(() => dir);
  assets.collect([], Date.now());
  assert.equal(fs.readFileSync(path.join(dir, 'unrelated.txt'), 'utf8'), 'keep');
  const journal = createAudioDispatch(() => dir);
  const fail = t.mock.method(fs, 'readdirSync', () => {
    throw Object.assign(new Error('denied'), { code: 'EACCES' });
  });
  assert.throws(() => assets.collect([], Date.now()), /denied/);
  assert.throws(() => journal.list(), /denied/);
  fail.mock.restore();
});

test('audio delivery keeps provider detail on an ambiguous stop and retains unresolved intent after journal-write failure', () => {
  const host = {
    audioDispatch: {
      settle() {
        throw new Error('disk full');
      },
    },
  };
  const why = audioEnd(host, {}, { audio: true, audioResponse: false, providerError: 'Provider disconnected' }, 'error', null);
  assert.equal(why.delivery, 'unknown');
  assert.match(why.error, /Provider disconnected/);
  assert.match(audioEnd(host, {}, { audio: true }, 'error', null).error, /may have started/);
});

test('audio serialization requires durable storage; ambiguous dispatch is held and an unsupported adapter never receives audio', async () => {
  const attachments = [{ kind: 'audio', path: '/keep.wav', name: 'Audio' }];
  await assert.rejects(
    acpBlocks('', attachments, async () => null),
    /storage is unavailable/,
  );
  const adapter = new AcpTurns({
    send: async () => {
      throw Object.assign(new Error('unknown delivery'), { deliveryUnknown: true });
    },
    emit() {},
    readAudio: async () => ({ type: 'audio', mimeType: 'audio/wav', data: 'AA' }),
  });
  const item = { id: 'intent', text: '', attachments, opts: {} };
  assert.equal((await adapter.startTurn('chat', { key: 'native' }, item)).held, true);
  const w = setup();
  selectSegment(w.c, w.chats, 'chat', [['codex', 'native']]);
  const result = await w.c.dispatch('chat', 'start', item);
  assert.equal(result.started, false);
  assert.match(result.error, /does not accept audio/);
  assert.equal(w.execs.length, 0);
  selectSegment(w.c, w.chats, 'acp:kimi:native', [['acp:kimi', 'acp:kimi:native']]);
  w.state.patch('acp:kimi:native', { acp: null });
  w.c.onAcpEvent({ key: 'acp:kimi:native', kind: 'session', caps: { audio: true } });
  assert.equal(w.state.get('acp:kimi:native').acp.audio, true);
  w.c.onAcpEvent({ key: 'acp:kimi:native', kind: 'session', switched: true, caps: { audio: false } });
  assert.equal(w.state.get('acp:kimi:native').acp.audio, false);
  assert.equal(w.state.get('acp:kimi:native').plan, false);
});

test('deleting audio drafts removes unsaved fragments too, and a collector does not inspect a failed prior store', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-delete-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const host = { audioDispatch: { list: () => [], remove() {} }, items: { listAsync: async () => [], audioRefs: async () => [] } };
  const own = createAudioOwnership(() => dir, { collect() {} }, host, { all: () => [] });
  const fail = t.mock.method(fs, 'writeFileSync', () => {
    throw new Error('full');
  });
  assert.throws(() => own.set('chat', { text: 'Keep', attachments: [{ kind: 'audio', path: '/keep.wav' }] }));
  fail.mock.restore();
  own.delete('other', []);
  own.delete('chat', ['native']);
  assert.deepEqual(own.drafts(), {});
  await own.collect();
});
