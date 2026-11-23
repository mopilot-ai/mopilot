// The browser a Host falls back to when it has no Chrome or Chromium (package 2.6): chrome-headless-shell, downloaded once into the data dir at a pinned version and checked against a pinned sha256 before anything is unpacked or run.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { extractZip } from './zipExtract.mjs';

/** @typedef {{ version: string, platforms: Record<string, { sha256: string, size: number }> }} Pin */

const BASE = 'https://storage.googleapis.com/chrome-for-testing-public';
/** Chrome for Testing publishes no checksums, so the version, size and sha256 are pinned here; moving to a newer build is a change to this table. */
export const PINNED = /** @type {Pin} */ (
  Object.freeze({
    version: '156.0.8078.73',
    platforms: Object.freeze({
      linux64: { sha256: '77eb8d52798efc7a857ab61abcc62a456d8ea9635b02341d06dffee2761768c8', size: 126_938_225 },
      'linux-arm64': { sha256: '98c084708f0f1fa4ed589ad601cc79b437f0cebe60ffc9794af78a085c01a2a7', size: 126_713_821 },
      'mac-arm64': { sha256: '512c7d34cd5b65d617a39a48915b490eed4208a63e9d47b0fd7893e83be85765', size: 103_949_688 },
      'mac-x64': { sha256: 'be798095cd693357a7a6a0e7a0c4ebd81563e16f51225eb98aacc906d6326519', size: 109_508_986 },
    }),
  })
);

export class ShellError extends Error {
  /** @param {'unsupported_platform' | 'download_failed' | 'bad_download'} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'ShellError';
    this.code = code;
  }
}

/** The pin's platform for this machine, or null where there is no build. @param {NodeJS.Platform} platform @param {string} arch */
export function platformKey(platform, arch) {
  if (platform === 'linux') return arch === 'x64' ? 'linux64' : arch === 'arm64' ? 'linux-arm64' : null;
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : arch === 'x64' ? 'mac-x64' : null;
  return null;
}

/** Where the browser lives once installed. @param {string} dir the folder shells are kept in @param {string} key @param {Pin} [pin] */
export function shellPath(dir, key, pin = PINNED) {
  return path.join(dir, pin.version, `chrome-headless-shell-${key}`, 'chrome-headless-shell');
}

/**
 * The installed browser, or null.
 * @param {{ dir: string, platform?: NodeJS.Platform, arch?: string, pin?: Pin, exists?: (file: string) => boolean }} o
 */
export function installedShell({ dir, platform = process.platform, arch = process.arch, pin = PINNED, exists = fs.existsSync }) {
  const key = platformKey(platform, arch);
  if (!key) return null;
  const file = shellPath(dir, key, pin);
  return exists(file) ? file : null;
}

/**
 * Downloads the pinned build for this machine and unpacks it under `dir`; resolves to the executable. Nothing is unpacked unless the
 * download has the pinned size and sha256, and the version folder appears only when the unpack finished (a second install is harmless).
 * @param {{ dir: string, platform?: NodeJS.Platform, arch?: string, pin?: Pin, fetchImpl?: typeof fetch, extract?: typeof extractZip }} o
 */
export async function installHeadlessShell({
  dir,
  platform = process.platform,
  arch = process.arch,
  pin = PINNED,
  fetchImpl = fetch,
  extract = extractZip,
}) {
  const key = platformKey(platform, arch);
  if (!key)
    throw new ShellError('unsupported_platform', `There is no headless browser build for ${platform}/${arch}. Install Chrome or Chromium.`);
  const want = pin.platforms[key];
  const final = path.join(dir, pin.version);
  const exe = shellPath(dir, key, pin);
  if (fs.existsSync(exe)) return exe;
  const work = path.join(dir, `.install-${process.pid}-${Date.now()}`);
  await fs.promises.mkdir(work, { recursive: true });
  try {
    const zip = path.join(work, 'shell.zip');
    let res;
    try {
      res = await fetchImpl(`${BASE}/${pin.version}/${key}/chrome-headless-shell-${key}.zip`, { redirect: 'follow' });
    } catch (e) {
      throw new ShellError('download_failed', `Could not download the headless browser: ${/** @type {Error} */ (e).message}`);
    }
    if (!res.ok || !res.body)
      throw new ShellError('download_failed', `Could not download the headless browser: the server answered ${res.status}.`);
    const hash = createHash('sha256');
    let bytes = 0;
    await pipeline(
      Readable.fromWeb(/** @type {any} */ (res.body)),
      async function* (/** @type {AsyncIterable<Buffer>} */ chunks) {
        for await (const c of chunks) {
          bytes += c.length;
          // more than pinned is wrong however it hashes: stop before it fills the disk
          if (bytes > want.size) throw new ShellError('bad_download', 'The headless browser download is larger than expected.');
          hash.update(c);
          yield c;
        }
      },
      fs.createWriteStream(zip),
    ).catch((e) => {
      if (e instanceof ShellError) throw e;
      throw new ShellError('download_failed', `Could not download the headless browser: ${e.message}`);
    });
    if (bytes !== want.size || hash.digest('hex') !== want.sha256)
      throw new ShellError('bad_download', 'The headless browser download is not the one this Host expects, so it was not unpacked.');
    const out = path.join(work, 'out');
    await extract(zip, out);
    try {
      await fs.promises.rename(out, final);
    } catch (e) {
      // another install finished first: its browser is as good as this one
      if (!fs.existsSync(exe)) throw e;
    }
    return exe;
  } finally {
    await fs.promises.rm(work, { recursive: true, force: true });
  }
}
