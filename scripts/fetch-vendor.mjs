// Fetches the pinned third-party programs the app ships (today: ripgrep) from their official release
// pages, checks each archive against a SHA-256 pinned below, and unpacks the program for one platform
// and arch. Nothing unverified is ever unpacked, and a mismatch deletes the download.
//
//   node scripts/fetch-vendor.mjs [--platform darwin|win32|linux] [--arch arm64|x64] [--out <dir>] [--from <dir>]
//
// --out   where the program and its licenses go (default build/vendor/<platform>-<arch>/ripgrep)
// --from  a folder that already holds the archive (offline builds, tests); it is still verified
//
// To move to a newer ripgrep: change VERSION, download each archive and its .sha256 from
// https://github.com/BurntSushi/ripgrep/releases, compare the published checksum with your own
// `shasum -a 256`, and paste the values below.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { flagValue } from './argv.mjs';

export const RIPGREP_VERSION = '15.2.0';
const BASE = `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}`;

/** platform-arch -> release asset and its SHA-256 (the .sha256 file beside the asset says the same). */
export const RIPGREP = {
  'darwin-arm64': {
    asset: `ripgrep-${RIPGREP_VERSION}-aarch64-apple-darwin.tar.gz`,
    sha256: '3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4',
  },
  'darwin-x64': {
    asset: `ripgrep-${RIPGREP_VERSION}-x86_64-apple-darwin.tar.gz`,
    sha256: 'af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1',
  },
  'win32-x64': {
    asset: `ripgrep-${RIPGREP_VERSION}-x86_64-pc-windows-msvc.zip`,
    sha256: '71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5',
  },
  'win32-arm64': {
    asset: `ripgrep-${RIPGREP_VERSION}-aarch64-pc-windows-msvc.zip`,
    sha256: 'e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f',
  },
  'linux-x64': {
    asset: `ripgrep-${RIPGREP_VERSION}-x86_64-unknown-linux-musl.tar.gz`,
    sha256: '33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c',
  },
  'linux-arm64': {
    asset: `ripgrep-${RIPGREP_VERSION}-aarch64-unknown-linux-musl.tar.gz`,
    sha256: '800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915',
  },
};
const LICENSES = ['COPYING', 'LICENSE-MIT', 'UNLICENSE'];

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Throws unless `buf` is the archive pinned for `target`. */
export function verifyArchive(target, buf) {
  const pin = RIPGREP[target];
  if (!pin) throw new Error(`No ripgrep ${RIPGREP_VERSION} is pinned for ${target}`);
  const got = sha256(buf);
  if (got !== pin.sha256) throw new Error(`${pin.asset}: SHA-256 is ${got}, expected ${pin.sha256}`);
}

/**
 * Put ripgrep (rg or rg.exe, and its license files) for `platform`/`arch` into `out`.
 * @param {object} o
 * @param o.platform a Node platform name
 * @param o.arch a Node arch name
 * @param o.out the folder rg goes into
 * @param [o.from] a folder with the archive already in it; otherwise it is downloaded
 * @param [o.download] (url) => Promise<Buffer>; replaceable in tests
 * @param [o.host] the platform this runs on (process.platform)
 * @returns the path of the rg binary
 */
export async function fetchRipgrep({ platform, arch, out, from, download = defaultDownload, host = process.platform }) {
  const target = `${platform}-${arch}`;
  const pin = RIPGREP[target];
  if (!pin) throw new Error(`No ripgrep ${RIPGREP_VERSION} is pinned for ${target}`);
  const exe = platform === 'win32' ? 'rg.exe' : 'rg';
  const dest = path.join(out, exe);
  const marker = path.join(out, '.version');
  if (existsSync(dest) && existsSync(marker) && readFileSync(marker, 'utf8').trim() === `${RIPGREP_VERSION} ${pin.sha256}`) return dest;

  const buf = from ? readFileSync(path.join(from, pin.asset)) : await download(`${BASE}/${pin.asset}`);
  verifyArchive(target, buf);

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'rg-vendor-'));
  try {
    const archive = path.join(tmp, pin.asset);
    writeFileSync(archive, buf);
    // bsdtar (macOS, Windows 10+) reads both formats; Linux's GNU tar has no zip support, so the Windows
    // build on a Linux release runner unzips
    if (host === 'linux' && archive.endsWith('.zip')) execFileSync('unzip', ['-q', archive, '-d', tmp]);
    else execFileSync('tar', ['-xf', archive, '-C', tmp]);
    const inner = path.join(tmp, pin.asset.replace(/\.(tar\.gz|zip)$/, ''));
    mkdirSync(out, { recursive: true });
    copyFileSync(path.join(inner, exe), dest);
    for (const l of LICENSES) if (existsSync(path.join(inner, l))) copyFileSync(path.join(inner, l), path.join(out, l));
    if (platform !== 'win32') chmodSync(dest, 0o755);
    writeFileSync(marker, `${RIPGREP_VERSION} ${pin.sha256}\n`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return dest;
}

/** Downloads `url` (following redirects) into a Buffer; throws on an HTTP error. */
export async function defaultDownload(url, fetchImpl = fetch) {
  const res = await fetchImpl(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** The command line (see the top of this file); returns the rg path. */
export async function main(
  argv,
  { fetch: fetchRg = fetchRipgrep, platform: hostPlatform = process.platform, arch: hostArch = process.arch, log = console.log } = {},
) {
  const platform = flagValue(argv, 'platform') || hostPlatform;
  const arch = flagValue(argv, 'arch') || hostArch;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const out = path.resolve(flagValue(argv, 'out') || path.join(root, 'build', 'vendor', `${platform}-${arch}`, 'ripgrep'));
  const bin = await fetchRg({ platform, arch, out, from: flagValue(argv, 'from') });
  log(`ripgrep ${RIPGREP_VERSION} (${platform}-${arch}) verified: ${bin}`);
  return bin;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}
