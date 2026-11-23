// A voice note for MoMo's chat (momo.chat.transcribe: electron/remote/methods/momo.cjs): the recording a phone sent in parts is turned into text on this Mac's own speech setup and not kept, only text comes back, the method names no chat, an account MoMo is not allowed for gets no trace of it, and a phone that is removed meanwhile gets nothing.
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ok, fail, momoRig, UNKNOWN_MOMO } from './support/remote-momo-kit.ts';

const require = createRequire(import.meta.url);
const { parseParams } = require('../shared/remote/schema.mjs');
const methods = require('../electron/remote/methods/momo.cjs');
const { streamsOf } = require('../electron/remote/chunks.cjs');
const { uploadOwner } = require('../electron/remote/attachmentOwners.cjs');

const METHOD = 'momo.chat.transcribe';
const b64 = (s: string) => Buffer.from(s).toString('base64');
const part = (stream: string, index: number, total: number, data: string, mime = 'audio/wav') => ({
  stream,
  index,
  total,
  data: b64(data),
  purpose: 'audio',
  mime,
});

test('a phone’s voice note comes back as text, once, and is not kept with the Mac’s recordings', async () => {
  const m = momoRig();
  const p = m.r.phone('p1');
  assert.ok(ok(await p.ask('machine.hello')).capabilities.methods.includes(METHOD));
  ok(await p.ask('chat.attach', part('voice-0001', 0, 2, 'RIFF')));
  ok(await p.ask('chat.attach', part('voice-0001', 1, 2, 'data')));
  assert.deepEqual(ok(await p.ask(METHOD, { stream: 'voice-0001', mime: 'audio/wav' })), { text: 'hi' });
  const sent = m.r.calls.find((c) => c[0] === 'transcribeClip')![1];
  assert.equal(sent.audio.toString(), 'RIFFdata');
  assert.deepEqual([sent.mime, sent.keep], ['audio/wav', false]);
  // nothing else was asked of the Mac's speech, nothing was sent to MoMo's chat, and the note cannot be taken twice
  assert.equal(m.r.calls.filter((c) => c[0] === 'transcribe').length, 0);
  assert.deepEqual(m.sent, []);
  fail(await p.ask(METHOD, { stream: 'voice-0001', mime: 'audio/wav' }), 'stale', /Record it again/);
  // another device cannot take it
  ok(await p.ask('chat.attach', part('voice-0002', 0, 1, 'RIFF')));
  fail(await m.r.phone('p2').ask(METHOD, { stream: 'voice-0002', mime: 'audio/wav' }), 'stale');
});

test('a note is read while MoMo is paused, as a typed message is sent', async () => {
  const m = momoRig();
  m.gate.paused = true;
  const p = m.r.phone('p1');
  ok(await p.ask('chat.attach', part('voice-0003', 0, 1, 'RIFF')));
  assert.deepEqual(ok(await p.ask(METHOD, { stream: 'voice-0003', mime: 'audio/wav' })), { text: 'hi' });
});

test('the request names no chat and takes only a recording sent in parts', () => {
  assert.deepEqual(parseParams(METHOD, { stream: 'voice-0001', mime: 'audio/webm', chatId: 'other', audio: 'aGk=' }), {
    stream: 'voice-0001',
    mime: 'audio/webm',
  });
  for (const p of [
    { stream: 'voice-0001', mime: 'audio/mp3' },
    { stream: 'voice-0001' },
    { mime: 'audio/wav' },
    { stream: 'a b', mime: 'audio/wav' },
  ])
    assert.throws(
      () => parseParams(METHOD, p),
      (e: any) => e.code === 'invalid',
      JSON.stringify(p),
    );
});

test('an account MoMo is not allowed for does not list it, is refused before anything is read, and keeps no recording', async () => {
  const m = momoRig({ allowed: false });
  m.r.service.momoAllowed = () => false;
  const p = m.r.phone('p1');
  assert.ok(!ok(await p.ask('machine.hello')).capabilities.methods.includes(METHOD));
  ok(await p.ask('chat.attach', part('voice-0004', 0, 1, 'RIFF')));
  fail(await p.ask(METHOD, { stream: 'voice-0004', mime: 'audio/wav' }), 'invalid', UNKNOWN_MOMO);
  assert.equal(m.r.calls.filter((c) => c[0] === 'transcribeClip').length, 0);
  // main's own check behind the service's: an invite withdrawn between the request and the read
  const svc: any = {
    momo: () => ({ assertAllowed: () => undefined }),
    assertPaired: () => undefined,
    momoAllowed: () => false,
    ops: {},
    now: Date.now,
  };
  await assert.rejects(
    methods[METHOD](svc, { kind: 'phone', pairId: 'p1' }, { stream: 'voice-0001', mime: 'audio/wav' }),
    /MoMo is not available/,
  );
});

test('a MoMo that is not ready, or a phone removed while the Mac listens, gets no text', async () => {
  const m = momoRig();
  const p = m.r.phone('p1');
  m.r.service.momo = () => null;
  fail(await p.ask(METHOD, { stream: 'voice-0005', mime: 'audio/wav' }), 'failed', /MoMo is not ready/);
  const client: any = { kind: 'phone', pairId: 'p1' };
  let paired = true;
  const svc: any = {
    momo: () => ({ assertAllowed: () => undefined }),
    assertPaired: () => {
      if (!paired) throw new Error('This device is no longer paired.');
    },
    momoAllowed: () => true,
    ops: {
      dictation: {
        transcribeClip: async () => {
          // removed while the Mac was reading it
          paired = false;
          return { text: 'late' };
        },
      },
    },
    now: Date.now,
  };
  streamsOf(svc).add(uploadOwner(client), { stream: 'voice-0006', index: 0, total: 1, data: b64('RIFF'), purpose: 'audio' });
  await assert.rejects(methods[METHOD](svc, client, { stream: 'voice-0006', mime: 'audio/wav' }), /no longer paired/);
});
