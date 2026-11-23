// src/store/threads.ts and connection.ts: a chat whose read failed says why with Retry; Retry restarts a Codex that is
// down before reading again, and a read that succeeds later takes the failed read's error away.
import { test, mock, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, impl, resetAll, flush, bootImpls, calls, listeners } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store, resetState } = await loadStore();
const S = store;
const st = () => S.useStore.getState();
const set = S.useStore.setState;
const { onCrashed } = await import('../src/store/connection.ts');
const { noteOwner } = await import('../src/harness/ownership.ts');
const turn = (id: string) => ({ id, status: 'completed', items: [], startedAt: 1, completedAt: 2, durationMs: 1000, error: null });
const DOWN = "Codex isn't connected";

before(async () => {
  bootImpls();
  await S.boot();
  await flush();
});
beforeEach(() => {
  resetState();
  resetAll();
  bootImpls();
  impl['session.snapshot'] = async () => null;
  impl['api.threadRead'] = async (id: string) => ({ thread: { id } });
});

/** Codex as main has it: down (every read fails at once) until a restart brings it back. */
function codexServer({ comesBack = true } = {}) {
  let down = true;
  impl['codex.restart'] = async () => true;
  impl['codex.connect'] = async () => {
    if (!comesBack) {
      set({ connError: 'Codex app-server exited (1).\nthread panicked' });
      throw new Error('Codex app-server exited');
    }
    down = false;
    return { codexHome: '/home/me/.codex', userAgent: 'ua' };
  };
  impl['api.threadTurns'] = async () => {
    if (down) throw new Error(DOWN);
    return { data: [turn('t1')], nextCursor: null };
  };
}

test('Retry on a Codex chat while Codex is down restarts Codex, then shows the chat', async () => {
  const id = 'codex-down';
  codexServer();
  set({ conn: 'error', codexRestart: 'gaveUp', route: { name: 'home' } as any });
  await S.openThread(id);
  assert.equal(st().runtime[id].error, DOWN);
  await S.retryOpen(id);
  await flush();
  assert.equal(callsOf('codex.restart').length, 1);
  assert.equal(st().conn, 'ready');
  assert.equal(st().codexRestart, null);
  assert.equal(st().runtime[id].error, null);
  assert.deepEqual(
    st().runtime[id].turns.map((t) => t.id),
    ['t1'],
  );
});

test('Retry while main is still bringing Codex back restarts it now rather than reading a Codex that is down', async () => {
  const id = 'codex-restarting';
  codexServer();
  set({ conn: 'ready', codexRestart: { attempt: 2, inMs: 4000 }, route: { name: 'home' } as any });
  await S.openThread(id);
  assert.equal(st().runtime[id].error, DOWN);
  await S.retryOpen(id);
  await flush();
  assert.equal(callsOf('codex.restart').length, 1);
  assert.equal(st().runtime[id].error, null);
});

test('Retry when Codex does not come back says why in short, and Retry stays', async () => {
  const id = 'codex-keeps-quitting';
  codexServer({ comesBack: false });
  set({ conn: 'error', codexRestart: 'gaveUp', route: { name: 'home' } as any });
  await S.openThread(id);
  await S.retryOpen(id);
  await flush();
  const rt = st().runtime[id];
  assert.equal(rt.loaded, true);
  assert.equal(rt.loading, false);
  assert.equal(rt.errorFromRead, true);
  // the short line Settings shows, never the app-server's stderr
  assert.ok(rt.error && !rt.error.includes('panicked'), rt.error ?? '');
  assert.equal(callsOf('api.threadTurns').length, 1);
});

test('Retry when a Codex copy keeps quitting as it starts names that copy, and says when it is the one the user picked', async () => {
  const id = 'codex-copy-quits';
  codexServer({ comesBack: false });
  const copy = { path: '/Applications/ChatGPT.app/codex', version: '0.163.0-alpha.10.2', via: 'app-bundle', from: 'ChatGPT.app' };
  set({ conn: 'error', codexRestart: 'gaveUp', codexQuit: { copy, pinned: false }, route: { name: 'home' } as any });
  await S.openThread(id);
  await S.retryOpen(id);
  assert.equal(st().runtime[id].error, 'Codex 0.163.0-alpha.10.2 from ChatGPT.app keeps quitting.');
  assert.equal(st().runtime[id].errorFromRead, true);
  set({ codexQuit: { copy, pinned: true } });
  await S.retryOpen(id);
  assert.equal(
    st().runtime[id].error,
    "Codex 0.163.0-alpha.10.2 from ChatGPT.app keeps quitting. It's the copy you picked, so MoPilot keeps using it.",
  );
  // a copy that connects is named no more
  codexServer();
  await S.retryOpen(id);
  assert.equal(st().codexQuit, null);
  assert.equal(st().runtime[id].error, null);
});

test('a restart main refuses is said on the chat', async () => {
  const id = 'codex-restart-refused';
  codexServer();
  impl['codex.restart'] = async () => {
    throw new Error('busy');
  };
  set({ conn: 'error', route: { name: 'home' } as any });
  await S.openThread(id);
  await S.retryOpen(id);
  assert.equal(st().runtime[id].error, 'busy');
  assert.equal(st().runtime[id].errorFromRead, true);
});

