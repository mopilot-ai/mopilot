// Starting and shaping a chat from a phone: chat.start on a Codex, a Claude Code and an ACP fake harness (picks, start id, refused bypass and ceiling, forbidden), a follow-up queued while a turn runs, and files and recordings sent in parts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { messageIdentity } from '../shared/remote/messageIdentity.mjs';
import { createRequire } from 'node:module';
import { rig, settle } from './support/remote-kit.ts';
import { parseParams, MAX_CHUNK, MAX_CHUNKS } from '../shared/remote/schema.mjs';

const require = createRequire(import.meta.url);
const { ChunkStreams, IDLE_MS, MAX_STREAMS } = require('../electron/remote/chunks.cjs');

const ok = (r: any) => (assert.equal(r.ok, true, JSON.stringify(r.error)), r.result);
const fail = (r: any, code: string, message?: RegExp) => {
  assert.equal(r.ok, false, JSON.stringify(r.result));
  assert.equal(r.error.code, code, r.error.message);
  if (message) assert.match(r.error.message, message);
};
const HARNESSES = ['codex', 'claude', 'acp:fake'];
const b64 = (s: string) => Buffer.from(s).toString('base64');

for (const harness of HARNESSES) {
  test(`chat.start on ${harness}: picks reach the panel's start once, the permission rides in the start, a start id makes a retry the same chat`, async () => {
    const r = rig();
    const p = r.phone('p1');
    const picks = {
      harness,
      text: 'build it',
      projectId: 'p1',
      account: 'work',
      worktree: true,
      model: 'm',
      effort: 'high',
      permission: 'default',
    };
    assert.deepEqual(ok(await p.ask('chat.start', { ...picks, startId: 'start-0001' })), { chatId: 'new-chat' });
    const start = r.calls.find((c) => c[0] === 'start')![1];
    assert.deepEqual(start, {
      harness,
      text: 'build it',
      projectId: 'p1',
      model: 'm',
      effort: 'high',
      permission: 'default',
      attachments: [],
      skills: [],
      nativeMessageId: messageIdentity((bytes) => createHash('sha256').update(bytes).digest(), 'p1', 'chat.start', null, 'start-0001'),
      account: 'work',
      worktree: true,
    });
    assert.equal(
      r.calls.some((c) => c[0] === 'permit'),
      false,
    );
    // a retry (a new request id, the same start id) is answered, not started again
    assert.deepEqual(ok(await p.ask('chat.start', { ...picks, startId: 'start-0001' })), { chatId: 'new-chat' });
    assert.equal(r.calls.filter((c) => c[0] === 'start').length, 1);
    // the same id for other picks is a different request
    fail(await p.ask('chat.start', { ...picks, text: 'other', startId: 'start-0001' }), 'stale', /different chat/);
    // another device's id is its own
    assert.deepEqual(ok(await r.phone('p2').ask('chat.start', { ...picks, startId: 'start-0001' })), { chatId: 'new-chat' });
    assert.equal(r.calls.filter((c) => c[0] === 'start').length, 2);
  });
}

test('a start that failed may be tried again under its id; one without an id always starts', async () => {
  let n = 0;
  const r = rig({
    ops: {
      start: async () => {
        if (++n === 1) throw new Error('boom');
        return { chatId: `c${n}` };
      },
    },
  });
  const p = r.phone('p1');
  fail(await p.ask('chat.start', { harness: 'codex', text: 'x', startId: 'start-0002' }), 'failed', /boom/);
  assert.deepEqual(ok(await p.ask('chat.start', { harness: 'codex', text: 'x', startId: 'start-0002' })), { chatId: 'c2' });
  assert.deepEqual(ok(await p.ask('chat.start', { harness: 'codex', text: 'x' })), { chatId: 'c3' });
  assert.deepEqual(ok(await p.ask('chat.start', { harness: 'codex', text: 'x' })), { chatId: 'c4' });
});

test('start ids remembered are bounded', async () => {
  const r = rig();
  const p = r.phone('p1');
  for (let i = 0; i < 1002; i++)
    ok(await p.ask('chat.start', { harness: 'codex', text: 'x', startId: `start-${String(i).padStart(5, '0')}` }));
  // the first fell out: it starts again
  ok(await p.ask('chat.start', { harness: 'codex', text: 'x', startId: 'start-00000' }));
  assert.equal(r.calls.filter((c) => c[0] === 'start').length, 1003);
});

