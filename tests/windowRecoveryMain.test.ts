// Main's app windows come back when their renderer is gone, reported once with their window named (electron/main.cjs → app/windows.cjs, app/lifecycle.cjs, platform/windowRecovery.cjs; #4424).
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain, unloadMain } from './support/electron-main-harness.ts';

after(() => unloadMain());
const calls = (f: any) => f.mock.calls.map((c: any) => c.arguments);

test("an app window's gone renderer reloads and is reported by its recovery, not again as a generic renderer", async () => {
  const h = await loadMain({ state: { prefs: { shareUsageData: true } } });
  await h.ready();
  const t = h.one('Telemetry');
  const w = h.windows[0];
  w.webContents.reload = mock.fn();
  const before = calls(t.error).length;

  // the app-wide event for an app window's renderer is left to its recovery
  h.app.emit('render-process-gone', {}, w.webContents, { reason: 'oom', exitCode: 5 });
  w.webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 5 });
  assert.equal(w.webContents.reload.mock.callCount(), 1);
  // another renderer (a browser tab's) is still reported by lifecycle
  h.app.emit('render-process-gone', {}, {}, { reason: 'crashed', exitCode: 3 });
  assert.deepEqual(
    calls(t.error)
      .slice(before)
      .map((c: any) => [c[0].message, c[0].kind]),
    [
      ['app window renderer gone: oom (5)', 'window-problem'],
      ['renderer gone: crashed (3)', 'process-gone'],
    ],
  );
});