test('Retry on a Codex chat while Codex is up only reads again', async () => {
  const id = 'codex-up';
  let fail = true;
  impl['api.threadTurns'] = async () => {
    if (fail) throw new Error('read failed');
    return { data: [turn('t1')], nextCursor: null };
  };
  set({ conn: 'ready', codexRestart: null });
  await S.openThread(id);
  fail = false;
  await S.retryOpen(id);
  await flush();
  assert.equal(callsOf('codex.restart').length, 0);
  assert.equal(st().runtime[id].error, null);
});

test('Retry on a chat with no Codex part never restarts Codex, even while Codex is down', async () => {
  noteOwner('claude:solo', 'claude');
  set({ conn: 'error', segments: { sw: [{ nativeId: 'claude:x', harness: 'claude', start: 0 }] as any } });
  await S.retryOpen('claude:solo');
  await S.retryOpen('acp:kimi:solo');
  await S.retryOpen('sw');
  assert.equal(callsOf('codex.restart').length, 0);
});

test('Retry on a switched chat with a Codex part restarts a Codex that is down', async () => {
  codexServer();
  set({
    conn: 'error',
    route: { name: 'home' } as any,
    segments: {
      mixed: [
        { nativeId: 'mixed', harness: 'codex', start: 0 },
        { nativeId: 'claude:y', harness: 'claude', start: 1 },
      ] as any,
    },
  });
  await S.retryOpen('mixed');
  assert.equal(callsOf('codex.restart').length, 1);
});

test('Codex coming back by itself reloads the chat on screen, and that read takes the failed read away', async () => {
  const id = 'codex-back';
  codexServer();
  set({ conn: 'ready', route: { name: 'thread', id } as any });
  await S.openThread(id);
  assert.equal(st().runtime[id].error, DOWN);
  // main brought it back (its own restart): codex:status 'ready'
  await S.connect();
  await flush();
  assert.equal(st().runtime[id].error, null);
  assert.equal(st().runtime[id].errorFromRead, false);
  assert.deepEqual(
    st().runtime[id].turns.map((t) => t.id),
    ['t1'],
  );
});

test("a later read does not take away an error that isn't the read's (why a turn was refused)", async () => {
  const id = 'refused';
  impl['api.threadTurns'] = async () => ({ data: [turn('t1')], nextCursor: null });
  onCrashed(id, 'Codex is off for this chat');
  assert.equal(st().runtime[id].error, 'Codex is off for this chat');
  await S.openThread(id);
  assert.equal(st().runtime[id].error, 'Codex is off for this chat');
});

test('the shared restart clears the gave-up banner and connects again', async () => {
  codexServer();
  set({ conn: 'error', codexRestart: 'gaveUp' });
  calls.length = 0;
  await S.restartCodex();
  assert.deepEqual(
    calls.map(([n]) => n).filter((n) => n === 'codex.restart' || n === 'codex.connect'),
    ['codex.restart', 'codex.connect'],
  );
  assert.equal(st().codexRestart, null);
  assert.equal(st().conn, 'ready');
});

test('while Retry restarts Codex the chat shows it loading, and a second Retry joins that restart', async () => {
  const id = 'codex-double';
  codexServer();
  let release!: () => void;
  impl['codex.restart'] = () => new Promise<boolean>((r) => (release = () => r(true)));
  set({ conn: 'error', route: { name: 'thread', id } as any });
  await S.openThread(id);
  const first = S.retryOpen(id);
  await flush();
  assert.equal(st().runtime[id].loading, true);
  assert.equal(st().runtime[id].error, null);
  const second = S.retryOpen(id);
  await flush();
  // the second click neither restarts again nor reads the Codex that is still down
  assert.equal(callsOf('codex.restart').length, 1);
  assert.equal(callsOf('api.threadTurns').length, 1);
  release();
  await Promise.all([first, second]);
  await flush();
  assert.equal(st().runtime[id].error, null);
  assert.equal(st().runtime[id].loading, false);
  assert.deepEqual(
    st().runtime[id].turns.map((t) => t.id),
    ['t1'],
  );
});

test('a Codex that just quit (before main says it is restarting) counts as down for Retry', async () => {
  const id = 'codex-just-quit';
  codexServer();
  set({ conn: 'ready', codexRestart: null, route: { name: 'home' } as any });
  // main's exit, with a restart on the way: the window stays as it is, but connError says Codex went
  listeners['codex.onStatus']({ kind: 'exit', code: 1, stderr: '', restarting: true });
  assert.equal(st().conn, 'ready');
  await S.retryOpen(id);
  await flush();
  assert.equal(callsOf('codex.restart').length, 1);
  assert.equal(st().runtime[id].error, null);
});

test('a held chat hydrates its earlier history before clearing an initial read error', async () => {
  const id = 'codex-held';
  codexServer();
  set({ conn: 'ready' });
  await S.openThread(id);
  assert.equal(st().runtime[id].errorFromRead, true);
  // a turn started here: main holds the chat and the live stream is what it shows
  listeners['codex.onItem']({ kind: 'lease', threadId: id, held: true });
  const reads = callsOf('api.threadTurns').length;
  impl['api.threadTurns'] = async () => ({ data: [turn('earlier')], nextCursor: null });
  await S.openThread(id);
  assert.equal(st().runtime[id].error, null);
  assert.equal(callsOf('api.threadTurns').length, reads + 1);
  assert.equal(st().runtime[id].turns[0].id, 'earlier');
  // with nothing to drop, opening it again changes nothing
  const before = st().runtime[id];
  await S.openThread(id);
  assert.equal(st().runtime[id], before);
});
