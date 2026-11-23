// How main wires the built-in browser's page edge states (electron/app/browserTools.cjs, electron/app/ipc/browser.cjs):
// the dialog preload in every pane session and its synchronous question, the pane's answers and notice actions, a
// beforeunload asked on the window showing the page, pages that stop responding, frames' app links, and the
// hand-off route reading whether Your Chrome's extension is there.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadMain, unloadMain, flush } from './support/electron-main-harness.ts';
import { bindActualControllerPlans } from './support/main-controller-plan.ts';
import { browserPartition } from '../shared/browserStorage.mjs';

const require = createRequire(import.meta.url);
const { PAGE_DIALOG_CHANNEL, PAGE_PRELOAD } = require('../electron/capabilities/browser/pageDialogs.cjs');
after(() => unloadMain());

async function main() {
  const h = await loadMain({
    before: (h) => {
      h.mods['electron/capabilities/browser/hostTools.cjs'] = { registerBrowserTools: mock.fn(), inAppBrowserEnabled: mock.fn(() => true) };
      h.electron.session.fromPartition('persist:browser').registerPreloadScript = mock.fn();
      h.electron.dialog.showMessageBoxSync = mock.fn(() => 0);
    },
  });
  await h.ready();
  await flush();
  /** A pane page main registered (a view: its notices go to every window). */
  const page = (o: any = {}) => {
    const wc = h.wc({ session: h.electron.session.fromPartition('persist:browser'), url: 'https://task.test/', ...o });
    wc.getURL = () => wc.url;
    wc.isCrashed = () => false;
    wc.forcefullyCrashRenderer = mock.fn(() => wc.emit('render-process-gone', {}, { reason: 'killed' }));
    h.one('PaneViews').opts.onCreated(wc);
    return wc;
  };
  const notices = () => h.windows[0].webContents.on_('browser:event').map((m: any[]) => m[0]);
  return { h, page, notices };
}

test('the dialog preload goes into the shared profile and every chat partition, and its question is answered from the pane', async () => {
  const { h, page, notices } = await main();
  const shared = h.electron.session.fromPartition('persist:browser');
  assert.deepEqual(shared.registerPreloadScript.mock.calls[0].arguments, [
    { type: 'frame', id: 'mopilot-page-dialogs', filePath: PAGE_PRELOAD },
  ]);
  // a chat's own partition is set up the first time it is used, with the preload too
  const chat = browserPartition('session', 'chat-1');
  h.electron.session.fromPartition(chat).registerPreloadScript = mock.fn();
  h.one('PaneViews').opts.partition(chat);
  assert.equal(h.electron.session.fromPartition(chat).registerPreloadScript.mock.callCount(), 1);
  // the page asks; it waits until the pane answers
  const wc = page();
  const ask = h.listeners.get(PAGE_DIALOG_CHANNEL)!;
  const event: any = { sender: wc };
  ask(event, 'prompt', 'Type the draft name', 'x');
  assert.equal('returnValue' in event, false);
  const shown = notices().at(-1);
  assert.deepEqual(shown.dialog, { id: 1, type: 'prompt', message: 'Type the draft name', defaultPrompt: 'x', frame: '' });
  assert.equal(await h.invoke('browser:answerDialog', wc.id, shown.dialog.id, true, 'Q3 plan'), true);
  assert.equal(event.returnValue, 'Q3 plan');
  const confirm: any = { sender: wc };
  ask(confirm, 'confirm', 'Sure?', '');
  assert.equal(await h.invoke('browser:answerDialog', wc.id, 2, true, 7), true);
  assert.equal(confirm.returnValue, true);
  // a sender that isn't a pane page, or none, is dismissed at once
  const stranger: any = { sender: h.wc() };
  ask(stranger, 'confirm', 'x', '');
  assert.equal(stranger.returnValue, false);
  const nobody: any = { sender: undefined };
  ask(nobody, 'alert', 'x', '');
  assert.equal(nobody.returnValue, null);
});

