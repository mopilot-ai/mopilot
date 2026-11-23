// electron/main.cjs: Chrome's side panel is wired at startup. Its requests reach the panel main made, and its ↗ opens the chat (or the window) through the main window's command.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadMain, unloadMain, flush } from './support/electron-main-harness.ts';

const require = createRequire(import.meta.url);
const realRelay = require('../electron/app/chromeRelay.cjs');

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
after(() => unloadMain());

test('the side panel: its requests go to the panel main made; ↗ opens the chat, or the window with none named', async () => {
  const relays: any[] = [];
  const h = await loadMain({
    before: (hh) => {
      // MoPilot's own Chrome extension is the channel (the harness has every Chrome flag off)
      const flags = hh.mods['electron/platform/flags.cjs'];
      const isEnabled = flags.isEnabled;
      flags.isEnabled = (k: string) => k === 'shared.browser.chromeExtension' || isEnabled(k);
      hh.mods['electron/capabilities/browser/chromePanel.cjs'] = {
        ChromePanel: hh.cls('ChromePanel'),
        stateOf: () => 'idle',
        tabLine: () => null,
      };
      hh.mods['electron/app/chromeRelay.cjs'] = {
        ...realRelay,
        extensionShipped: () => true,
        setupChromeRelay: (o: any) => (
          relays.push(o), { relay: {}, screenshots: () => null, stop: () => undefined, onSessionPatch: () => undefined }
        ),
      };
    },
  });
  await h.ready();
  await flush(50);
  const panel = h.one('ChromePanel');
  // the extension's panel requests reach it
  const reply = () => undefined;
  relays[0].panel({ id: 1, method: 'recent' }, reply);
  assert.deepEqual(panel.handle.mock.calls[0].arguments, [{ id: 1, method: 'recent' }, reply]);
  // ↗ on a chat opens it in the main window (once its renderer listens); with none, the window comes to the front
  void panel.opts.open('chat-1');
  await flush();
  assert.equal(h.windows.length, 1, 'a window opens for the chat');
  const win = h.windows[0];
  win.hide();
  win.log.length = 0;
  void panel.opts.open(null);
  await flush();
  assert.equal(win.isVisible(), true);
  assert.deepEqual(win.log, ['show', 'focus'], 'this action brings the hidden window forward');
  // a page the panel names (Scheduled) is the main window's command
  void panel.opts.open(null, 'scheduled');
  await flush();
  assert.equal(h.windows.length, 1);
  // a session change reaches the phones that follow the chat, through the panel's service
  const patch = { chatId: 'c1', rev: 2, patch: { plan: true } };
  panel.service = undefined;
  h.one('SessionStore').opts.publish(patch);
  panel.service = { onSessionPatch: mock.fn() };
  h.one('SessionStore').opts.publish(patch);
  assert.deepEqual(panel.service.onSessionPatch.mock.calls[0].arguments, [patch]);
});
