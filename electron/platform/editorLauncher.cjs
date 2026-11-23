// Code editors an agent can hand the user a file in (open_in_editor): which of VS Code, Cursor, Windsurf and Zed are
// installed, and opening a file in one, at a line and column when the editor's command line is there. The same apps
// "Open in" offers (electron/app/ipc/window.cjs); `open -a` is the fallback on macOS when only the app is found.
const path = require('node:path');
const { noteIgnored } = require('../ignored.cjs');

/** @type {Record<string, { label: string, app: string, bundle: string, cli: string[], goto: boolean }>} */
const EDITORS = {
  vscode: {
    label: 'VS Code',
    app: 'Visual Studio Code',
    bundle: '/Applications/Visual Studio Code.app',
    cli: ['Contents', 'Resources', 'app', 'bin', 'code'],
    goto: true,
  },
  cursor: {
    label: 'Cursor',
    app: 'Cursor',
    bundle: '/Applications/Cursor.app',
    cli: ['Contents', 'Resources', 'app', 'bin', 'cursor'],
    goto: true,
  },
  windsurf: {
    label: 'Windsurf',
    app: 'Windsurf',
    bundle: '/Applications/Windsurf.app',
    cli: ['Contents', 'Resources', 'app', 'bin', 'windsurf'],
    goto: true,
  },
  zed: { label: 'Zed', app: 'Zed', bundle: '/Applications/Zed.app', cli: ['Contents', 'MacOS', 'cli'], goto: false },
};
const IDS = Object.keys(EDITORS);

/**
 * @param {object} o
 * @param {string} o.platform process.platform
 * @param {(p: string) => boolean} o.exists
 * @param {(cmd: string, args: string[]) => Promise<{ ok: boolean, stderr: string }>} o.run
 * @param {Record<string, string | undefined>} [o.winPaths] the editors' programs on Windows (electron/app/commands.cjs WIN_APP_PATHS)
 * @param {(name: string) => string | null} [o.which] an executable on the login-shell PATH (Linux)
 */
function createEditorLauncher({ platform, exists, run, winPaths = {}, which = (name) => require('./env.cjs').which(name) }) {
  /** The editor's program: its command line on macOS, its executable on Windows, else null. */
  const programOf = (/** @type {string} */ id) => {
    if (!Object.hasOwn(EDITORS, id)) return null;
    if (platform === 'win32') return winPaths[id] ?? null;
    if (platform === 'linux') return which({ vscode: 'code', cursor: 'cursor', windsurf: 'windsurf', zed: 'zed' }[id]);
    return platform === 'darwin' ? path.join(EDITORS[id].bundle, ...EDITORS[id].cli) : null;
  };
  const installed = () =>
    IDS.filter((id) =>
      platform === 'linux'
        ? !!programOf(id)
        : platform === 'win32'
          ? !!winPaths[id] && exists(winPaths[id])
          : platform === 'darwin' && exists(EDITORS[id].bundle),
    );
  /** Opens `file` in `id`; {ok:false, error} when the editor did not start. */
  const open = async (
    /** @type {string} */ id,
    /** @type {string} */ file,
    /** @type {number | undefined} */ line,
    /** @type {number | undefined} */ column,
  ) => {
    if (!Object.hasOwn(EDITORS, id)) return { ok: false };
    const spot = line === undefined ? file : `${file}:${line}${column === undefined ? '' : `:${column}`}`;
    const program = programOf(id);
    const direct = program && exists(program);
    // VS Code's family takes --goto path:line:col, Zed takes path:line:col; both open the bare path without a line
    const args = line === undefined ? [file] : EDITORS[id].goto ? ['--goto', spot] : [spot];
    const r = direct
      ? await run(program, args)
      : platform === 'darwin'
        ? await run('open', ['-a', EDITORS[id].app, file])
        : { ok: false, stderr: 'not installed' };
    if (r.ok) return { ok: true };
    // what the program said is for the log; the model is told only that it did not start
    noteIgnored(`open a file in ${EDITORS[id].label}`, new Error(r.stderr.trim() || 'did not start'));
    return { ok: false };
  };
  return { installed, open, program: programOf, label: (/** @type {string} */ id) => EDITORS[id]?.label ?? id };
}

module.exports = { createEditorLauncher, EDITOR_IDS: IDS };
