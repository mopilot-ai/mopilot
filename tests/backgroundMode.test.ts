// electron/app/backgroundMode.cjs: E2E instances open windows without focus, hide the Dock icon and post no OS notifications.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { applyBackgroundMode } = createRequire(import.meta.url)('../electron/app/backgroundMode.cjs');

/** Fresh stand-ins for Electron's classes, so one case's patching cannot leak into the next. */
function fakes({ dock = true } = {}) {
  const shown: string[] = [];
  class BrowserWindow {
    show() {
      shown.push('show');
    }
    showInactive() {
      shown.push('showInactive');
    }
    focus() {
      shown.push('focus');
    }
  }
  class Notification {
    show() {
      shown.push('notification');
    }
  }
  const hide = mock.fn();
  const app = dock ? { dock: { hide } } : {};
  return { shown, hide, deps: { app, BrowserWindow, Notification } };
}

test('without SAGE_E2E_BACKGROUND=1 nothing changes', () => {
  for (const env of [{}, { SAGE_E2E_BACKGROUND: 'true' }]) {
    const { shown, hide, deps } = fakes();
    assert.equal(applyBackgroundMode({ ...deps, env }), false);
    const win = new deps.BrowserWindow();
    win.show();
    win.focus();
    new deps.Notification().show();
    assert.deepEqual(shown, ['show', 'focus', 'notification']);
    assert.equal(hide.mock.callCount(), 0);
  }
  const { deps } = fakes();
  assert.equal(applyBackgroundMode(deps), process.env.SAGE_E2E_BACKGROUND === '1');
});

test('in background mode a window shows without focus, focus is ignored, the Dock icon hides and notifications stay quiet', () => {
  const { shown, hide, deps } = fakes();
  assert.equal(applyBackgroundMode({ ...deps, env: { SAGE_E2E_BACKGROUND: '1' } }), true);
  const win = new deps.BrowserWindow();
  win.show();
  win.focus();
  new deps.Notification().show();
  assert.deepEqual(shown, ['showInactive']);
  assert.equal(hide.mock.callCount(), 1);
});

test('platforms without a Dock (Windows, Linux) still get the rest', () => {
  const { shown, deps } = fakes({ dock: false });
  assert.equal(applyBackgroundMode({ ...deps, env: { SAGE_E2E_BACKGROUND: '1' } }), true);
  new deps.BrowserWindow().show();
  assert.deepEqual(shown, ['showInactive']);
});
