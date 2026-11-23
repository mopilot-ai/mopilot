// The control indicator (electron/capabilities/controlIndicator.cjs) with its clickable pill (controlPill.cjs, #1579):
// the pill shows and hides with control, follows whether Codex Computer Use holds the desktop, its Stop stops the chat
// holding control as Esc does, and the overlay's badge hands the corner to it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rig } from './support/computer-use-setup-rig.ts';

const require = createRequire(import.meta.url);
const { ControlIndicator, overlayHtml, shownCss } = require('../electron/capabilities/controlIndicator.cjs');

test('the pill shows and hides with control, takes clickable updates, and its Stop stops the chat in control', () => {
  const calls: any[] = [];
  const pills: any = {
    windows: ['pill'],
    show: (clickable: boolean) => calls.push(['show', clickable]),
    hide: () => calls.push(['hide']),
    dispose: () => calls.push(['dispose']),
  };
  const stopped: string[] = [];
  const opened: string[] = [];
  let native = false;
  const ind = new ControlIndicator({
    electron: null,
    onEscape: (id: string) => stopped.push(id),
    onOpenChat: (id: string) => opened.push(id),
    pills,
    heldNatively: (id: string) => native && id === 'chat-1',
  });
  // nobody holds control: a Stop does nothing
  pills.onStop();
  pills.onOpen();
  ind.sync('chat-1');
  // a click on its label opens the chat in control
  pills.onOpen();
  assert.deepEqual(opened, ['chat-1']);
  // a person's Stop stops the chat holding control, as Esc does
  pills.onStop();
  assert.deepEqual(stopped, ['chat-1']);
  // the same chat keeps control while Codex Computer Use starts holding: the pill goes click-through
  native = true;
  ind.sync('chat-1');
  assert.deepEqual(calls, [
    ['show', true],
    ['show', false],
  ]);
  assert.deepEqual(ind.allWindows(), [...ind.windows, 'pill']);
  ind.sync(null);
  ind.dispose();
  assert.deepEqual(calls.slice(2), [['hide'], ['dispose']]);
  // without a pill, allWindows is the overlays alone, and no Codex hold is assumed
  const plain = new ControlIndicator({ electron: null, onEscape: () => undefined });
  const bare: any = { windows: [], show() {}, hide() {}, dispose() {} };
  const noOpen = new ControlIndicator({ electron: null, onEscape: () => undefined, pills: bare });
  noOpen.sync('c');
  bare.onOpen();
  assert.deepEqual(plain.allWindows(), plain.windows);
  assert.equal(plain.heldNatively('x'), false);
});

test('with the pill the badge flies to the corner and fades out there; without it, it stays', () => {
  assert.match(shownCss(1, true), /animation:badge-flight-b-handoff 6s/);
  assert.match(shownCss(2, true), /animation:badge-flight-a-handoff 6s/);
  assert.doesNotMatch(shownCss(1), /handoff/);
  // with reduced motion the badge waits in the corner either way (the pill then covers it)
  assert.match(shownCss(1, true), /^#overlay\{opacity:1\}#badge\{opacity:1;top:40px/);
  assert.match(overlayHtml(), /@keyframes badge-flight-a-handoff\{[^@]*96%\{opacity:1;top:40px[^@]*100%\{opacity:0;top:40px/);
  assert.match(overlayHtml(), /@keyframes badge-flight-b-handoff\{/);
});

test('an indicator with a pill inserts the handoff sheet when it fades in', async () => {
  const inserted: string[] = [];
  class BrowserWindow {
    webContents = {
      insertCSS: async (css: string) => (inserted.push(css), 'k1'),
      removeInsertedCSS: async () => undefined,
    };
    setIgnoreMouseEvents() {}
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setContentProtection() {}
    loadURL() {
      return Promise.resolve();
    }
    setBounds() {}
    showInactive() {}
    hide() {}
    isDestroyed() {
      return false;
    }
    destroy() {}
  }
  const electron = {
    BrowserWindow,
    screen: { getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 800, height: 600 } }] },
    globalShortcut: { register: () => true, unregister: () => undefined },
  };
  const pills = { windows: [], show() {}, hide() {}, dispose() {} };
  const ind = new ControlIndicator({ electron, onEscape: () => undefined, pills, fadeMs: 1 });
  ind.sync('chat-1');
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(inserted, [shownCss(1, true)]);
  ind.dispose();
});

test('the pill’s label opens the chat holding control; with no opener it does nothing', () => {
  const opened: string[] = [];
  const r = rig({ codex: { showChat: (id: string) => opened.push(id) } });
  r.runtime.indicator.chatId = 'chat-1';
  r.runtime.indicator.pills.onOpen();
  assert.deepEqual(opened, ['chat-1']);
  const bare = rig();
  bare.runtime.indicator.chatId = 'chat-1';
  bare.runtime.indicator.pills.onOpen();
});
