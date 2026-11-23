// Main native conversation admission, writer exclusion, queued sends and original-resource cleanup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, selectSegment, tick } from './support/controller/fixture.ts';
import { deferred } from './support/async-scenarios.ts';
const require = createRequire(import.meta.url);
const { startVoice, stopVoice, observeVoice, voiceWriter } = require('../electron/session/voice.cjs');
const { createSpeech } = require('../electron/platform/speech.cjs');

function world() {
  const w = setup();
  selectSegment(w.c, w.chats, 'chat', [['codex', 'native']]);
  const requests: any[] = [],
    pins: any[] = [];
  w.c.codex.pin = (...args: any[]) => pins.push(args);
  w.c.codex.request = async (...args: any[]) => {
    requests.push(args);
    if (args[0] === 'thread/realtime/stop')
      observeVoice(w.c.codex, { kind: 'message', msg: { method: 'thread/realtime/closed', params: { threadId: 'native' } } });
    return {};
  };
  const deps = {
    controller: w.c,
    codex: w.c.codex,
    caps: { get: async () => ({ kind: 'codex', caps: { voiceChat: { state: 'native' } } }) },
  };
  return { ...w, deps, requests, pins, start: () => startVoice(deps, { threadId: 'native' }) };
}

test('native voice reserves the chat, queues all send paths, and drains exactly once after closure', async () => {
  const w = world();
  await w.start();
  await assert.rejects(w.start(), /current work/);
  const result = await w.c.send('chat', { text: 'later', followUp: 'steer' }, 1, true);
  assert.equal(result.action, 'queued');
  assert.equal(w.execs.length, 0);
  assert.equal(w.c.sendNow('chat', result.id, 2, true).status, 'queued');
  assert.equal(w.c.sendNow('chat', result.id, 2), true);
  assert.equal(w.c.drain('chat'), undefined);
  assert.equal((await w.c.dispatch('chat', 'turn', { opts: {} }, 1)).started, false);
  observeVoice(w.c.codex, { kind: 'message', msg: { method: 'thread/realtime/closed', params: { threadId: 'other' } } });
  assert.ok(voiceWriter(w.c, 'chat'));
  await stopVoice(w.c.codex, 'other');
  await stopVoice(w.c.codex, 'native');
  await tick();
  assert.equal(w.execs.length, 1);
  assert.deepEqual(w.pins, [
    ['native', true],
    ['native', false],
  ]);
  observeVoice(w.c.codex, { kind: 'stopped' });
  await stopVoice(w.c.codex, 'native');
  assert.equal(w.execs.length, 1);
});

test('ordinary turns, pending switches, retained input and changing capabilities refuse conversation admission', async () => {
  for (const patch of [{ turn: 'running' }, { runningElsewhere: true }, { pendingSwitch: {} }, { queue: [{}] }]) {
    const w = world();
    w.state.patch('chat', patch);
    await assert.rejects(w.start(), /current work/);
    assert.equal(w.requests.length, 0);
  }
  const w = world();
  const gate = deferred<any>();
  w.deps.caps.get = () => gate.promise;
  const starting = w.start();
  selectSegment(w.c, w.chats, 'chat', [
    ['codex', 'native'],
    ['claude', 'claude-id'],
  ]);
  gate.resolve({ kind: 'codex', caps: { voiceChat: { state: 'native' } } });
  await assert.rejects(starting, /unavailable/);
  await assert.rejects(startVoice({ ...w.deps, current: () => false }, { threadId: 'native' }), /unavailable/);
  assert.equal(w.requests.length, 0);
});

