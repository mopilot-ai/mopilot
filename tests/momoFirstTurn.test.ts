// #2326 / #2139: the first turn of a new MoMo Codex thread. The mark on the start decides isolation, not the chat's meta: a
// thread MoMo's app-server holds is always gated (memory off, shell confirmed off), even before the chat's `momo` meta or the
// thread-to-chat mapping is written (ChatStarter writes the meta after the thread starts, before any window hears of it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fakeCodexSpawn } from './support/codex-harness/fakeCodexProcess.ts';

const require = createRequire(import.meta.url);
const { AppServer, CodexAdapter } = require('../electron/harness/codex.cjs');
const { IsolatedServer } = require('../electron/harness/codexIsolatedServer.cjs');
const { ISOLATED_THREAD } = require('../electron/harness/codexIsolation.cjs');
const { SessionStore } = require('../electron/session/state.cjs');

function rig(shellOn: boolean) {
  const main = fakeCodexSpawn('main', { initialize: () => ({ userAgent: 'codex_cli_rs/0.162.1' }) });
  const momo = fakeCodexSpawn('momo', {
    initialize: () => ({ userAgent: 'codex_cli_rs/0.162.1' }),
    'thread/start': () => ({ thread: { id: 'momo-th', cwd: '/momo', ephemeral: false } }),
    'config/read': () => ({ config: { features: { shell_tool: shellOn, unified_exec: false, view_image: false } } }),
    'turn/start': () => ({ turn: { id: 'turn-1' } }),
  });
  const server = new AppServer({ spawn: main.spawn, findBin: () => '/bin/codex', env: () => ({}) });
  // the chat's meta is not written yet: no chat is MoMo's as far as the predicate knows
  const adapter = new CodexAdapter({ server, state: new SessionStore(), isolated: () => false, probe: null, now: () => 1 });
  new IsolatedServer({
    main: server,
    server: new AppServer({ spawn: momo.spawn, findBin: () => '/bin/codex', env: () => ({}) }),
    owns: (threadId: string) => adapter.isolation.applies({ threadId }),
    prepare: () => {},
    login: async () => null,
  });
  return { adapter, main, momo, server };
}

test('a thread MoMo’s app-server started is gated on its first turn though the chat’s meta is not written yet: a shell that is on refuses it', async () => {
  const r = rig(true);
  const started = await r.adapter.startThread({ [ISOLATED_THREAD]: true, cwd: '/momo' });
  assert.equal(started.thread.id, 'momo-th');
  assert.equal(r.adapter.isolation.applies({ threadId: 'momo-th' }), true);
  await assert.rejects(
    r.adapter.request('turn/start', { threadId: 'momo-th', input: [{ type: 'text', text: 'hi', text_elements: [] }] }),
    /shell isn't confirmed off/,
  );
  // nothing ran, on either server
  assert.equal(
    r.momo.sent().some((m: any) => m.method === 'turn/start'),
    false,
  );
  assert.equal(
    r.main.sent().some((m: any) => m.method === 'turn/start'),
    false,
  );
  r.server.stop();
});

test('with the shell confirmed off the same first turn runs, on MoMo’s app-server, with its memory turned off first', async () => {
  const r = rig(false);
  await r.adapter.startThread({ [ISOLATED_THREAD]: true, cwd: '/momo' });
  await r.adapter.request('turn/start', { threadId: 'momo-th', input: [{ type: 'text', text: 'hi', text_elements: [] }] });
  const sent = r.momo.sent().map((m: any) => m.method);
  assert.ok(sent.indexOf('thread/memoryMode/set') >= 0 && sent.indexOf('thread/memoryMode/set') < sent.indexOf('turn/start'));
  assert.equal(
    r.main.sent().some((m: any) => m.method === 'turn/start'),
    false,
  );
  // a thread the main app-server holds is not gated by this
  assert.equal(r.adapter.isolation.applies({ threadId: 'coding-th' }), false);
  r.server.stop();
});
