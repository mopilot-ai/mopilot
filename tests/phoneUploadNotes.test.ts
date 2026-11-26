// Each attachment's upload is told to the performance log as it went (#5638): every part with its connection, its computer and how it ended, the waits, and why the tile ends at Retry; numbers and fixed words only.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
import { scripted, chunkReply } from './support/phone/m3';

const hookPath = '../mobile/src/remote/useAttachments';
const clientPath = '../mobile/src/remote/client';
const uploadPath = '../mobile/src/remote/upload';
const logPath = '../mobile/src/perfLog';
const { useAttachments, uploadRetry } = await import(hookPath);
const { ownedRequest } = await import(clientPath);
const { CHUNK, Cancelled, OtherComputer, partOutcome } = await import(uploadPath);
const { perf } = await import(logPath);

afterEach(() => perf.end());

/** A screen holding attachments on `request()`, re-drawn with `draw()`. */
async function screen(request: () => unknown, key?: string) {
  let api: any;
  const Probe = () => {
    api = useAttachments(request(), key);
    return null;
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const draw = () => act(async () => root.render(createElement(Probe)));
  await draw();
  return {
    api: () => api,
    draw,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
const big = () => ({ name: 'v.mp4', mime: 'video/mp4', base64: 'A'.repeat(CHUNK * 2 + 4) });
const last = () => perf.report().uploads.at(-1);
const parts = (note: any) =>
  note.events.map((e: any) => [e.to === undefined ? e.index : `${e.index}–${e.to}`, e.gen, e.computer, e.outcome]);

test('an upload that went is told part by part on its connection, done', async () => {
  perf.start();
  const { runtime } = scripted(() => undefined, { selectedPair: 'p', generation: 4, phase: 'online' });
  const s = await screen(() => ownedRequest(runtime));
  await act(async () => s.api().add(big()));
  await flush();
  const note = last();
  assert.deepEqual(
    [note.restarted, note.computer, note.parts, note.result, note.reason, note.waits],
    [false, 'named', 3, 'done', null, []],
  );
  assert.deepEqual(parts(note), [['0–2', 4, 'same', 'ok']], 'parts that went in a row on one connection are one range');
  assert.equal(typeof note.seconds, 'number');
  await s.done();
});

test('a part the connection lost, the wait, and the computer named by the next request: the note says each, and why the tile shows Retry', async () => {
  const waits = uploadRetry.waits;
  uploadRetry.waits = [5];
  perf.start();
  try {
    const { runtime } = scripted((m, p) => {
      if (m === 'chat.attach' && p.index === 1) throw new Error('relay disconnected');
      return undefined;
    });
    const { runtime: other } = scripted(() => undefined, { selectedPair: 'q', generation: 9, phase: 'online' });
    let which = runtime;
    const s = await screen(() => ownedRequest(which));
    await act(async () => s.api().add(big()));
    await flush();
    which = other;
    await s.draw();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
    await flush();
    const note = last();
    assert.deepEqual(parts(note), [
      [0, 1, 'same', 'ok'],
      [1, 1, 'same', 'lost'],
      [1, 9, 'other', 'other-computer'],
    ]);
    assert.deepEqual([note.waits, note.result, note.reason], [[5], 'retry', 'other-computer']);
    await s.done();
  } finally {
    uploadRetry.waits = waits;
  }
});

test('an upload whose screen went under it is told as cut off, and the one that carries it on as restarted', async () => {
  perf.start();
  const { runtime: hanging } = scripted((m) => (m === 'chat.attach' ? new Promise(() => {}) : undefined));
  const cut = await screen(() => ownedRequest(hanging), 'notes-cut');
  await act(async () => cut.api().add(big()));
  await cut.done();
  await flush();
  assert.deepEqual([last().result, last().reason], ['cut-off', null]);
  const { runtime } = scripted((m, p) => (m === 'chat.attach' ? chunkReply(p) : undefined));
  const again = await screen(() => ownedRequest(runtime), 'notes-cut');
  await flush();
  assert.deepEqual([last().restarted, last().result], [true, 'done']);
  await again.done();
});

test('a cancelled upload is told as cancelled; a request that names no computer is told as such', async () => {
  perf.start();
  const { runtime } = scripted((m) => (m === 'chat.attach' ? new Promise(() => {}) : undefined), {
    selectedPair: null,
    generation: 2,
    phase: 'offline',
  });
  const s = await screen(() => ownedRequest(runtime));
  await act(async () => s.api().add(big()));
  await act(async () => s.api().cancel(s.api().items[0].key));
  await flush();
  assert.deepEqual([last().computer, last().result, last().reason], ['none', 'cancelled', null]);
  await s.done();
});

test('a refusal with a code is told with it, and the parts before it as their range', async () => {
  perf.start();
  const { runtime } = scripted((m, p) => {
    if (m === 'chat.attach' && p.index === 2)
      throw Object.assign(new Error('Send that upload again from the start.'), { code: 'STREAM_UNKNOWN' });
    return undefined;
  });
  const s = await screen(() => ownedRequest(runtime));
  const three = { name: 'v.mp4', mime: 'video/mp4', base64: 'A'.repeat(CHUNK * 3) };
  await act(async () => s.api().add(three));
  await flush();
  assert.deepEqual(last().events, [
    { index: 0, to: 1, gen: 1, computer: 'same', outcome: 'ok' },
    { index: 2, gen: 1, computer: 'same', outcome: 'refused', code: 'STREAM_UNKNOWN' },
  ]);
  assert.deepEqual([last().result, last().reason], ['retry', 'refused STREAM_UNKNOWN']);
  await s.done();
});

test('how a part ended, in fixed words: never the error’s own', () => {
  const said = (message: string, cause?: unknown) => new Error(message, cause ? { cause } : undefined);
  assert.deepEqual(partOutcome(new OtherComputer()), { outcome: 'other-computer' });
  assert.deepEqual(partOutcome(new Cancelled()), { outcome: 'cancelled' });
  assert.deepEqual(partOutcome(said('Couldn’t reach your computer.', said('Request timed out'))), { outcome: 'timeout' });
  assert.deepEqual(partOutcome(said('relay acknowledgement timed out')), { outcome: 'timeout' });
  assert.deepEqual(partOutcome(said('relay disconnected')), { outcome: 'lost' });
  assert.deepEqual(partOutcome(said('The connected computer changed. Try again.')), { outcome: 'stale' });
  assert.deepEqual(partOutcome(said('Your computer is offline or asleep.', said('Computer is offline'))), { outcome: 'away' });
  assert.deepEqual(partOutcome(said('Connect to a computer first')), { outcome: 'no-connection' });
  assert.deepEqual(partOutcome(said('That file type is not allowed.')), { outcome: 'refused' });
  assert.deepEqual(partOutcome(said('wrapped', Object.assign(said('inner'), { code: 'TOO_BIG' }))), {
    outcome: 'refused',
    code: 'TOO_BIG',
  });
  assert.deepEqual(partOutcome(Object.assign(said('x'), { code: 'not a code' })), { outcome: 'refused' });
  // the phone's channel closed under the part; the relay refused the frame (its own word); a reply the phone could not read; the Mac's lower-case code
  assert.deepEqual(partOutcome(said('Your computer is offline.', said('session closed'))), { outcome: 'session-closed' });
  assert.deepEqual(partOutcome(said('worded', said('relay: forbidden'))), { outcome: 'relay-refused', code: 'forbidden' });
  assert.deepEqual(partOutcome(said('relay: error')), { outcome: 'relay-refused', code: 'error' });
  assert.deepEqual(partOutcome(Object.assign(said('The computer sent a reply this phone could not read'), { code: 'reply_unreadable' })), {
    outcome: 'unreadable',
  });
  assert.deepEqual(partOutcome(Object.assign(said('No such stream.'), { code: 'stream_unknown' })), {
    outcome: 'refused',
    code: 'stream_unknown',
  });
  assert.deepEqual(partOutcome('plain text'), { outcome: 'refused' });
});

test('a request made outside ownedRequest names no connection; a later one that names no computer is told as none', async () => {
  const waits = uploadRetry.waits;
  uploadRetry.waits = [5];
  perf.start();
  try {
    // a bare request: no computer and no connection named
    const { runtime } = scripted(() => undefined);
    const bare = await screen(() => (method: string, params: any) => runtime.request(method, params));
    await act(async () => bare.api().add(big()));
    await flush();
    assert.deepEqual(parts(last()), [['0–2', null, 'same', 'ok']]);
    await bare.done();
    // the computer goes from the screen's request (a reconnect not yet back): the rest is not sent
    const { runtime: lost } = scripted((m, p) => {
      if (m === 'chat.attach' && p.index === 1) throw new Error('relay disconnected');
      return undefined;
    });
    const { runtime: none } = scripted(() => undefined, { selectedPair: null, generation: 3, phase: 'offline' });
    let which = lost;
    const s = await screen(() => ownedRequest(which));
    await act(async () => s.api().add(big()));
    await flush();
    which = none;
    await s.draw();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
    await flush();
    assert.deepEqual(parts(last()).at(-1), [1, 3, 'none', 'other-computer']);
    await s.done();
  } finally {
    uploadRetry.waits = waits;
  }
});

test('a part whose channel closed under it is sent again from the confirmed part, and told as session-closed; a relay refusal is not retried', async () => {
  const waits = uploadRetry.waits;
  uploadRetry.waits = [5];
  perf.start();
  try {
    let close = 1;
    const { runtime, calls } = scripted((m, p) => {
      if (m === 'chat.attach' && p.index === 1 && close-- > 0) throw new Error('session closed');
      return undefined;
    });
    const s = await screen(() => ownedRequest(runtime));
    await act(async () => s.api().add(big()));
    await flush();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
    await flush();
    assert.equal(s.api().items[0].state, 'done', 'it went, with no Retry');
    assert.deepEqual(parts(last()), [
      [0, 1, 'same', 'ok'],
      [1, 1, 'same', 'session-closed'],
      ['1–2', 1, 'same', 'ok'],
    ]);
    assert.deepEqual(
      calls.filter((c) => c[0] === 'chat.attach').map((c) => c[1].index),
      [0, 1, 1, 2],
      'from the part the Mac confirmed',
    );
    await s.done();
    // the relay refused the frame: told with its word, and the tile shows Retry at once
    const { runtime: refusing } = scripted((m, p) => {
      if (m === 'chat.attach' && p.index === 1) throw new Error('relay: forbidden');
      return undefined;
    });
    const r = await screen(() => ownedRequest(refusing));
    await act(async () => r.api().add(big()));
    await flush();
    assert.deepEqual([r.api().items[0].state, last().reason, last().waits], ['failed', 'relay-refused forbidden', []]);
    await r.done();
  } finally {
    uploadRetry.waits = waits;
  }
});