test('native refusal releases its writer; ambiguous failure keeps it until confirmed stop or process loss', async () => {
  const w = world();
  w.c.codex.request = async () => {
    throw Object.assign(new Error('Refused'), { code: -32602 });
  };
  await assert.rejects(w.start(), /Refused/);
  assert.equal(voiceWriter(w.c, 'chat'), null);
  const stop = deferred<any>();
  w.c.codex.request = (method: string) => (method.endsWith('/stop') ? stop.promise : Promise.reject(new Error('pipe broke')));
  await assert.rejects(w.start(), /pipe broke/);
  assert.ok(voiceWriter(w.c, 'chat'));
  observeVoice(w.c.codex, { kind: 'stopped' });
  assert.equal(voiceWriter(w.c, 'chat'), null);
  stop.resolve({});
  await tick();
});

test('renderer loss retires the capture immediately but owns native cleanup until it settles', async () => {
  const speech = createSpeech({ prefs: () => ({}), ref: () => ({}), identity: () => null });
  const id = speech.begin(1, 'chat', {});
  const closing = deferred<void>();
  speech.attach(1, id, () => closing.promise);
  assert.throws(() => speech.attach(1, id, async () => {}), /already starting/);
  const end = speech.close(1);
  assert.equal(speech.current(1, id), false);
  assert.throws(() => speech.begin(2, 'chat', {}), /already active/);
  await speech.end(1, id);
  closing.resolve();
  await end;
  const next = speech.begin(2, 'next', {});
  assert.throws(() => speech.attach(1, next, async () => {}), /earlier/);
  speech.attach(2, next, async () => {
    throw new Error('stop failed');
  });
  await assert.rejects(speech.end(2, next), /stop failed/);
  assert.ok(speech.begin(3, null, {}));
});

test('an unanswered Start can be stopped without waiting for its ACK; late dispatch remains guarded', async () => {
  const w = world();
  const pending = deferred<any>();
  let original: any;
  w.c.codex.request = async (method: string, params: any) => {
    if (method.endsWith('/start')) {
      original = params;
      return pending.promise;
    }
    observeVoice(w.c.codex, { kind: 'message', msg: { method: 'thread/realtime/closed', params: { threadId: 'native' } } });
    return {};
  };
  const starting = startVoice({ ...w.deps, timeoutMs: 30 }, { threadId: 'native' });
  const result = assert.rejects(starting, /did not confirm/);
  await tick();
  await stopVoice(w.c.codex, 'native', 20);
  assert.equal(voiceWriter(w.c, 'chat'), null);
  const { assertInputCurrent } = require('../electron/session/contract/inputGuard.cjs');
  assert.throws(() => assertInputCurrent(original), /cancelled/);
  await result;
  pending.resolve({});
  await tick();
});

test('Stop ACK cannot admit a replacement before its original closed notification; missing closure has a bounded exit', async () => {
  const w = world();
  await w.start();
  w.c.codex.request = async () => ({});
  const stopping = stopVoice(w.c.codex, 'native', 20);
  await tick();
  await assert.rejects(w.start(), /current work/);
  observeVoice(w.c.codex, { kind: 'message', msg: { method: 'thread/realtime/closed', params: { threadId: 'native' } } });
  await stopping;
  await w.start();
  await assert.rejects(stopVoice(w.c.codex, 'native', 5), /did not confirm/);
  assert.ok(voiceWriter(w.c, 'chat'), 'unconfirmed closure never releases its native writer');
  observeVoice(w.c.codex, { kind: 'stopped' });
});

test('the real Codex request boundary proves cancelled initialization never dispatched Start and releases its writer', async () => {
  const { setup: adapterWorld } = await import('./support/codex-adapter/fixture.ts');
  const { a, server } = adapterWorld();
  const w = world();
  const initialization = deferred<void>();
  a.initialize = () => initialization.promise;
  w.c.codex = a;
  let current = true;
  const starting = startVoice({ ...w.deps, codex: a, current: () => current, timeoutMs: 200 }, { threadId: 'native' });
  const rejected = assert.rejects(starting, /cancelled/);
  await tick();
  assert.ok(voiceWriter(w.c, 'chat'));
  current = false;
  initialization.resolve();
  await rejected;
  assert.equal(server.methods().includes('thread/realtime/start'), false);
  assert.equal(voiceWriter(w.c, 'chat'), null);
});