test('a page that asks to confirm leaving is asked about on the window showing it, and left when none does', async () => {
  const { h, page } = await main();
  const unload = (wc: any) => {
    const e = { left: false, preventDefault: () => (e.left = true) };
    wc.emit('will-prevent-unload', e);
    return e.left;
  };
  // no window shows a parked view: nobody to ask
  assert.equal(unload(page()), true);
  assert.equal(h.electron.dialog.showMessageBoxSync.mock.callCount(), 0);
  // a <webview> in a window: Chrome's question on that window, Leave or Cancel, only while the user is at it
  const win = h.windows[0];
  const guest = page({ hostWebContents: win.webContents });
  win.focused = false;
  assert.equal(unload(guest), true);
  assert.equal(h.electron.dialog.showMessageBoxSync.mock.callCount(), 0, 'nobody at the window: never a question that holds main');
  win.focused = true;
  assert.equal(unload(guest), true);
  const [owner, options] = h.electron.dialog.showMessageBoxSync.mock.calls[0].arguments;
  assert.equal(owner, win);
  assert.deepEqual([options.message, options.buttons], ['Leave site?', ['Leave', 'Cancel']]);
  h.electron.dialog.showMessageBoxSync.mock.mockImplementation(() => 1);
  assert.equal(unload(guest), false);
  win.destroyed = true;
  assert.equal(unload(guest), true, 'its window went: nobody to ask');
});

test('notice actions reach main: an app link opens only on the click, a notice is put away, a hung page is stopped', async () => {
  const { h, page, notices } = await main();
  const wc = page();
  wc.emit('will-navigate', { preventDefault() {} }, 'zoommtg://zoom.us/join?confno=1');
  assert.equal(notices().at(-1).reason, 'app-link');
  assert.equal(h.electron.shell.openExternal.mock.callCount(), 0);
  await assert.rejects(
    Promise.resolve().then(() => h.invoke('browser:openAppLink', wc.id, -1)),
    /another app link now/,
  );
  assert.equal(await h.invoke('browser:openAppLink', wc.id, notices().at(-1).link), true);
  assert.deepEqual(h.electron.shell.openExternal.mock.calls.at(-1).arguments, ['zoommtg://zoom.us/join?confno=1']);
  // a frame's app link (Electron asks the openExternal permission): the same notice
  h.one('WebPermissions').opts.external(wc, 'mailto:a@b.c');
  assert.match(notices().at(-1).message, /an app \(mailto:\)/);
  assert.equal(await h.invoke('browser:dismissNotice', wc.id), true);
  assert.equal(notices().at(-1).kind, 'ready');
  // the pane's passkey choices reach the page, the legacy one included (nothing waits here)
  assert.equal(await h.invoke('browser:cancelPasskey', wc.id, true), 0);
  // a page whose script is busy: the pane says so, unless the page waits on its own dialog
  const ask = h.listeners.get(PAGE_DIALOG_CHANNEL)!;
  ask({ sender: wc }, 'alert', 'Saved', '');
  wc.emit('unresponsive');
  assert.notEqual(notices().at(-1).kind, 'unresponsive');
  await h.invoke('browser:answerDialog', wc.id, null, true, null);
  wc.emit('unresponsive');
  assert.equal(notices().at(-1).kind, 'unresponsive');
  assert.equal(await h.invoke('browser:stopPage', wc.id), true);
  assert.equal(wc.forcefullyCrashRenderer.mock.callCount(), 1);
  assert.equal(notices().at(-1).kind, 'crashed');
  // a stopped popup window loads again in its new renderer
  wc.reload = mock.fn();
  assert.equal(await h.invoke('browser:reloadPage', wc.id), true);
  assert.equal(wc.reload.mock.callCount(), 1);
  // a form result's Resubmit posts the form the page sent again (formPosts.cjs); with none kept, it says so
  wc.loadURL = mock.fn(async () => undefined);
  await assert.rejects(h.invoke('browser:resubmitPage', wc.id), /form data is gone/);
  const { record } = require('../electron/capabilities/browser/formPosts.cjs');
  record({ method: 'POST', url: 'https://task.test/', webContentsId: wc.id, uploadData: [{ bytes: Buffer.from('case=1') }] }, () => wc);
  assert.equal(await h.invoke('browser:resubmitPage', wc.id), true);
  const [url, opts] = wc.loadURL.mock.calls[0].arguments;
  assert.deepEqual(
    [url, String(opts.postData[0].bytes), opts.extraHeaders],
    ['https://task.test/', 'case=1', 'Content-Type: application/x-www-form-urlencoded'],
  );
  // the tab menu's Mute tab: main answers what the page is now
  let muted = false;
  wc.setAudioMuted = mock.fn((m: boolean) => (muted = m));
  wc.isAudioMuted = () => muted;
  assert.equal(await h.invoke('browser:setAudioMuted', wc.id, true), true);
  assert.equal(await h.invoke('browser:setAudioMuted', wc.id, 'yes'), false);
  assert.deepEqual(
    wc.setAudioMuted.mock.calls.map((c: any) => c.arguments),
    [[true], [false]],
  );
});

