// Ways on from store-level dead ends (#1523): the chat view's Retry after a chat failed to load (threads.ts retryOpen),
// and "Check for updates" on the note that chats from a newer version open read-only (boot.ts).
import { test, mock, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, flush, bootImpls, callsOf } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store } = await loadStore();
const S = store;

before(async () => {
  bootImpls({ 'chats.snapshot': async () => ({ chats: {}, newer: ['x'] }) });
  await S.boot();
  await flush();
});

test('Retry clears the error and reads the chat again', async () => {
  S.useStore.setState({ runtime: { x: { loaded: true, loading: false, turns: [], error: 'Boom' } as any } });
  const reads = callsOf('api.threadResume').length + callsOf('api.threadRead').length;
  S.retryOpen('x');
  assert.equal(S.useStore.getState().runtime.x.error, null);
  await flush();
  assert.ok(callsOf('api.threadResume').length + callsOf('api.threadRead').length > reads, 'read again');
});

test('chats saved by a newer version: the note offers Check for updates, which opens Settings → About', async () => {
  const note = S.useStore.getState().toasts.find((t) => /newer version/.test(t.text))!;
  assert.equal(note.action!.label, 'Check for updates');
  note.action!.run();
  await flush();
  await flush();
  assert.deepEqual([S.useStore.getState().route.name, (S.useStore.getState().route as any).section], ['settings', 'about']);
});