test('a phone never starts a chat at full access or above the ceiling, before any chat exists; the panel may', async () => {
  const r = rig({ policy: { permissionCeiling: () => 'default' } });
  const p = r.phone('p1');
  for (const permission of ['full-access', 'bypassPermissions', 'danger-full-access', 'auto-review'])
    fail(await p.ask('chat.start', { harness: 'claude', text: 'x', permission }), 'forbidden');
  assert.equal(r.calls.filter((c) => c[0] === 'start').length, 0);
  ok(await p.ask('chat.start', { harness: 'claude', text: 'x', permission: 'read-only' }));
  assert.equal(
    await r.service
      .call({ kind: 'panel' }, 'chat.start', { harness: 'claude', text: 'x', permission: 'full-access' })
      .then((x: any) => x.chatId),
    'new-chat',
  );
});

test('chat.start is forbidden when the Mac disallows the device, refused for a harness that cannot run, and a bad id or account is invalid', async () => {
  const r = rig({ policy: { allow: (pair: string, m: string) => !(pair === 'p2' && m === 'chat.start') } });
  const [p1, p2] = [r.phone('p1'), r.phone('p2')];
  fail(await p2.ask('chat.start', { harness: 'codex', text: 'x' }), 'forbidden', /doesn't allow/);
  fail(await p1.ask('chat.start', { harness: 'acp:off', text: 'x' }), 'failed', /can't start a chat now/);
  fail(await p1.ask('chat.start', { harness: 'codex', text: 'x', startId: 'no' }), 'invalid');
  fail(await p1.ask('chat.start', { harness: 'codex', text: 'x', account: 'bad account!' }), 'invalid');
  assert.equal(r.calls.filter((c) => c[0] === 'start').length, 0);
});

for (const harness of HARNESSES) {
  test(`chat.send on ${harness} queues behind a running turn, in order`, async () => {
    let release: () => void = () => undefined;
    const order: string[] = [];
    const r = rig({
      ops: {
        send: async (m: any) => {
          order.push(`start ${m.text}`);
          if (m.text === 'first') await new Promise<void>((res) => (release = res));
          order.push(`end ${m.text}`);
          return {};
        },
      },
    });
    const p = r.phone('p1');
    const first = p.ask('chat.send', { chatId: harness === 'codex' ? 'c1' : 'c2', text: 'first' }, 'a');
    await settle();
    const second = p.ask('chat.send', { chatId: harness === 'codex' ? 'c1' : 'c2', text: 'second' }, 'b');
    await settle();
    assert.deepEqual(order, ['start first']);
    release();
    await first;
    ok(await second);
    assert.deepEqual(order, ['start first', 'end first', 'start second', 'end second']);
  });
}

test('chat.switch and the menus come from the operations and are checked', async () => {
  const r = rig();
  const p = r.phone('p1');
  for (const harness of HARNESSES) assert.deepEqual(ok(await p.ask('chat.switch', { chatId: 'c1', harness })), { switched: true });
  fail(await p.ask('chat.switch', { chatId: 'c1', harness: 'gemini' }), 'invalid', /Pick a harness/);
  fail(await p.ask('chat.switch', { chatId: '!!', harness: 'codex' }), 'invalid');
  fail(await p.ask('options.set', { chatId: 'c1', value: 'full-access' }), 'forbidden');
  assert.deepEqual(ok(await p.ask('options.get', { harness: 'acp:fake' })), { models: [] });
  assert.deepEqual(ok(await p.ask('commands.list', { harness: 'claude', projectId: 'p1' })), { commands: [] });
});

test('a file arrives in parts and lands as one attachment; parts in order, a retry acknowledged, a gap or a mix-up refused', async () => {
  const r = rig();
  const p = r.phone('p1');
  const chunk = (index: number, data: string, extra: object = {}) => ({
    stream: 'stream-0001',
    index,
    total: 3,
    data: b64(data),
    name: 'a.png',
    mime: 'image/png',
    ...extra,
  });
  assert.deepEqual(ok(await p.ask('chat.attach', chunk(0, 'ab'))), { stream: 'stream-0001', received: 1, done: false });
  assert.deepEqual(ok(await p.ask('chat.attach', chunk(0, 'ab'))), { stream: 'stream-0001', received: 1, done: false });
  fail(await p.ask('chat.attach', chunk(2, 'ef')), 'stale', /Resend from part 1/);
  fail(await p.ask('chat.attach', chunk(1, 'cd', { total: 4 })), 'stale', /used for something else/);
  assert.deepEqual(ok(await p.ask('chat.attach', chunk(1, 'cd'))), { stream: 'stream-0001', received: 2, done: false });
  const done = ok(await p.ask('chat.attach', chunk(2, 'ef')));
  assert.deepEqual(done, { id: '0123456789abcdef', name: 'n', kind: 'file', stream: 'stream-0001', received: 3, done: true });
  const saved = r.calls.find((c) => c[0] === 'attach')![1];
  assert.equal(saved.name, 'a.png');
  assert.equal(saved.dataUrl, `data:image/png;base64,${b64('abcdef')}`);
  // a stream that never started cannot begin in the middle; a file with no type is a plain file
  fail(await p.ask('chat.attach', chunk(1, 'x', { stream: 'stream-0002' })), 'stale', /from the start/);
  ok(await p.ask('chat.attach', { stream: 'stream-0003', index: 0, total: 1, data: b64('z') }));
  assert.match(r.calls.filter((c) => c[0] === 'attach').at(-1)![1].dataUrl, /^data:application\/octet-stream;base64,/);
  // the panel's whole-file form still works
  assert.equal(ok(await p.ask('chat.attach', { dataUrl: 'data:x,y' })).id, '0123456789abcdef');
});

test('a recording arrives in parts and is transcribed once on the Mac', async () => {
  const r = rig();
  const p = r.phone('p1');
  const part = (index: number, data: string) => ({
    stream: 'audio-0001',
    index,
    total: 2,
    data: b64(data),
    purpose: 'audio',
    mime: 'audio/wav',
  });
  assert.deepEqual(ok(await p.ask('chat.attach', part(0, 'RIFF'))), { stream: 'audio-0001', received: 1, done: false });
  assert.deepEqual(ok(await p.ask('chat.attach', part(1, 'data'))), { stream: 'audio-0001', received: 2, done: true, bytes: 8 });
  // the last part again (a dropped reply) is answered the same
  assert.deepEqual(ok(await p.ask('chat.attach', part(1, 'data'))), { stream: 'audio-0001', received: 2, done: true, bytes: 8 });
  assert.deepEqual(ok(await p.ask('chat.transcribe', { stream: 'audio-0001', mime: 'audio/wav' })), { text: 'hi' });
  // a phone has no speech lease of its own: the Mac makes one for the clip (transcribeClip), and the clip is kept as the coding chat's always was
  const sent = r.calls.find((c) => c[0] === 'transcribeClip')![1];
  assert.equal(sent.audio.toString(), 'RIFFdata');
  assert.deepEqual([sent.mime, sent.keep], ['audio/wav', true]);
  fail(await p.ask('chat.transcribe', { stream: 'audio-0001', mime: 'audio/wav' }), 'stale', /Record it again/);
  // a file stream is not a recording, and another device cannot take it
  ok(await p.ask('chat.attach', { stream: 'audio-0002', index: 0, total: 2, data: b64('x'), purpose: 'audio', mime: 'audio/webm' }));
  fail(await p.ask('chat.transcribe', { stream: 'audio-0002', mime: 'audio/webm' }), 'stale');
  ok(await p.ask('chat.attach', { stream: 'audio-0002', index: 1, total: 2, data: b64('y'), purpose: 'audio', mime: 'audio/webm' }));
  fail(await r.phone('p2').ask('chat.transcribe', { stream: 'audio-0002', mime: 'audio/webm' }), 'stale');
  assert.deepEqual(ok(await p.ask('chat.transcribe', { stream: 'audio-0002', mime: 'audio/webm' })), { text: 'hi' });
  // the whole-clip form still works
  assert.deepEqual(ok(await p.ask('chat.transcribe', { mime: 'audio/wav', audio: 'aGk=' })), { text: 'hi' });
  assert.equal(r.calls.filter((c) => c[0] === 'transcribe').length, 1);
});

test('chunk limits: a file over 20 MB or a recording over 25 MB drops its stream; too many streams are refused; idle ones expire', () => {
  let now = 1000;
  const s = new ChunkStreams(() => now);
  const big = Buffer.alloc(MAX_CHUNK * 0.75, 1).toString('base64');
  const send = (stream: string, index: number, purpose = 'file') => s.add('p1', { stream, index, total: MAX_CHUNKS, data: big, purpose });
  let i = 0;
  assert.throws(() => {
    for (; ; i++) send('big', i);
  }, /larger than 20 MB/);
  assert.ok(i >= 170 && i < 180, String(i));
  // the stream is gone: it can only begin again from the start
  assert.throws(() => send('big', 5), /from the start/);
  let j = 0;
  assert.throws(() => {
    for (; ; j++) send('long', j, 'audio');
  }, /too long/);
  assert.ok(j > i);
  for (let k = 0; k < MAX_STREAMS; k++) send(`s${k}`, 0);
  assert.throws(() => send('one-more', 0), /Too many uploads/);
  now += IDLE_MS + 1;
  assert.equal(send('one-more', 0).received, 1);
  assert.throws(() => s.take('p1', 'one-more'), /Record it again/);
});

test("the schema checks a part: stream id, position, size, base64 and a recording's type", () => {
  const good = { stream: 'stream-0001', index: 0, total: 2, data: 'YQ==' };
  assert.equal((parseParams('chat.attach', { ...good, name: 'n'.repeat(300) }) as any).name.length, 200);
  assert.equal((parseParams('chat.attach', good) as any).purpose, 'file');
  for (const bad of [
    { ...good, stream: 'x' },
    { ...good, total: 0 },
    { ...good, total: MAX_CHUNKS + 1 },
    { ...good, index: 2 },
    { ...good, index: -1 },
    { ...good, index: 'a' },
    { ...good, data: '' },
    { ...good, data: 'a'.repeat(MAX_CHUNK + 1) },
    { ...good, data: 'not base64!' },
    { ...good, purpose: 'audio', mime: 'audio/mp3' },
  ])
    assert.throws(() => parseParams('chat.attach', bad), /upload is not valid|recording/);
  assert.deepEqual(parseParams('chat.transcribe', { stream: 'audio-0001', mime: 'audio/wav' }), {
    stream: 'audio-0001',
    mime: 'audio/wav',
  });
  assert.throws(() => parseParams('chat.transcribe', { stream: 'audio-0001', mime: 'audio/mp3' }), /recording/);
  assert.throws(() => parseParams('chat.transcribe', { stream: 'no', mime: 'audio/wav' }), /upload is not valid/);
  const start: any = parseParams('chat.start', { harness: 'claude', text: 'x', account: 'a@b.c', worktree: true, startId: 'start-0001' });
  assert.deepEqual([start.account, start.worktree, start.startId], ['a@b.c', true, 'start-0001']);
  const plain: any = parseParams('chat.start', { harness: 'claude', text: 'x', worktree: false, account: null, startId: null });
  assert.ok(!('account' in plain) && !('worktree' in plain) && !('startId' in plain));
});

test('the panel starts and uploads under its own owner, apart from every phone', async () => {
  const r = rig();
  const panel = { kind: 'panel' };
  const start = { harness: 'codex', text: 'x', startId: 'start-0009' };
  assert.equal((await r.service.call(panel, 'chat.start', start)).chatId, 'new-chat');
  assert.equal((await r.service.call(panel, 'chat.start', start)).chatId, 'new-chat');
  assert.equal(r.calls.filter((c) => c[0] === 'start').length, 1);
  const part = { stream: 'panel-0001', index: 0, total: 1, data: b64('RIFF'), purpose: 'audio', mime: 'audio/wav' };
  assert.equal((await r.service.call(panel, 'chat.attach', part)).done, true);
  assert.deepEqual(await r.service.call(panel, 'chat.transcribe', { stream: 'panel-0001', mime: 'audio/wav' }), { text: 'hi' });
  assert.throws(() => parseParams('chat.transcribe', { stream: 'panel-0001' }), /recording/);
});
