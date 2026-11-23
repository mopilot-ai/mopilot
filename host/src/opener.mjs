// What opens a page for a process the Host starts (#3368): never a browser on this machine's own screen. Every agent, CLI and sign-in the Host runs gets an opener folder first on its PATH (`open`, `xdg-open` and the like) and `BROWSER` pointed at it; the opener only writes the link to a file in the Host's data dir, from which a sign-in under way relays it to the app, which opens it in the person's own browser.
import fs from 'node:fs';
import path from 'node:path';

/** The commands tools reach for to open a page: macOS `open`, the freedesktop and Debian ones, WSL's. */
export const OPENER_NAMES = Object.freeze([
  'open',
  'xdg-open',
  'x-www-browser',
  'www-browser',
  'sensible-browser',
  'gnome-open',
  'wslview',
]);
/** The env name the opener writes to. */
export const OPENED_ENV = 'MOPILOT_HOST_OPENED';

/** A POSIX shell opener: each http(s) argument becomes a line of the file `$MOPILOT_HOST_OPENED` names; nothing is opened here. */
export const OPENER_SCRIPT = `#!/bin/sh
# MoPilot Host: a page asked for on this machine goes to the app, never to this machine's screen
[ -n "$${OPENED_ENV}" ] || exit 0
for a in "$@"; do
  case "$a" in http://*|https://*) printf '%s\\n' "$a" >> "$${OPENED_ENV}" ;; esac
done
exit 0
`;

/**
 * @param {{ dataDir: string }} o
 */
export function createOpener({ dataDir }) {
  const dir = path.join(dataDir, 'opener');
  const file = path.join(dataDir, 'opened.links');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of OPENER_NAMES) fs.writeFileSync(path.join(dir, name), OPENER_SCRIPT, { mode: 0o700 });
  // a link may carry a sign-in's one-time state: the file is the user's alone, and starts empty with each Host
  fs.writeFileSync(file, '', { mode: 0o600 });
  return {
    dir,
    /**
     * The environment every process the Host starts runs in: the opener first on PATH, BROWSER at it, and where it writes.
     * @param {NodeJS.ProcessEnv} env
     * @returns {NodeJS.ProcessEnv}
     */
    env: (env) => ({
      ...env,
      PATH: env.PATH ? `${dir}${path.delimiter}${env.PATH}` : dir,
      BROWSER: path.join(dir, 'open'),
      [OPENED_ENV]: file,
    }),
    /** The links written since the last call, and the file emptied (a sign-in under way relays them). @returns {string[]} */
    take() {
      // moved aside first, so a line the opener writes meanwhile lands in the new file, never lost between a read and an emptying
      const taking = `${file}.taking`;
      try {
        fs.renameSync(file, taking);
      } catch {
        // removed under the Host: nothing was asked to open since
        return [];
      }
      fs.closeSync(fs.openSync(file, 'a', 0o600));
      const text = fs.readFileSync(taking, 'utf8');
      fs.rmSync(taking, { force: true });
      return text.split('\n').filter(Boolean);
    },
  };
}

/**
 * `env` with the opener of `from` (the Host's env), for a process whose env was built elsewhere (the Agent SDK builds Claude Code's from this
 * process's own): the opener's PATH, BROWSER and file win. `env` as it is when `from` has no opener.
 * @param {NodeJS.ProcessEnv} from @param {NodeJS.ProcessEnv | undefined} env
 * @returns {NodeJS.ProcessEnv | undefined}
 */
export const withOpener = (from, env) =>
  from[OPENED_ENV] ? { ...env, PATH: from.PATH, BROWSER: from.BROWSER, [OPENED_ENV]: from[OPENED_ENV] } : env;
