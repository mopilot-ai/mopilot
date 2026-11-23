// Help > Capture Performance Profile: records the focused window with electron/perf/cpuProfile.cjs, tells the user when it starts, where the file went (revealed in the file manager) or why nothing was recorded.
const path = require('node:path');
const { createCpuProfiler } = require('./cpuProfile.cjs');

const FAILED = {
  busy: 'A profile is already recording.',
  'no-window': 'No window to profile.',
  attached: 'DevTools is open on this window. Close it and try again.',
  'attach-failed': 'Could not attach to the window.',
  'window-closed': 'The window closed before the profile finished.',
  failed: 'The profile failed.',
};

/**
 * @param {{ shell: { showItemInFolder: (file: string) => void }, appName: string, pickWindow: () => Electron.BrowserWindow | null | undefined,
 *           ignored: (what: string, error: unknown) => void, notice: (n: { title: string, body: string }) => void,
 *           native?: () => typeof import('electron') }} deps `notice`: an OS notification, through electron/platform/notify.cjs
 * @returns {() => Promise<void>} the menu item's action; it never rejects
 */
function createProfileAction({ shell, appName, pickWindow, ignored, notice, native = () => require('electron') }) {
  const profiler = createCpuProfiler({
    dir: () => path.join(native().app.getPath('userData'), 'perf'),
    reveal: (file) => shell.showItemInFolder(file),
    ignored,
  });
  return async () => {
    try {
      const { dialog } = native();
      const result = await profiler.capture(pickWindow(), {
        onStart: () => notice({ title: appName, body: 'Recording a 10 s profile. Reproduce the lag now.' }),
      });
      if (!result.ok) await dialog.showMessageBox({ type: 'warning', message: FAILED[result.reason], detail: result.message });
    } catch (error) {
      ignored('capture a CPU profile', error);
    }
  };
}

module.exports = { createProfileAction };
