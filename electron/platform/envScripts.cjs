// A project's environment scripts: running a setup or cleanup script through a pty.
const pty = require('./pty.cjs');

const SCRIPT_TIMEOUT_MS = 15 * 60_000;
const OUTPUT_TAIL = 4000;

/** Run a setup or cleanup script in the user's login shell through a pty; resolves with its exit code and output tail. */
function runScript(cwd, script, opts = {}) {
  return new Promise((resolve) => {
    const id = `script:${Date.now().toString(36)}:${Math.random().toString(16).slice(2, 8)}`;
    let out = '';
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    // Windows: the script is PowerShell (environment.toml's win32 entry, else the shared one)
    const command =
      process.platform === 'win32'
        ? ['powershell.exe', '-NoLogo', '-NoProfile', '-Command', String(script)]
        : [pty.loginShell(), '-lc', String(script)];
    try {
      pty.spawn(
        id,
        { command, cwd, cols: 200, rows: 50, selfAnswer: true },
        {
          onData: (d) => (out = (out + d).slice(-OUTPUT_TAIL)),
          onExit: ({ exitCode, killed }) => {
            clearTimeout(timer);
            resolve({ exitCode: killed ? 124 : exitCode, output: out });
          },
        },
      );
    } catch (err) {
      return resolve({ exitCode: 127, output: String((err && err.message) || err) });
    }
    timer = setTimeout(() => pty.kill(id), opts.timeoutMs ?? SCRIPT_TIMEOUT_MS);
  });
}

function register(ipcMain) {
  ipcMain.handle('env:runScript', (_e, cwd, script) => runScript(cwd, script));
}

module.exports = { register, runScript };