test("the hand-off route reads whether Your Chrome's extension is in Chrome", async () => {
  const { h } = await main();
  const migration = h.mod('electron/capabilities/browser/chromeMigration.cjs');
  // A route query takes only the chat id, but an absent capability snapshot must stay fail-closed.
  const readsBefore = migration.installedExtensionVersion.mock.callCount();
  assert.equal(await h.invoke('browser:handoffRoute', 'chat'), 'none');
  assert.equal(migration.installedExtensionVersion.mock.callCount(), readsBefore);
  h.one('ChatController').ref = () => ({ kind: 'codex', id: 'thread', key: 'thread' });
  h.one('Registry').list = () => [{ name: 'sage_browser_snapshot' }];
  const tools = h.one('CodexToolInjection');
  tools.hasTools = () => true;
  tools.toolsOf = () => null;
  tools.loadedPath = () => null;
  tools.routedSurfaces = () => ({ surfaces: {} });
  const plans = bindActualControllerPlans(h);
  assert.equal(Object.hasOwn(h.one('ControllerPlans'), 'snapshot'), true);
  assert.equal(plans.snapshot('chat').channel, true);
  assert.deepEqual(plans.snapshot('chat').tools, ['sage_browser_snapshot']);
  assert.equal(await h.invoke('browser:handoffRoute', 'chat'), 'your-chrome');
  migration.installedExtensionVersion.mock.mockImplementation(() => null);
  assert.equal(await h.invoke('browser:handoffRoute', 'chat'), 'setup');
  assert.deepEqual(migration.installedExtensionVersion.mock.calls.at(-1).arguments, [{ profileDir: null }]);
  // a saved connection token, or agents already working in Your Chrome, mean the extension is there
  h.one('ChromeTokens').has = mock.fn(() => true);
  assert.equal(await h.invoke('browser:handoffRoute', 'chat'), 'your-chrome');
  h.one('ChromeTokens').has = mock.fn(() => false);
  await h.invoke('browser:configure', { channel: 'chrome', profileDir: '' });
  const reads = migration.installedExtensionVersion.mock.callCount();
  assert.equal(await h.invoke('browser:handoffRoute', 'chat'), 'your-chrome');
  assert.equal(migration.installedExtensionVersion.mock.callCount(), reads);
  // A loaded session with no MCP tools cannot use Your Chrome merely because its extension or channel exists.
  tools.toolsOf = () => [];
  assert.equal(await h.invoke('browser:handoffRoute', 'chat'), 'none');
  assert.equal(migration.installedExtensionVersion.mock.callCount(), reads);
});
