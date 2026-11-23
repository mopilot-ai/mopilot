// Linux's explicit Open in actions share editor discovery with agent tools and find the desktop terminal on PATH.
const path = require('node:path');
const { createEditorLauncher, EDITOR_IDS } = require('../platform/editorLauncher.cjs');
const { proc } = require('../platform/ports/proc.cjs');

/** @param {{ which: (name: string) => string | null, exists: (file: string) => boolean,
 *  isDirectory: (file: string) => boolean, run: (cmd: string, args: string[]) => Promise<any>, spawn?: typeof proc.spawn }} o */
function createLinuxDesktop({ which, exists, isDirectory, run, spawn = proc.spawn }) {
  const editors = createEditorLauncher({ platform: 'linux', which, exists, run });
  const terminal = () =>
    ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm'].map((name) => ({ name, file: which(name) })).find((item) => item.file) ??
    null;
  const paths = () => Object.fromEntries([...EDITOR_IDS.map((id) => [id, editors.program(id)]), ['terminal', terminal()?.file ?? null]]);
  return {
    paths,
    installed: () => ({ finder: true, ...Object.fromEntries(Object.entries(paths()).map(([id, file]) => [id, !!file && exists(file)])) }),
    open: async (target, file) => {
      if (EDITOR_IDS.includes(target)) return editors.open(target, file, undefined, undefined);
      if (target !== 'terminal') return { ok: false, stderr: 'This application is not available on Linux.' };
      const app = terminal();
      if (!app?.file) return { ok: false, stderr: 'No desktop terminal was found on PATH.' };
      const program = app.file;
      const cwd = isDirectory(file) ? file : path.dirname(file);
      const args = app.name === 'gnome-terminal' ? ['--working-directory', cwd] : app.name === 'konsole' ? ['--workdir', cwd] : [];
      return new Promise((resolve) => {
        try {
          const child = spawn(program, args, { cwd, detached: true, stdio: 'ignore' });
          child.once('error', (error) => resolve({ ok: false, stderr: error.message }));
          child.once('spawn', () => {
            child.unref();
            resolve({ ok: true });
          });
        } catch (error) {
          resolve({ ok: false, stderr: error.message });
        }
      });
    },
  };
}

module.exports = { createLinuxDesktop };