test('internal start paths retain input behind voice exactly once; Stop failure can be retried against the same writer', async () => {
  const w = world();
  await stopVoice({}, 'missing');
  await w.start();
  const item = { id: 'internal', text: 'Keep', attachments: [], opts: {} };
  assert.equal((await w.c.start('chat', item)).started, false);
  let admitted = 0;
  w.c.audioPending = { admit: () => admitted++ };
  await w.c.startOrKeep('chat', item);
  await w.c.startOrKeep('chat', item);
  assert.equal(w.state.get('chat').queue.length, 1);
  assert.equal(w.state.get('chat').queue[0].waitingFor, 'voiceConversation');
  assert.ok(admitted >= 2);
  await stopVoice(w.c.codex, 'unrelated');
  w.c.codex.request = async () => {
    throw new Error('stop refused');
  };
  await assert.rejects(stopVoice(w.c.codex, 'native'), /stop refused/);
  assert.ok(voiceWriter(w.c, 'chat'));
  w.state.patch('chat', { queue: [...w.state.get('chat').queue, { ...item, id: 'other', waitingFor: 'audioRecovery' }] });
  w.c.drain = () => Promise.reject(new Error('retained queue is unavailable'));
  w.c.codex.request = async () => {
    observeVoice(w.c.codex, { kind: 'stopped' });
    return {};
  };
  await stopVoice(w.c.codex, 'native');
  await tick();
  assert.equal(voiceWriter(w.c, 'chat'), null);
  assert.equal(w.state.get('chat').queue[1].waitingFor, 'audioRecovery');
});

test('a definitive Start refusal after native closure cannot release a replacement writer', async () => {
  const w = world();
  const old = deferred<any>();
  w.c.codex.request = () => old.promise;
  const starting = w.start();
  await tick();
  observeVoice(w.c.codex, { kind: 'stopped' });
  w.c.codex.request = async () => ({});
  await w.start();
  const replacement = voiceWriter(w.c, 'chat');
  old.reject(Object.assign(new Error('old refusal'), { code: -32602 }));
  await assert.rejects(starting, /old refusal/);
  assert.equal(voiceWriter(w.c, 'chat'), replacement);
  observeVoice(w.c.codex, { kind: 'stopped' });
});

test("voice watches its adapter's server events once per adapter, and the server exiting releases the writer", async () => {
  const w = world();
  w.c.codex.request = async () => ({});
  await w.start();
  observeVoice(w.c.codex, { kind: 'stopped' });
  await w.start();
  assert.equal(w.c.codex.serverObservers.size, 1);
  assert.ok(voiceWriter(w.c, 'chat'));
  for (const observe of w.c.codex.serverObservers) observe({ kind: 'exit', code: 1 });
  assert.equal(voiceWriter(w.c, 'chat'), null);
});

test('the Codex adapter hands every server event to its observers before reading it itself', async () => {
  const { setup: adapterWorld } = await import('./support/codex-adapter/fixture.ts');
  const { a } = adapterWorld();
  const seen: any[] = [];
  a.serverObservers.add((evt: any) => seen.push([evt.kind, a.lastActivity]));
  a.now = () => 7;
  a.onServer({ kind: 'message', msg: { method: 'item/started', params: { threadId: 't' } } });
  assert.deepEqual(seen, [['message', 0]]);
  assert.equal(a.lastActivity, 7);
});

test("a permission that can't be applied releases the writer before anything starts, with nothing to stop", async () => {
  const w = world();
  w.c.codex.applyPermission = async () => {
    throw new Error("Couldn't apply this chat's permission: rejected");
  };
  await assert.rejects(w.start(), /permission: rejected/);
  // nothing reached the voice session, so no realtime start and no stop for an uncertain one
  assert.deepEqual(w.requests, []);
  assert.equal(voiceWriter(w.c, 'chat'), null);
  assert.deepEqual(w.pins, [
    ['native', true],
    ['native', false],
  ]);
});
