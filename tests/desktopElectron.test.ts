// electron/app/computerAccess.cjs desktopElectron: the Electron modules the desktop_* tools get (windows from main, plus app icons and Reduce Motion).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { desktopElectron } = require('../electron/app/computerAccess.cjs');

test('desktopElectron keeps the window modules and adds nativeImage and systemPreferences', () => {
  const modules = { BrowserWindow: class {}, screen: {}, globalShortcut: {}, clipboard: {}, app: {} };
  const out = desktopElectron(modules);
  for (const k of Object.keys(modules)) assert.equal(out[k], (modules as any)[k]);
  assert.ok('nativeImage' in out && 'systemPreferences' in out);
});
