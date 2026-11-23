// The PATH the Host's service runs with: the user's login shell's (where Homebrew, nvm and ~/.local/bin put `claude`, `codex` and the ACP agents), not the bare one a non-interactive ssh command gets, plus the folder of the Node the Host runs on.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const MARK = '__MOPILOT_PATH__';
const WAIT_MS = 10_000;

/**
 * What the login shell says PATH is; the given PATH when the shell cannot be asked or says nothing readable.
 * The marker skips whatever the shell's startup files print before it.
 * @param {object} o
 * @param {NodeJS.ProcessEnv} o.env
 * @param {typeof spawnSync} [o.spawn]
 */
export function loginShellPath({ env, spawn = spawnSync }) {
  // an ssh session always sets SHELL to the account's shell
  const shell = env.SHELL;
  if (!shell) return env.PATH ?? '';
  const r = spawn(shell, ['-lic', `echo ${MARK}; printenv PATH`], {
    env,
    encoding: 'utf8',
    timeout: WAIT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const lines = String(r.stdout ?? '').split('\n');
  // a startup file that printed without a newline (a title escape, a banner) leaves the marker at the end of its line
  const at = lines.findLastIndex((l) => l.endsWith(MARK));
  // `echo` ends its line, so a marker always has a line after it (empty when PATH is)
  const found =
    at >= 0
      ? lines
          .slice(at + 1, at + 2)
          .join('')
          .trim()
      : '';
  return r.status === 0 && found ? found : (env.PATH ?? '');
}

/** `dir` added at the end of `pathList` unless it is already in it. @param {string} pathList @param {string} dir */
export function withDir(pathList, dir) {
  const parts = pathList.split(path.delimiter).filter(Boolean);
  return parts.includes(dir) ? parts.join(path.delimiter) : [...parts, dir].join(path.delimiter);
}
