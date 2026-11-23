// Windows' caption buttons in the frame's colors (src/lib/titleBarOverlay.ts), with the palette as the fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { DEFAULT_PALETTE } from '../shared/defaultPalette.mjs';
import { installNativeStub } from './support/ports/native.ts';

const calls: unknown[][] = [];
let fail = false;
installNativeStub({
  win: {
    setTitleBarOverlay: async (...args: unknown[]) => {
      calls.push(args);
      if (fail) throw new Error('no overlay');
    },
  },
});
const { syncTitleBarOverlay } = await import('../src/lib/titleBarOverlay.ts');

test('the Windows caption buttons take the chat colors, with the palette as the fallback', async () => {
  const app = document.createElement('div');
  app.className = 'app';
  syncTitleBarOverlay(true, false); // not Windows
  syncTitleBarOverlay(true, true); // no .app in the document yet
  assert.deepEqual(calls, []);
  document.body.append(app);
  try {
    syncTitleBarOverlay(true, true);
    syncTitleBarOverlay(false, true);
    app.style.setProperty('--main', '#123456');
    app.style.setProperty('--text', '#fefefe');
    syncTitleBarOverlay(false, true);
    // a failed call is cosmetic: the buttons keep their last colors and nothing throws
    fail = true;
    syncTitleBarOverlay(false, true);
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    app.remove();
  }
  assert.deepEqual(calls, [
    [DEFAULT_PALETTE.dark.bg, DEFAULT_PALETTE.dark.fg],
    [DEFAULT_PALETTE.light.bg, DEFAULT_PALETTE.light.fg],
    ['#123456', '#fefefe'],
    ['#123456', '#fefefe'],
  ]);
});
