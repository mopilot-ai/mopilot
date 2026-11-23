// Production preview wiring must consult the current chat owner before reading this Mac's project configuration.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

// The browser-launch shim is a transport boundary; no socket or child process is needed for preview listing.
mock.module('../electron/capabilities/browser/browserShim.cjs', {
  namedExports: {
    BrowserShim: class {
      async listen() {}
      env() {
        return {};
      }
      close() {}
    },
  },
});
const require = createRequire(import.meta.url);
const { createDevPreviewWiring } = require('../electron/app/devPreviewWiring.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');

test('wired preview tools reread ownership for every harness and after project resolution', async () => {
  const registry = new Registry();
  const app = new EventEmitter();
  let projectReads = 0;
  let owner = 'local';
  let moveDuringRead = false;
  const live: any = { capabilities: registry };
  const before = new Set(process.listeners('exit'));
  const wiring = createDevPreviewWiring({
    app,
    shellEnv: { setExtraEnv() {}, childEnv: () => ({}) },
    isFlagEnabled: () => true,
    chatProject: async () => {
      projectReads++;
      if (moveDuringRead) owner = 'remote';
      return null;
    },
    live,
    browser: { tabs: {}, grants: {} },
  });
  let call = 0;
  const list = (chatId: string) => registry.invoke(chatId, 's', 'browser_preview_list', {}, { callId: `p-${++call}` });
  try {
    wiring.registerDevPreviews('/unused-preview-wiring-test');
    assert.equal((await list('local-without-host-service')).ok, true);
    live.hostOwnership = { get: () => ({ hostId: owner }) };
    for (const chatId of ['claude:chat', 'codex:chat', 'acp:kimi:chat']) {
      owner = 'local';
      assert.equal((await list(chatId)).ok, true);
      const reads = projectReads;
      owner = 'remote';
      const refused = await list(chatId);
      assert.equal(refused.ok, false);
      assert.equal(refused.error.code, 'unavailable');
      assert.equal(projectReads, reads, 'remote ownership must refuse before reading this Mac project');
      owner = 'local';
      assert.equal((await list(chatId)).ok, true, 'returning local must not retain the remote refusal');
    }
    moveDuringRead = true;
    const moved = await list('claude:chat');
    assert.equal(moved.ok, false);
    assert.equal(moved.error.code, 'unavailable', 'a move while resolving the project invalidates the local read');
  } finally {
    app.emit('will-quit');
    for (const listener of process.listeners('exit')) if (!before.has(listener)) process.removeListener('exit', listener);
  }
});

test('restoration requires the current active local chat, project and permission on every harness', async () => {
  const app = new EventEmitter();
  const before = new Set(process.listeners('exit'));
  let archived: number | null = null,
    hostId = 'local',
    mode = 'full',
    enabled = true;
  let project: string | null = '/project';
  let afterRead = () => {};
  let deleted = false;
  const live: any = {
    capabilities: new Registry(),
    chatDeletion: { isDeleted: () => deleted },
    chats: { record: () => ({ meta: { archived } }) },
    hostOwnership: { get: () => ({ hostId }) },
  };
  const wiring = createDevPreviewWiring({
    app,
    shellEnv: { setExtraEnv() {}, childEnv: () => ({}) },
    isFlagEnabled: () => enabled,
    chatProject: async () => {
      afterRead();
      return project;
    },
    live,
    browser: { tabs: {}, grants: { anchor: () => mode } },
  });
  try {
    assert.equal(wiring.prepare('chat', 'http://127.0.0.1:4317/'), null);
    wiring.registerDevPreviews('/unused-preview-wiring-test');
    assert.equal(wiring.prepare('chat', 'http://127.0.0.1:4317/'), null);
    const stop = mock.method(wiring.devPreviews, 'stopChat', () => {});
    live.chatDeletion.onDeleted({ chatId: 'deleted-chat' });
    assert.deepEqual(
      stop.mock.calls.map((call: any) => call.arguments),
      [['deleted-chat']],
    );
    stop.mock.restore();
    for (const chatId of ['codex:chat', 'claude:chat', 'acp:kimi:chat']) {
      const record = { chatId, launch: { project: '/project' } };
      const allowed = () => wiring.devPreviews.canRestore(record);
      assert.equal(await allowed(), true);
      for (const change of [
        () => (archived = 0),
        () => (deleted = true),
        () => (hostId = 'remote'),
        () => (mode = 'readOnly'),
        () => (enabled = false),
        () => (project = '/different-project'),
      ]) {
        change();
        assert.equal(await allowed(), false);
        archived = null;
        deleted = false;
        hostId = 'local';
        mode = 'full';
        enabled = true;
        project = '/project';
      }
      afterRead = () => (hostId = 'remote');
      assert.equal(await allowed(), false, 'ownership must still hold after project resolution');
      hostId = 'local';
      afterRead = () => {};
      mode = 'ask';
      assert.equal(await allowed(), true, 'the exact saved command already has approval');
      delete live.hostOwnership;
      assert.equal(await allowed(), true, 'a local chat works before the optional Host service');
      live.hostOwnership = { get: () => ({ hostId }) };
    }
    live.chats.record = () => null;
    assert.equal(await wiring.devPreviews.canRestore({ chatId: 'gone', launch: { project } }), false);
  } finally {
    app.emit('will-quit');
    for (const listener of process.listeners('exit')) if (!before.has(listener)) process.removeListener('exit', listener);
  }
});
