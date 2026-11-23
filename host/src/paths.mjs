// Where a Host keeps its files: one data dir per Host, with the socket and lock derived from it so two Hosts never share either.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A unix socket path must fit sockaddr_un (104 bytes on macOS, 108 on Linux). */
const MAX_SOCKET_PATH = 100;

/**
 * @param {{ dataDir?: string, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, home?: string, tmp?: string, uid?: number }} [o]
 * @returns {{ dataDir: string, configDir: string, socketPath: string, lockPath: string }}
 */
export function createPaths({
  dataDir,
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
  tmp = os.tmpdir(),
  uid = /** @type {() => number} */ (process.getuid)(),
} = {}) {
  const fallbackData =
    platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'mopilot-host')
      : path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'mopilot-host');
  const data = path.resolve(dataDir || env.MOPILOT_HOST_DATA || fallbackData);
  // The default Host and the same folder spelled out are one Host: the installed unit starts the server with --data-dir <the default>,
  // while `pair`, `status` and `login` typed later give no flag, and the code they print must be the one the server checks. Only another
  // folder has a config of its own, inside it, so two Hosts never share a key or a pairing.
  const configDir =
    data === path.resolve(fallbackData)
      ? path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'mopilot-host')
      : path.join(data, 'config');
  const direct = path.join(data, 'host.sock');
  // a deep data dir would overflow sockaddr_un: key the short path on the data dir so another dir gets another socket, in a folder of this user's own (a name in a shared temp folder is one another user can take first: see `ensureSocketDir`)
  const socketPath =
    direct.length <= MAX_SOCKET_PATH
      ? direct
      : path.join(
          env.XDG_RUNTIME_DIR || tmp,
          `mopilot-host-${uid}`,
          `${createHash('sha256').update(data).digest('hex').slice(0, 12)}.sock`,
        );
  return { dataDir: data, configDir, socketPath, lockPath: path.join(data, 'host.lock') };
}

/**
 * Makes the folder a Host's socket is in, owner-only; a folder that is there already must be a real folder of this user's, closed to others. A name another user made first (a link, their folder, an open one) is refused: a socket in it could be taken or listened on by them.
 * @param {string} dir @param {{ uid?: number, fsApi?: Pick<typeof fs, 'lstatSync' | 'mkdirSync'> }} [o]
 */
export function ensureSocketDir(dir, { uid = /** @type {() => number} */ (process.getuid)(), fsApi = fs } = {}) {
  /** @type {import('node:fs').Stats | null} */
  let stat = null;
  try {
    stat = fsApi.lstatSync(dir);
  } catch (e) {
    if (/** @type {any} */ (e).code !== 'ENOENT') throw e;
  }
  if (!stat) {
    fsApi.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return;
  }
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0)
    throw new Error(
      `${dir} is not a private folder of this user's (a socket in it could be taken by another user); remove it, or give the Host a shorter --data-dir.`,
    );
}
