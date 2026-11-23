// Commands main runs for windows: an execFile that resolves with its output, and "Open in" on Windows.
const { proc } = require('../platform/ports/proc.cjs');
const path = require('node:path');
const { fs } = require('../platform/ports/fs.cjs');
const os = require('node:os');
const shellEnv = require('../platform/env.cjs');

/**
 * Runs `cmd` (git, gh, ...) with the login shell's environment: an app opened from the Dock or Finder has launchd's
 * PATH (/usr/bin:/bin:/usr/sbin:/sbin), where a Homebrew gh is not, so PR status and the PR monitor found no gh (#1580).
 * `opts.env` still wins.
 */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    // windowsHide: no console window flashing up for each git call on Windows
    proc.execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: shellEnv.gitEnv(), ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/* "Open in" on Windows: the first installed copy of each app (per-user installs first). */
const winExists = (p) => {
  try {
    // WindowsApps aliases (wt.exe) are reparse points that stat can't follow
    return fs.existsSync(p) || !!fs.lstatSync(p);
  } catch {
    return false;
  }
};

/**
 * @param {import('../main.cjs').CommandsDeps} deps what main.cjs passes in
 */
function createCommands({ shell, isWin }) {
  const WIN_APP_PATHS = (() => {
    if (!isWin) return {};
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const win = process.env.SystemRoot || 'C:\\Windows';
    const pick = (...c) => c.find(winExists) || c[0];
    return {
      finder: path.join(win, 'explorer.exe'),
      vscode: pick(path.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'), path.join(pf, 'Microsoft VS Code', 'Code.exe')),
      cursor: pick(path.join(local, 'Programs', 'cursor', 'Cursor.exe'), path.join(pf, 'Cursor', 'Cursor.exe')),
      zed: pick(path.join(local, 'Programs', 'Zed', 'zed.exe'), path.join(pf, 'Zed', 'zed.exe')),
      terminal: path.join(local, 'Microsoft', 'WindowsApps', 'wt.exe'),
    };
  })();
  function openInWindows(target, p) {
    const detach = (cmd, args, opts = {}) =>
      new Promise((resolve) => {
        try {
          const c = proc.spawn(cmd, args, { detached: true, stdio: 'ignore', ...opts });
          c.on('error', (err) => resolve({ ok: false, code: 1, stdout: '', stderr: String(err.message) }));
          c.on('spawn', () => (c.unref(), resolve({ ok: true, code: 0, stdout: '', stderr: '' })));
        } catch (err) {
          resolve({ ok: false, code: 1, stdout: '', stderr: String(err.message) });
        }
      });
    const dir = fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : path.dirname(p);
    if (target === 'terminal' || target === 'iterm') {
      // Windows Terminal when it's there; otherwise PowerShell in its own console window
      if (winExists(WIN_APP_PATHS.terminal)) return detach(WIN_APP_PATHS.terminal, ['-d', dir]);
      return detach('powershell.exe', ['-NoExit'], { cwd: dir });
    }
    const exe = WIN_APP_PATHS[target];
    if (!exe || !winExists(exe)) return shell.openPath(p).then((err) => ({ ok: !err, code: err ? 1 : 0, stdout: '', stderr: err }));
    return detach(exe, [p]);
  }
  return { run, winExists, WIN_APP_PATHS, openInWindows };
}

module.exports = { createCommands, run };
