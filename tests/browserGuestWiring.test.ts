// How main sets up the built-in browser's pages (electron/app/browserTools.cjs): MoPilot's page-dialog preload in
// every pane session (the shared profile and a chat's own), so Electron's native sheet never shows for a page's dialog,
// and a legacy <webview> guest sandboxed with no Node, the preload reaching its frames.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { loadMain, unloadMain, flush } from './support/electron-main-harness.ts';
import { SHARED_PARTITION, browserPartition } from '../shared/browserStorage.mjs';

after(() => unloadMain());
const preloads = (ses: any) => ses.registerPreloadScript.mock.calls.map((c: any) => c.arguments[0].id);

test("the page dialogs' preload is in the shared profile and in a chat's own partition; guests are sandboxed", async () => {
  const h = await loadMain();
  await h.ready();
  await flush();
  assert.deepEqual(preloads(h.electron.session.fromPartition(SHARED_PARTITION)), ['mopilot-page-dialogs']);
  // a window attaches a guest in a chat's own partition
  const host: any = Object.assign(new EventEmitter(), { getType: () => 'window', setWindowOpenHandler() {} });
  h.app.emit('web-contents-created', {}, host);
  const chat = browserPartition('session', 'chat-1');
  const prefs: any = { preload: '/app/preload.js', nodeIntegration: true };
  const params: any = { partition: chat };
  host.emit('will-attach-webview', { preventDefault: () => assert.fail('a legacy guest attaches') }, prefs, params);
  assert.equal(params.partition, chat);
  assert.deepEqual(preloads(h.electron.session.fromPartition(chat)), ['mopilot-page-dialogs']);
  assert.deepEqual(
    {
      preload: prefs.preload,
      nodeIntegration: prefs.nodeIntegration,
      nodeIntegrationInSubFrames: prefs.nodeIntegrationInSubFrames,
      contextIsolation: prefs.contextIsolation,
      sandbox: prefs.sandbox,
    },
    { preload: undefined, nodeIntegration: false, nodeIntegrationInSubFrames: true, contextIsolation: true, sandbox: true },
  );
});
